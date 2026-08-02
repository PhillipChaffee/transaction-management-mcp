import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TOOLSET_IDS, DEFAULT_TOOLSET_IDS } from "../src/config/toolsets.ts";
import type { AbbreviationRecord } from "./naming.ts";
import { TOOL_NAME_REGEX, computeToolName } from "./naming.ts";
import type {
  CapabilityId,
  CodecId,
  OperationRecord,
  OperationsManifest,
  RiskTier,
} from "./lib/census.ts";
import {
  EXPECTED_CENSUS,
  EXPECTED_DEFAULT_READS_AFTER_CAPABILITIES,
  EXPECTED_DEFAULT_READS_BEFORE_CAPABILITIES,
  EXPECTED_TWIN_PAIRS,
  EXPECTED_V2_ONLY,
  EXPECTED_WRITE_TIERS,
  HTTP_METHODS,
  censusMatches,
  countCensus,
  countWriteTiers,
  formatCensus,
} from "./lib/census.ts";
import { buildTagIndex, loadClassificationRules } from "./lib/overrides.ts";
import { detectTwins } from "./lib/twins.ts";
import type { ResolvedOperation } from "./lib/openapi-document.ts";

const MANIFEST_FIELDS = [
  "annotations",
  "apiVersion",
  "capabilities",
  "description",
  "inputCodec",
  "method",
  "operationId",
  "outputCodec",
  "path",
  "primaryToolset",
  "riskTier",
  "tag",
  "toolName",
  "twinOperationId",
] as const;

const RISK_TIERS: readonly RiskTier[] = [
  "read",
  "ordinary",
  "destructive",
  "financial",
  "admin",
  "binary-io",
];

const CAPABILITIES: readonly CapabilityId[] = [
  "destructive",
  "financial",
  "admin",
  "binary-io",
  "bulk-export",
  "impersonation",
];

const CODECS: readonly CodecId[] = [
  "base64-upload",
  "cda",
  "bulk-stream",
  "replica-timestamp",
  "octet-stream",
  "no-content",
  "query-write",
  "no-body-write",
  "open-body",
  "empty-value",
  "json",
];

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertOperationShape(operation: OperationRecord, index: number): void {
  const keys = Object.keys(operation).sort();
  assert(
    keys.length === MANIFEST_FIELDS.length &&
      MANIFEST_FIELDS.every((field) => keys.includes(field)),
    `operations[${index}] must contain exactly policy fields ${MANIFEST_FIELDS.join(", ")}; got ${keys.join(", ")}`,
  );
  assert(
    typeof operation.operationId === "string" && operation.operationId.length > 0,
    "operationId",
  );
  assert(
    typeof operation.toolName === "string" && TOOL_NAME_REGEX.test(operation.toolName),
    "toolName",
  );
  assert(
    (HTTP_METHODS as readonly string[]).includes(operation.method),
    `invalid method ${operation.method}`,
  );
  assert(typeof operation.path === "string" && operation.path.startsWith("/"), "path");
  assert(operation.apiVersion === "v1" || operation.apiVersion === "v2", "apiVersion");
  assert(
    operation.twinOperationId === null || typeof operation.twinOperationId === "string",
    "twinOperationId",
  );
  assert(typeof operation.tag === "string" && operation.tag.length > 0, "tag");
  assert(
    (TOOLSET_IDS as readonly string[]).includes(operation.primaryToolset),
    `primaryToolset ${operation.primaryToolset}`,
  );
  assert((RISK_TIERS as readonly string[]).includes(operation.riskTier), "riskTier");
  assert(Array.isArray(operation.capabilities), "capabilities");
  for (const capability of operation.capabilities) {
    assert((CAPABILITIES as readonly string[]).includes(capability), `capability ${capability}`);
  }
  assert((CODECS as readonly string[]).includes(operation.inputCodec), "inputCodec");
  assert((CODECS as readonly string[]).includes(operation.outputCodec), "outputCodec");
  assert(
    typeof operation.description === "string" && operation.description.length > 0,
    "description",
  );
  assert(
    typeof operation.annotations === "object" && operation.annotations !== null,
    "annotations",
  );
  assert(operation.annotations.openWorldHint === true, "openWorldHint");
  assert(typeof operation.annotations.readOnlyHint === "boolean", "readOnlyHint");
  assert(typeof operation.annotations.destructiveHint === "boolean", "destructiveHint");
  assert(typeof operation.annotations.idempotentHint === "boolean", "idempotentHint");
  assert(
    !("defaultEnabled" in operation),
    "manifest must not include defaultEnabled; derive from DEFAULT_TOOLSET_IDS",
  );
}

/**
 * Verify the pinned full policy manifest against Commit 3 invariants.
 */
export async function verifyManifest(
  manifestPath = path.join(repoRoot(), "src/generated/operations.manifest.json"),
  pinPath = path.join(repoRoot(), "openapi.sha256"),
  abbreviationsPath = path.join(repoRoot(), "src/generated/tool-name-abbreviations.json"),
): Promise<OperationsManifest> {
  const pin = (await readFile(pinPath, "utf8")).trim();
  assert(/^[a-f0-9]{64}$/.test(pin), `Invalid openapi.sha256 contents: ${pin}`);

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as OperationsManifest;
  assert(manifest.openapiSha256 === pin, "manifest.openapiSha256 does not match openapi.sha256");
  assert(Array.isArray(manifest.operations), "manifest.operations must be an array");

  const rules = await loadClassificationRules();
  const tagIndex = buildTagIndex(rules);
  assert(
    JSON.stringify([...DEFAULT_TOOLSET_IDS]) === JSON.stringify(rules.defaultToolsetIds),
    "DEFAULT_TOOLSET_IDS must match classification-rules.yaml defaultToolsetIds",
  );

  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const toolsetCounts = new Map<string, number>();
  for (const id of TOOLSET_IDS) {
    toolsetCounts.set(id, 0);
  }

  for (const [index, operation] of manifest.operations.entries()) {
    assertOperationShape(operation, index);
    assert(!seenIds.has(operation.operationId), `duplicate operationId ${operation.operationId}`);
    seenIds.add(operation.operationId);
    assert(!seenNames.has(operation.toolName), `duplicate toolName ${operation.toolName}`);
    seenNames.add(operation.toolName);

    assert(
      computeToolName(operation.operationId) === operation.toolName,
      `toolName regeneration mismatch for ${operation.operationId}: baked=${operation.toolName} recomputed=${computeToolName(operation.operationId)}`,
    );

    const expectedToolset = tagIndex.get(operation.tag);
    assert(
      expectedToolset === operation.primaryToolset,
      `tag ${operation.tag} mapped to ${expectedToolset}, manifest has ${operation.primaryToolset}`,
    );
    toolsetCounts.set(
      operation.primaryToolset,
      (toolsetCounts.get(operation.primaryToolset) ?? 0) + 1,
    );

    if (operation.method === "get") {
      assert(operation.riskTier === "read", `${operation.operationId} GET must be read`);
      assert(operation.annotations.readOnlyHint === true, "GET readOnlyHint");
      assert(operation.annotations.idempotentHint === true, "GET idempotentHint");
    } else {
      assert(operation.riskTier !== "read", `${operation.operationId} write must not be read`);
      assert(operation.annotations.readOnlyHint === false, "write readOnlyHint");
      assert(operation.annotations.idempotentHint === false, "write idempotentHint");
    }

    const destructiveHint =
      operation.riskTier === "destructive" || operation.riskTier === "financial";
    assert(
      operation.annotations.destructiveHint === destructiveHint,
      `destructiveHint mismatch for ${operation.operationId}`,
    );
  }

  for (const [toolset, count] of toolsetCounts) {
    assert(count > 0, `toolset ${toolset} has zero members`);
  }
  assert(toolsetCounts.size === TOOLSET_IDS.length, "expected 19 exclusive toolsets");

  const counted = countCensus(manifest.operations);
  assert(
    counted.total === manifest.census.total &&
      counted.get === manifest.census.get &&
      counted.nonGet === manifest.census.nonGet,
    "manifest.census does not match operations[]",
  );
  assert(
    censusMatches(counted, EXPECTED_CENSUS),
    `census mismatch: expected ${formatCensus(EXPECTED_CENSUS)}, got ${formatCensus(counted)}`,
  );

  const tiers = countWriteTiers(manifest.operations);
  for (const key of Object.keys(EXPECTED_WRITE_TIERS) as Array<keyof typeof EXPECTED_WRITE_TIERS>) {
    assert(
      tiers[key] === EXPECTED_WRITE_TIERS[key],
      `write tier ${key}: expected ${EXPECTED_WRITE_TIERS[key]}, got ${tiers[key]}`,
    );
  }

  const syntheticResolved: ResolvedOperation[] = manifest.operations.map((operation) => ({
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    tags: [operation.tag],
    operation: {},
    pathItem: {},
  }));
  const twins = detectTwins(syntheticResolved);
  assert(
    twins.pairCount === EXPECTED_TWIN_PAIRS,
    `twin pairs: expected ${EXPECTED_TWIN_PAIRS}, got ${twins.pairCount}`,
  );
  assert(
    twins.v2OnlyOperationIds.length === EXPECTED_V2_ONLY,
    `v2-only: expected ${EXPECTED_V2_ONLY}, got ${twins.v2OnlyOperationIds.length}`,
  );
  for (const operation of manifest.operations) {
    const expectedTwin = twins.twinByOperationId.get(operation.operationId) ?? null;
    assert(
      operation.twinOperationId === expectedTwin,
      `twin mismatch for ${operation.operationId}: expected ${expectedTwin}, got ${operation.twinOperationId}`,
    );
  }

  const defaultToolsetSet = new Set<string>(DEFAULT_TOOLSET_IDS);
  const defaultReads = manifest.operations.filter(
    (operation) => operation.method === "get" && defaultToolsetSet.has(operation.primaryToolset),
  );
  assert(
    defaultReads.length === EXPECTED_DEFAULT_READS_BEFORE_CAPABILITIES,
    `default reads before capabilities: expected ${EXPECTED_DEFAULT_READS_BEFORE_CAPABILITIES}, got ${defaultReads.length}`,
  );
  const defaultReadsNoCapabilities = defaultReads.filter(
    (operation) => operation.capabilities.length === 0,
  );
  assert(
    defaultReadsNoCapabilities.length === EXPECTED_DEFAULT_READS_AFTER_CAPABILITIES,
    `default reads with no capabilities: expected ${EXPECTED_DEFAULT_READS_AFTER_CAPABILITIES}, got ${defaultReadsNoCapabilities.length}`,
  );

  const salesGetSales = manifest.operations.find(
    (operation) => operation.operationId === "Sales_GetSales",
  );
  assert(salesGetSales, "Sales_GetSales missing");
  assert(
    JSON.stringify(salesGetSales.capabilities) === JSON.stringify(["binary-io", "impersonation"]),
    `Sales_GetSales capabilities: ${JSON.stringify(salesGetSales.capabilities)}`,
  );
  assert(salesGetSales.riskTier === "read", "Sales_GetSales must remain a read");
  assert(
    defaultToolsetSet.has(salesGetSales.primaryToolset),
    "Sales_GetSales must be in a default toolset",
  );

  const abbreviations = JSON.parse(
    await readFile(abbreviationsPath, "utf8"),
  ) as AbbreviationRecord[];
  assert(Array.isArray(abbreviations), "abbreviations must be an array");
  for (const entry of abbreviations) {
    assert(seenIds.has(entry.operationId), `abbreviation for unknown op ${entry.operationId}`);
    assert(
      entry.toolName === computeToolName(entry.operationId),
      `abbreviation toolName mismatch for ${entry.operationId}`,
    );
  }

  // Exact tag coverage: every classification tag appears at least once, every manifest tag is mapped.
  const tagsSeen = new Set(manifest.operations.map((operation) => operation.tag));
  for (const tag of tagIndex.keys()) {
    assert(tagsSeen.has(tag), `classification tag never used: ${tag}`);
  }

  return manifest;
}

async function main(): Promise<void> {
  const manifest = await verifyManifest();
  const tiers = countWriteTiers(manifest.operations);
  process.stdout.write(
    [
      `Manifest OK: sha256=${manifest.openapiSha256}`,
      formatCensus(manifest.census),
      `tiers ordinary=${tiers.ordinary} destructive=${tiers.destructive} financial=${tiers.financial} admin=${tiers.admin} binary-io=${tiers["binary-io"]}`,
      `toolsets=${TOOLSET_IDS.length} twins=${EXPECTED_TWIN_PAIRS} v2-only=${EXPECTED_V2_ONLY}`,
      "",
    ].join("\n"),
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
