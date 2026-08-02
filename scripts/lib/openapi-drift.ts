/**
 * Compare a pinned OpenAPI digest against a freshly fetched public document.
 *
 * Never persists the raw spec outside a caller-provided temp path. CI should
 * emit a report and open an issue on drift; it must not commit the spec.
 */

import { createHash } from "node:crypto";

import { type CensusCounts, OPENAPI_URL, countCensus, formatCensus } from "./census.ts";
import {
  type OpenAPIDocument,
  deriveApiVersion,
  listOperations,
  primaryTag,
} from "./openapi-document.ts";

export type DriftStatus = "unchanged" | "drift" | "unavailable";

export type DriftOperationRef = {
  operationId: string;
  method: string;
  path: string;
};

export type DriftReport = {
  status: DriftStatus;
  openapiUrl: string;
  pinnedSha256: string;
  fetchedSha256?: string;
  pinnedCensus?: CensusCounts;
  fetchedCensus?: CensusCounts;
  addedOperationIds: string[];
  removedOperationIds: string[];
  warning?: string;
  message: string;
};

export function sha256Hex(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function operationIdsFromDocument(document: OpenAPIDocument): string[] {
  return listOperations(document)
    .map((operation) => operation.operationId)
    .sort((left, right) => left.localeCompare(right));
}

export function censusFromDocument(document: OpenAPIDocument): CensusCounts {
  const operations = listOperations(document).map((operation) => ({
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    apiVersion: deriveApiVersion(operation.path, operation.tags),
    tag: primaryTag(operation.tags),
  }));
  return countCensus(operations);
}

export function diffSortedIds(
  previous: readonly string[],
  next: readonly string[],
): { added: string[]; removed: string[] } {
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  const added = next.filter((id) => !previousSet.has(id));
  const removed = previous.filter((id) => !nextSet.has(id));
  return { added, removed };
}

export function buildUnchangedReport(pinnedSha256: string): DriftReport {
  return {
    status: "unchanged",
    openapiUrl: OPENAPI_URL,
    pinnedSha256,
    fetchedSha256: pinnedSha256,
    addedOperationIds: [],
    removedOperationIds: [],
    message: `OpenAPI digest unchanged (${pinnedSha256}).`,
  };
}

export function buildUnavailableReport(pinnedSha256: string, warning: string): DriftReport {
  return {
    status: "unavailable",
    openapiUrl: OPENAPI_URL,
    pinnedSha256,
    addedOperationIds: [],
    removedOperationIds: [],
    warning,
    message: `OpenAPI drift check skipped: ${warning}`,
  };
}

export function buildDriftReport(options: {
  pinnedSha256: string;
  fetchedSha256: string;
  pinnedDocument?: OpenAPIDocument;
  fetchedDocument: OpenAPIDocument;
  pinnedOperationIds?: readonly string[];
  pinnedCensus?: CensusCounts;
}): DriftReport {
  const fetchedCensus = censusFromDocument(options.fetchedDocument);
  const fetchedIds = operationIdsFromDocument(options.fetchedDocument);
  const pinnedIds =
    options.pinnedOperationIds ??
    (options.pinnedDocument ? operationIdsFromDocument(options.pinnedDocument) : []);
  const pinnedCensus =
    options.pinnedCensus ??
    (options.pinnedDocument ? censusFromDocument(options.pinnedDocument) : undefined);
  const { added, removed } = diffSortedIds(pinnedIds, fetchedIds);

  const report: DriftReport = {
    status: "drift",
    openapiUrl: OPENAPI_URL,
    pinnedSha256: options.pinnedSha256,
    fetchedSha256: options.fetchedSha256,
    fetchedCensus,
    addedOperationIds: added,
    removedOperationIds: removed,
    message: [
      "OpenAPI digest drifted from the pinned hash.",
      `pinned:  ${options.pinnedSha256}`,
      `fetched: ${options.fetchedSha256}`,
      pinnedCensus ? `pinned census:  ${formatCensus(pinnedCensus)}` : undefined,
      `fetched census: ${formatCensus(fetchedCensus)}`,
      `added operationIds (${added.length}): ${added.join(", ") || "(none)"}`,
      `removed operationIds (${removed.length}): ${removed.join(", ") || "(none)"}`,
      "Human review required: re-pin and regenerate after plan review. Do not auto-commit.",
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  };
  if (pinnedCensus !== undefined) {
    report.pinnedCensus = pinnedCensus;
  }
  return report;
}

/**
 * Format a GitHub issue body for OpenAPI drift.
 */
export function formatDriftIssueBody(report: DriftReport): string {
  const pinnedCensus = report.pinnedCensus
    ? formatCensus(report.pinnedCensus)
    : "(not available without previous document)";
  const fetchedCensus = report.fetchedCensus ? formatCensus(report.fetchedCensus) : "(unavailable)";

  return [
    "## OpenAPI drift detected",
    "",
    "The public Transaction Management swagger digest no longer matches `openapi.sha256`.",
    "This issue is opened by automation. It never commits the raw spec.",
    "",
    "### Digests",
    "",
    `- **Pinned:** \`${report.pinnedSha256}\``,
    `- **Fetched:** \`${report.fetchedSha256 ?? "(unavailable)"}\``,
    `- **Source:** ${report.openapiUrl}`,
    "",
    "### Census",
    "",
    `- **Pinned:** ${pinnedCensus}`,
    `- **Fetched:** ${fetchedCensus}`,
    "",
    "### Added operationIds",
    "",
    report.addedOperationIds.length > 0
      ? report.addedOperationIds.map((id) => `- \`${id}\``).join("\n")
      : "- (none)",
    "",
    "### Removed operationIds",
    "",
    report.removedOperationIds.length > 0
      ? report.removedOperationIds.map((id) => `- \`${id}\``).join("\n")
      : "- (none)",
    "",
    "### Next steps",
    "",
    "1. Review upstream BETA OpenAPI changes.",
    "2. Update the implementation plan / acceptance criteria if the census moved.",
    "3. Run `npm run openapi:pin` then `npm run openapi:generate` locally.",
    "4. Regenerate tests as needed and open a human-authored PR.",
    "",
    "_Do not paste the raw OpenAPI document into this issue._",
    "",
  ].join("\n");
}

export const DRIFT_ISSUE_TITLE = "[openapi-drift] Upstream Transaction Management OpenAPI changed";
export const DRIFT_ISSUE_LABEL = "openapi-drift";
