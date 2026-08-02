/** Expected Transaction Management REST census for the pinned OpenAPI digest. */
export const EXPECTED_CENSUS = {
  total: 207,
  get: 91,
  nonGet: 116,
} as const;

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

export interface CensusCounts {
  total: number;
  get: number;
  nonGet: number;
}

export interface OperationRecord {
  operationId: string;
  method: HttpMethod;
  path: string;
  apiVersion: "v1" | "v2";
  tag: string;
}

export interface OperationsManifest {
  openapiSha256: string;
  census: CensusCounts;
  operations: OperationRecord[];
}

export function countCensus(operations: readonly OperationRecord[]): CensusCounts {
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
