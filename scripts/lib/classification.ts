import type { CapabilityId, OperationRecord, RiskTier, ToolAnnotations } from "./census.ts";
import { deriveCodecs, deriveDescription } from "./codecs.ts";
import type { OpenAPIDocument, ParameterObject, ResolvedOperation } from "./openapi-document.ts";
import { collectParameters, deriveApiVersion, primaryTag } from "./openapi-document.ts";
import type { ClassificationRules, OperationOverride } from "./overrides.ts";
import { buildTagIndex } from "./overrides.ts";
import { detectTwins } from "./twins.ts";

function hasParameterNamed(parameters: ParameterObject[], name: string): boolean {
  return parameters.some((parameter) => parameter.name === name);
}

/**
 * Derive the exclusive write risk tier (GET → read).
 */
export function deriveRiskTier(
  resolved: ResolvedOperation,
  tag: string,
  rules: ClassificationRules,
): RiskTier {
  if (resolved.method === "get") {
    return "read";
  }
  if (rules.binaryIoOperationIds.includes(resolved.operationId)) {
    return "binary-io";
  }
  if (rules.adminTags.includes(tag) || rules.adminOperationIds.includes(resolved.operationId)) {
    return "admin";
  }
  if (rules.financialTags.includes(tag)) {
    return "financial";
  }
  if (resolved.method === "delete") {
    return "destructive";
  }
  for (const substring of rules.destructiveOperationIdSubstrings) {
    if (resolved.operationId.includes(substring)) {
      return "destructive";
    }
  }
  return "ordinary";
}

/**
 * Derive conjunctive capability requirements independently of (but including) tier gates.
 */
export function deriveCapabilities(
  resolved: ResolvedOperation,
  tag: string,
  riskTier: RiskTier,
  rules: ClassificationRules,
  hasOctetStreamResponse: boolean,
  hasImpersonationParameter: boolean,
): CapabilityId[] {
  const capabilities = new Set<CapabilityId>();

  if (riskTier === "destructive") {
    capabilities.add("destructive");
  }
  if (riskTier === "financial") {
    capabilities.add("financial");
  }
  if (riskTier === "admin") {
    capabilities.add("admin");
  }

  if (
    rules.binaryIoCapabilityOperationIds.includes(resolved.operationId) ||
    rules.binaryIoCapabilityOperationIdPrefixes.some((prefix) =>
      resolved.operationId.startsWith(prefix),
    ) ||
    hasOctetStreamResponse
  ) {
    capabilities.add("binary-io");
  }

  if (tag === rules.bulkExportTag) {
    capabilities.add("bulk-export");
  }

  if (hasImpersonationParameter) {
    capabilities.add("impersonation");
  }

  const order: CapabilityId[] = [
    "destructive",
    "financial",
    "admin",
    "binary-io",
    "bulk-export",
    "impersonation",
  ];
  return order.filter((capability) => capabilities.has(capability));
}

export function deriveAnnotations(method: string, riskTier: RiskTier): ToolAnnotations {
  const isGet = method === "get";
  return {
    openWorldHint: true,
    readOnlyHint: isGet,
    destructiveHint: riskTier === "destructive" || riskTier === "financial",
    idempotentHint: isGet ? true : false,
  };
}

function applyOverride(
  record: OperationRecord,
  override: OperationOverride | undefined,
): OperationRecord {
  if (!override) {
    return record;
  }
  if (override.riskTier !== undefined) {
    if (record.method === "get" && override.riskTier !== "read") {
      throw new Error(`operations.yaml must not change GET versus write for ${record.operationId}`);
    }
    if (record.method !== "get" && override.riskTier === "read") {
      throw new Error(`operations.yaml must not change GET versus write for ${record.operationId}`);
    }
    record = { ...record, riskTier: override.riskTier };
  }
  if (override.capabilities !== undefined) {
    record = { ...record, capabilities: [...override.capabilities] };
  }
  if (override.inputCodec !== undefined) {
    record = { ...record, inputCodec: override.inputCodec };
  }
  if (override.outputCodec !== undefined) {
    record = { ...record, outputCodec: override.outputCodec };
  }
  if (override.description !== undefined) {
    record = { ...record, description: override.description };
  }
  if (override.annotations !== undefined) {
    record = {
      ...record,
      annotations: { ...record.annotations, ...override.annotations },
    };
  }
  // Re-derive tier capability membership when riskTier was overridden without capabilities.
  if (override.riskTier !== undefined && override.capabilities === undefined) {
    const capabilities = new Set(record.capabilities);
    for (const tierCap of ["destructive", "financial", "admin"] as const) {
      capabilities.delete(tierCap);
    }
    if (record.riskTier === "destructive") {
      capabilities.add("destructive");
    }
    if (record.riskTier === "financial") {
      capabilities.add("financial");
    }
    if (record.riskTier === "admin") {
      capabilities.add("admin");
    }
    const order: CapabilityId[] = [
      "destructive",
      "financial",
      "admin",
      "binary-io",
      "bulk-export",
      "impersonation",
    ];
    record = {
      ...record,
      capabilities: order.filter((capability) => capabilities.has(capability)),
      annotations: deriveAnnotations(record.method, record.riskTier),
    };
  }
  return record;
}

export interface ClassifyOptions {
  document: OpenAPIDocument;
  operations: ResolvedOperation[];
  rules: ClassificationRules;
  overrides: Record<string, OperationOverride>;
  toolNames: Map<string, string>;
}

export interface ClassifyResult {
  records: OperationRecord[];
  twinPairCount: number;
  v2OnlyOperationIds: string[];
  tagIndex: Map<string, string>;
}

/**
 * Classify every OpenAPI operation into a full policy manifest record.
 *
 * Raises:
 *   Error: On unmapped tags, unknown override ids, or missing tool names.
 */
export function classifyOperations(options: ClassifyOptions): ClassifyResult {
  const { document, operations, rules, overrides, toolNames } = options;
  const tagIndex = buildTagIndex(rules);
  const twins = detectTwins(operations);

  const knownOperationIds = new Set(operations.map((operation) => operation.operationId));
  for (const operationId of Object.keys(overrides)) {
    if (!knownOperationIds.has(operationId)) {
      throw new Error(
        `operations.yaml references unknown operationId ${JSON.stringify(operationId)}`,
      );
    }
  }

  const records: OperationRecord[] = [];
  for (const resolved of operations) {
    const tag = primaryTag(resolved.tags);
    const primaryToolset = tagIndex.get(tag);
    if (primaryToolset === undefined) {
      throw new Error(
        `Unmapped OpenAPI tag ${JSON.stringify(tag)} for operation ${resolved.operationId}`,
      );
    }

    const toolName = toolNames.get(resolved.operationId);
    if (toolName === undefined) {
      throw new Error(`Missing toolName for ${resolved.operationId}`);
    }

    const parameters = collectParameters(document, resolved.pathItem, resolved.operation);
    const hasImpersonation = hasParameterNamed(parameters, rules.impersonationParameterName);
    const codecs = deriveCodecs(document, resolved);
    const riskTier = deriveRiskTier(resolved, tag, rules);
    const capabilities = deriveCapabilities(
      resolved,
      tag,
      riskTier,
      rules,
      codecs.hasOctetStreamResponse,
      hasImpersonation,
    );

    let record: OperationRecord = {
      operationId: resolved.operationId,
      toolName,
      method: resolved.method,
      path: resolved.path,
      apiVersion: deriveApiVersion(resolved.path, resolved.tags),
      twinOperationId: twins.twinByOperationId.get(resolved.operationId) ?? null,
      tag,
      primaryToolset,
      riskTier,
      capabilities,
      inputCodec: codecs.inputCodec,
      outputCodec: codecs.outputCodec,
      annotations: deriveAnnotations(resolved.method, riskTier),
      description: deriveDescription(resolved),
    };

    record = applyOverride(record, overrides[resolved.operationId]);
    records.push(record);
  }

  return {
    records,
    twinPairCount: twins.pairCount,
    v2OnlyOperationIds: twins.v2OnlyOperationIds,
    tagIndex,
  };
}
