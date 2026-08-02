import type { HttpMethod } from "./census.ts";
import type { ResolvedOperation } from "./openapi-document.ts";

/**
 * Normalize a path for v1/v2 twin matching by stripping `/v2` path segments.
 */
export function twinPathKey(path: string): string {
  return path.replace(/\/v2(?=\/|$)/gi, "");
}

export interface TwinMaps {
  /** operationId → twin operationId (or null when unpaired / v2-only). */
  twinByOperationId: Map<string, string | null>;
  pairCount: number;
  v2OnlyOperationIds: string[];
}

/**
 * Detect v1/v2 twins by matching HTTP method + path with `/v2` stripped.
 *
 * Returns 42 pairs and 4 v2-only operations for the pinned Transaction Management digest.
 */
export function detectTwins(operations: readonly ResolvedOperation[]): TwinMaps {
  const groups = new Map<string, ResolvedOperation[]>();
  for (const operation of operations) {
    const key = `${operation.method}:${twinPathKey(operation.path)}`;
    const group = groups.get(key);
    if (group) {
      group.push(operation);
    } else {
      groups.set(key, [operation]);
    }
  }

  const twinByOperationId = new Map<string, string | null>();
  let pairCount = 0;
  const v2OnlyOperationIds: string[] = [];

  for (const group of groups.values()) {
    const v1 = group.filter((operation) => !/\/v2(\/|$)/i.test(operation.path));
    const v2 = group.filter((operation) => /\/v2(\/|$)/i.test(operation.path));

    if (v1.length === 1 && v2.length === 1) {
      pairCount += 1;
      twinByOperationId.set(v1[0]!.operationId, v2[0]!.operationId);
      twinByOperationId.set(v2[0]!.operationId, v1[0]!.operationId);
      continue;
    }

    for (const operation of group) {
      twinByOperationId.set(operation.operationId, null);
      if (/\/v2(\/|$)/i.test(operation.path) && v1.length === 0) {
        v2OnlyOperationIds.push(operation.operationId);
      }
    }
  }

  v2OnlyOperationIds.sort((a, b) => a.localeCompare(b));
  return { twinByOperationId, pairCount, v2OnlyOperationIds };
}

export function isV2Path(path: string): boolean {
  return /\/v2(\/|$)/i.test(path);
}

export function methodPathKey(method: HttpMethod, path: string): string {
  return `${method}:${twinPathKey(path)}`;
}
