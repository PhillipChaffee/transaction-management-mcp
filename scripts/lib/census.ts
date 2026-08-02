/** Expected Transaction Management REST census for the pinned OpenAPI digest. */
export const EXPECTED_CENSUS = {
  total: 207,
  get: 91,
  nonGet: 116,
} as const;

/** Exclusive write-tier counts for the pinned digest (GET ops are riskTier `read`). */
export const EXPECTED_WRITE_TIERS = {
  ordinary: 68,
  destructive: 13,
  financial: 28,
  admin: 5,
  "binary-io": 2,
} as const;

export const EXPECTED_TWIN_PAIRS = 42;
export const EXPECTED_V2_ONLY = 4;

/** Default-toolset reads before capability filtering, and after (Sales_GetSales removed). */
export const EXPECTED_DEFAULT_READS_BEFORE_CAPABILITIES = 31;
export const EXPECTED_DEFAULT_READS_AFTER_CAPABILITIES = 30;

export const OPENAPI_URL = "https://api.skyslope.com/swagger/v1/swagger.json";

export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export type RiskTier = "read" | "ordinary" | "destructive" | "financial" | "admin" | "binary-io";

export type CapabilityId =
  "destructive" | "financial" | "admin" | "binary-io" | "bulk-export" | "impersonation";

export type CodecId =
  | "base64-upload"
  | "cda"
  | "bulk-stream"
  | "replica-timestamp"
  | "octet-stream"
  | "no-content"
  | "query-write"
  | "no-body-write"
  | "open-body"
  | "empty-value"
  | "json";

export interface ToolAnnotations {
  openWorldHint: boolean;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
}

export interface CensusCounts {
  total: number;
  get: number;
  nonGet: number;
}

export interface OperationRecord {
  operationId: string;
  toolName: string;
  method: HttpMethod;
  path: string;
  apiVersion: "v1" | "v2";
  twinOperationId: string | null;
  tag: string;
  primaryToolset: string;
  riskTier: RiskTier;
  capabilities: CapabilityId[];
  inputCodec: CodecId;
  outputCodec: CodecId;
  annotations: ToolAnnotations;
  description: string;
}

export interface OperationsManifest {
  openapiSha256: string;
  census: CensusCounts;
  operations: OperationRecord[];
}

export function countCensus(operations: readonly { method: HttpMethod }[]): CensusCounts {
  let get = 0;
  let nonGet = 0;
  for (const operation of operations) {
    if (operation.method === "get") {
      get += 1;
    } else {
      nonGet += 1;
    }
  }
  return { total: operations.length, get, nonGet };
}

export function countWriteTiers(
  operations: readonly { method: HttpMethod; riskTier: RiskTier }[],
): Record<keyof typeof EXPECTED_WRITE_TIERS, number> {
  const counts = {
    ordinary: 0,
    destructive: 0,
    financial: 0,
    admin: 0,
    "binary-io": 0,
  };
  for (const operation of operations) {
    if (operation.method === "get") {
      continue;
    }
    const tier = operation.riskTier;
    if (tier === "read") {
      throw new Error(`non-GET operation has riskTier read: unexpected`);
    }
    counts[tier] += 1;
  }
  return counts;
}

export function formatCensus(census: CensusCounts): string {
  return `${census.total} operations / ${census.get} GET / ${census.nonGet} non-GET`;
}

export function censusMatches(actual: CensusCounts, expected: CensusCounts): boolean {
  return (
    actual.total === expected.total &&
    actual.get === expected.get &&
    actual.nonGet === expected.nonGet
  );
}
