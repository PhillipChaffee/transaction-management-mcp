/**
 * Startup-only configuration resolution.
 *
 * Parses argv and environment once into an immutable authorization policy and
 * validated runtime limits. Registrar, guards, confirmation, and codecs consume
 * the result and must not re-parse configuration.
 */

import { isReadOperation, type ManifestOperation } from "../manifest/types.js";
import {
  createRuntimeLimits,
  MAX_BINARY_OUTPUT_BYTES_CEILING,
  MAX_BULK_ITEMS_CEILING,
  MAX_STRUCTURED_OUTPUT_BYTES_CEILING,
  MAX_UPLOAD_BYTES_CEILING,
  parseEnvBoolean,
  parsePositiveSafeIntegerLimit,
  type RuntimeLimits,
} from "./runtime-limits.js";
import {
  CAPABILITY_IDS,
  createResolvedRuntimePolicy,
  isCapabilityId,
  type CapabilityId,
  type ResolvedRuntimePolicy,
} from "./runtime-policy.js";
import { DEFAULT_TOOLSET_IDS, TOOLSET_IDS, isToolsetId, type ToolsetId } from "./toolsets.js";

export type ResolveRuntimeOptions = {
  /** CLI arguments excluding the node/executable prefix (e.g. `process.argv.slice(2)`). */
  argv?: readonly string[];
  /** Environment map; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Manifest operations used for selection expansion. */
  operations: readonly ManifestOperation[];
};

export type ResolveRuntimeResult = {
  policy: ResolvedRuntimePolicy;
  limits: RuntimeLimits;
};

type CliFlags = {
  toolsets?: string;
  tools?: string;
  excludeToolsets?: string;
  excludeTools?: string;
  readWrite?: boolean;
  allow?: string;
};

/**
 * Parse argv/env once and return an immutable runtime policy plus limits.
 */
export function resolveRuntimeConfig(options: ResolveRuntimeOptions): ResolveRuntimeResult {
  const env = options.env ?? process.env;
  const cli = parseCliFlags(options.argv ?? []);

  const toolsetsRaw = pickListSource(env.SKYSLOPE_TM_TOOLSETS, cli.toolsets);
  const toolsRaw = pickListSource(env.SKYSLOPE_TM_TOOLS, cli.tools);
  const excludeToolsetsRaw = pickListSource(env.SKYSLOPE_TM_EXCLUDE_TOOLSETS, cli.excludeToolsets);
  const excludeToolsRaw = pickListSource(env.SKYSLOPE_TM_EXCLUDE_TOOLS, cli.excludeTools);

  const toolsetIds = resolveToolsetSelection(toolsetsRaw);
  const explicitToolNames = resolveExplicitTools(toolsRaw, options.operations);
  const excludeToolsetIds = resolveExcludeToolsets(excludeToolsetsRaw);
  const excludeToolNames = resolveExcludeTools(excludeToolsRaw, options.operations);

  const readWrite = resolveReadWrite(env.SKYSLOPE_TM_READ_WRITE, cli.readWrite);
  const grantedCapabilities = resolveAllow(env.SKYSLOPE_TM_ALLOW, cli.allow);

  const byToolset = indexByToolset(options.operations);
  const knownToolNames = new Set(options.operations.map((operation) => operation.toolName));
  const operationByToolName = new Map(
    options.operations.map((operation) => [operation.toolName, operation]),
  );

  const selected = new Set<string>();
  for (const toolsetId of toolsetIds) {
    for (const toolName of byToolset.get(toolsetId) ?? []) {
      selected.add(toolName);
    }
  }
  for (const toolName of explicitToolNames) {
    if (!knownToolNames.has(toolName)) {
      throw new Error(`Unknown tool name: ${toolName}`);
    }
    selected.add(toolName);
  }

  for (const toolName of [...selected]) {
    const operation = operationByToolName.get(toolName);
    if (!operation) {
      selected.delete(toolName);
      continue;
    }
    if (!capabilitiesGranted(operation.capabilities, grantedCapabilities)) {
      selected.delete(toolName);
    }
  }

  for (const toolName of [...selected]) {
    const operation = operationByToolName.get(toolName);
    if (!operation) {
      selected.delete(toolName);
      continue;
    }
    if (excludeToolsetIds.has(operation.primaryToolset as ToolsetId)) {
      selected.delete(toolName);
      continue;
    }
    if (excludeToolNames.has(toolName)) {
      selected.delete(toolName);
    }
  }

  if (!readWrite) {
    for (const toolName of [...selected]) {
      const operation = operationByToolName.get(toolName);
      if (!operation) {
        selected.delete(toolName);
        continue;
      }
      if (!isReadOperation(operation)) {
        selected.delete(toolName);
      }
    }
  }

  const limits = resolveLimits(env);

  return {
    policy: createResolvedRuntimePolicy({
      selectedToolNames: selected,
      readWrite,
      grantedCapabilities,
    }),
    limits,
  };
}

/**
 * Expand toolset ids / `default` / `all` into the concrete toolset id list.
 *
 * Exposed for tests that assert the pre-capability default surface.
 */
export function resolveToolsetSelection(raw: string | undefined): readonly ToolsetId[] {
  if (raw === undefined) {
    return DEFAULT_TOOLSET_IDS;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error("toolsets value must not be empty");
  }
  if (trimmed === "default") {
    return DEFAULT_TOOLSET_IDS;
  }
  if (trimmed === "all") {
    return TOOLSET_IDS;
  }
  const parts = splitCommaList(trimmed);
  const ids: ToolsetId[] = [];
  for (const part of parts) {
    if (part === "default" || part === "all") {
      throw new Error(`toolsets token "${part}" cannot be mixed with other ids`);
    }
    if (!isToolsetId(part)) {
      throw new Error(`Unknown toolset id: ${part}`);
    }
    ids.push(part);
  }
  return ids;
}

/**
 * Return whether every required capability is present in the granted set.
 */
export function capabilitiesGranted(
  required: readonly string[],
  granted: ReadonlySet<CapabilityId>,
): boolean {
  for (const capability of required) {
    if (!isCapabilityId(capability) || !granted.has(capability)) {
      return false;
    }
  }
  return true;
}

function resolveExplicitTools(
  raw: string | undefined,
  operations: readonly ManifestOperation[],
): readonly string[] {
  if (raw === undefined) {
    return [];
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error("tools value must not be empty");
  }
  const known = new Set(operations.map((operation) => operation.toolName));
  const names = splitCommaList(trimmed);
  for (const name of names) {
    if (!known.has(name)) {
      throw new Error(`Unknown tool name: ${name}`);
    }
  }
  return names;
}

function resolveExcludeToolsets(raw: string | undefined): ReadonlySet<ToolsetId> {
  if (raw === undefined || raw.trim() === "") {
    return new Set();
  }
  const ids = new Set<ToolsetId>();
  for (const part of splitCommaList(raw)) {
    if (!isToolsetId(part)) {
      throw new Error(`Unknown exclude toolset id: ${part}`);
    }
    ids.add(part);
  }
  return ids;
}

function resolveExcludeTools(
  raw: string | undefined,
  operations: readonly ManifestOperation[],
): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === "") {
    return new Set();
  }
  const known = new Set(operations.map((operation) => operation.toolName));
  const names = new Set<string>();
  for (const part of splitCommaList(raw)) {
    if (!known.has(part)) {
      throw new Error(`Unknown exclude tool name: ${part}`);
    }
    names.add(part);
  }
  return names;
}

function resolveReadWrite(envValue: string | undefined, cliValue: boolean | undefined): boolean {
  const envPresent = envValue !== undefined;
  const cliPresent = cliValue !== undefined;

  if (!envPresent && !cliPresent) {
    return false;
  }

  const envBool = envPresent ? parseEnvBoolean(envValue, "SKYSLOPE_TM_READ_WRITE") : undefined;
  const cliBool = cliPresent ? cliValue : undefined;

  if (envPresent && cliPresent) {
    return Boolean(envBool && cliBool);
  }
  return Boolean(envBool ?? cliBool);
}

function resolveAllow(
  envValue: string | undefined,
  cliValue: string | undefined,
): ReadonlySet<CapabilityId> {
  const envPresent = envValue !== undefined;
  const cliPresent = cliValue !== undefined;

  if (!envPresent && !cliPresent) {
    return new Set();
  }

  const envCaps = envPresent ? parseAllowList(envValue, "SKYSLOPE_TM_ALLOW") : undefined;
  const cliCaps = cliPresent ? parseAllowList(cliValue, "--allow") : undefined;

  if (envPresent && cliPresent) {
    const intersection = new Set<CapabilityId>();
    for (const capability of envCaps!) {
      if (cliCaps!.has(capability)) {
        intersection.add(capability);
      }
    }
    return intersection;
  }
  return envCaps ?? cliCaps ?? new Set();
}

function parseAllowList(raw: string, label: string): Set<CapabilityId> {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error(`${label} value must not be empty`);
  }
  if (trimmed === "all") {
    return new Set(CAPABILITY_IDS);
  }
  const granted = new Set<CapabilityId>();
  for (const part of splitCommaList(trimmed)) {
    if (part === "all") {
      throw new Error(`${label} token "all" cannot be mixed with other ids`);
    }
    if (!isCapabilityId(part)) {
      throw new Error(`Unknown capability id: ${part}`);
    }
    granted.add(part);
  }
  return granted;
}

function resolveLimits(env: Record<string, string | undefined>): RuntimeLimits {
  const overrides: {
    maxStructuredOutputBytes?: number;
    maxBinaryOutputBytes?: number;
    maxUploadBytes?: number;
    maxBulkItems?: number;
  } = {};
  if (env.SKYSLOPE_TM_MAX_OUTPUT_BYTES !== undefined) {
    overrides.maxStructuredOutputBytes = parsePositiveSafeIntegerLimit(
      env.SKYSLOPE_TM_MAX_OUTPUT_BYTES,
      "SKYSLOPE_TM_MAX_OUTPUT_BYTES",
      MAX_STRUCTURED_OUTPUT_BYTES_CEILING,
    );
  }
  if (env.SKYSLOPE_TM_MAX_BINARY_BYTES !== undefined) {
    overrides.maxBinaryOutputBytes = parsePositiveSafeIntegerLimit(
      env.SKYSLOPE_TM_MAX_BINARY_BYTES,
      "SKYSLOPE_TM_MAX_BINARY_BYTES",
      MAX_BINARY_OUTPUT_BYTES_CEILING,
    );
  }
  if (env.SKYSLOPE_TM_MAX_UPLOAD_BYTES !== undefined) {
    overrides.maxUploadBytes = parsePositiveSafeIntegerLimit(
      env.SKYSLOPE_TM_MAX_UPLOAD_BYTES,
      "SKYSLOPE_TM_MAX_UPLOAD_BYTES",
      MAX_UPLOAD_BYTES_CEILING,
    );
  }
  if (env.SKYSLOPE_TM_MAX_BULK_ITEMS !== undefined) {
    overrides.maxBulkItems = parsePositiveSafeIntegerLimit(
      env.SKYSLOPE_TM_MAX_BULK_ITEMS,
      "SKYSLOPE_TM_MAX_BULK_ITEMS",
      MAX_BULK_ITEMS_CEILING,
    );
  }
  return createRuntimeLimits(overrides);
}

function pickListSource(
  envValue: string | undefined,
  cliValue: string | undefined,
): string | undefined {
  if (envValue !== undefined) {
    return envValue;
  }
  return cliValue;
}

function splitCommaList(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function indexByToolset(operations: readonly ManifestOperation[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const operation of operations) {
    const list = map.get(operation.primaryToolset) ?? [];
    list.push(operation.toolName);
    map.set(operation.primaryToolset, list);
  }
  return map;
}

function parseCliFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--read-write") {
      flags.readWrite = true;
      continue;
    }
    if (token.startsWith("--read-write=")) {
      const value = token.slice("--read-write=".length);
      flags.readWrite = parseEnvBoolean(value, "--read-write");
      continue;
    }

    const paired = parsePairedFlag(token, argv[index + 1]);
    if (paired) {
      switch (paired.name) {
        case "toolsets":
          flags.toolsets = paired.value;
          break;
        case "tools":
          flags.tools = paired.value;
          break;
        case "exclude-toolsets":
          flags.excludeToolsets = paired.value;
          break;
        case "exclude-tools":
          flags.excludeTools = paired.value;
          break;
        case "allow":
          flags.allow = paired.value;
          break;
        default:
          break;
      }
      if (paired.consumedNext) {
        index += 1;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${token}`);
  }
  return flags;
}

function parsePairedFlag(
  token: string,
  next: string | undefined,
): { name: string; value: string; consumedNext: boolean } | undefined {
  const names = ["toolsets", "tools", "exclude-toolsets", "exclude-tools", "allow"] as const;
  for (const name of names) {
    const prefix = `--${name}=`;
    if (token === `--${name}`) {
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`Missing value for --${name}`);
      }
      return { name, value: next, consumedNext: true };
    }
    if (token.startsWith(prefix)) {
      return { name, value: token.slice(prefix.length), consumedNext: false };
    }
  }
  return undefined;
}
