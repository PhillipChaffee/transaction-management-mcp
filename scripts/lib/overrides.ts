import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml } from "yaml";

import type { CapabilityId, CodecId, RiskTier, ToolAnnotations } from "./census.ts";

export interface ClassificationRules {
  tagToToolset: Record<string, string[]>;
  defaultToolsetIds: string[];
  binaryIoOperationIds: string[];
  adminTags: string[];
  adminOperationIds: string[];
  financialTags: string[];
  destructiveOperationIdSubstrings: string[];
  binaryIoCapabilityOperationIds: string[];
  binaryIoCapabilityOperationIdPrefixes: string[];
  impersonationParameterName: string;
  bulkExportTag: string;
}

export interface OperationOverride {
  riskTier?: RiskTier;
  capabilities?: CapabilityId[];
  inputCodec?: CodecId;
  outputCodec?: CodecId;
  annotations?: Partial<ToolAnnotations>;
  description?: string;
  reason?: string;
}

export interface OperationsOverridesFile {
  operations: Record<string, OperationOverride>;
}

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return value as string[];
}

function asStringRecordOfArrays(value: unknown, label: string): Record<string, string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const result: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = asStringArray(entry, `${label}.${key}`);
  }
  return result;
}

/**
 * Load generator classification rules from YAML.
 */
export async function loadClassificationRules(
  filePath = path.join(repoRoot(), "overrides/classification-rules.yaml"),
): Promise<ClassificationRules> {
  const raw = parseYaml(await readFile(filePath, "utf8")) as Record<string, unknown>;
  return {
    tagToToolset: asStringRecordOfArrays(raw.tagToToolset, "tagToToolset"),
    defaultToolsetIds: asStringArray(raw.defaultToolsetIds, "defaultToolsetIds"),
    binaryIoOperationIds: asStringArray(raw.binaryIoOperationIds, "binaryIoOperationIds"),
    adminTags: asStringArray(raw.adminTags, "adminTags"),
    adminOperationIds: asStringArray(raw.adminOperationIds, "adminOperationIds"),
    financialTags: asStringArray(raw.financialTags, "financialTags"),
    destructiveOperationIdSubstrings: asStringArray(
      raw.destructiveOperationIdSubstrings,
      "destructiveOperationIdSubstrings",
    ),
    binaryIoCapabilityOperationIds: asStringArray(
      raw.binaryIoCapabilityOperationIds,
      "binaryIoCapabilityOperationIds",
    ),
    binaryIoCapabilityOperationIdPrefixes: asStringArray(
      raw.binaryIoCapabilityOperationIdPrefixes,
      "binaryIoCapabilityOperationIdPrefixes",
    ),
    impersonationParameterName: String(raw.impersonationParameterName ?? "userBeingImpersonated"),
    bulkExportTag: String(raw.bulkExportTag ?? "Bulk Export"),
  };
}

/**
 * Load known-operation annotation exceptions from YAML.
 */
export async function loadOperationsOverrides(
  filePath = path.join(repoRoot(), "overrides/operations.yaml"),
): Promise<OperationsOverridesFile> {
  const raw = parseYaml(await readFile(filePath, "utf8")) as {
    operations?: Record<string, OperationOverride>;
  };
  return { operations: raw.operations ?? {} };
}

/**
 * Build the exclusive OpenAPI-tag → toolset map; fail on duplicates.
 */
export function buildTagIndex(rules: ClassificationRules): Map<string, string> {
  const index = new Map<string, string>();
  for (const [toolset, tags] of Object.entries(rules.tagToToolset)) {
    for (const tag of tags) {
      const previous = index.get(tag);
      if (previous !== undefined) {
        throw new Error(
          `Duplicate tag mapping for ${JSON.stringify(tag)}: ${previous} and ${toolset}`,
        );
      }
      index.set(tag, toolset);
    }
  }
  return index;
}
