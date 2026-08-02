/**
 * Compare the pinned OpenAPI digest to the live public swagger.
 *
 * Exit codes:
 * - 0: unchanged, or upstream/network unavailable (neutral warning)
 * - 2: drift detected (CI creates/updates an issue; does not fail the workflow
 *      unless `--strict` is passed)
 *
 * Never writes the raw spec into the repository. Temp files are deleted.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OPENAPI_URL,
  countCensus,
  type CensusCounts,
  type OperationsManifest,
} from "./lib/census.ts";
import type { OpenAPIDocument } from "./lib/openapi-document.ts";
import {
  DRIFT_ISSUE_LABEL,
  DRIFT_ISSUE_TITLE,
  buildDriftReport,
  buildUnavailableReport,
  buildUnchangedReport,
  formatDriftIssueBody,
  sha256Hex,
  type DriftReport,
} from "./lib/openapi-drift.ts";

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export type CheckOpenApiDriftOptions = {
  root?: string;
  fetchImpl?: typeof fetch;
  pinnedShaPath?: string;
  manifestPath?: string;
  /** When true, exit 2 on drift (default false so CI can open an issue and succeed). */
  strict?: boolean;
  /** Emit machine-readable JSON on stdout. */
  json?: boolean;
  /** Also print the GitHub issue body (markdown) after the report. */
  issueBody?: boolean;
};

export async function checkOpenApiDrift(
  options: CheckOpenApiDriftOptions = {},
): Promise<DriftReport> {
  const root = options.root ?? repoRoot();
  const pinnedShaPath = options.pinnedShaPath ?? path.join(root, "openapi.sha256");
  const manifestPath =
    options.manifestPath ?? path.join(root, "src/generated/operations.manifest.json");
  const fetchImpl = options.fetchImpl ?? fetch;

  let pinnedSha256: string;
  try {
    pinnedSha256 = (await readFile(pinnedShaPath, "utf8")).trim();
  } catch {
    return buildUnavailableReport("", "openapi.sha256 is missing; run npm run openapi:pin first");
  }
  if (!/^[a-f0-9]{64}$/.test(pinnedSha256)) {
    return buildUnavailableReport(pinnedSha256, "openapi.sha256 is not a 64-char hex digest");
  }

  let tempDir: string | undefined;
  try {
    tempDir = await mkdtemp(path.join(tmpdir(), "tm-openapi-drift-"));
    const specPath = path.join(tempDir, "swagger.json");
    const response = await fetchImpl(OPENAPI_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      return buildUnavailableReport(
        pinnedSha256,
        `upstream HTTP ${response.status} ${response.statusText}`,
      );
    }
    const body = Buffer.from(await response.arrayBuffer());
    await writeFile(specPath, body);
    const fetchedSha256 = sha256Hex(body);

    if (fetchedSha256 === pinnedSha256) {
      return buildUnchangedReport(pinnedSha256);
    }

    const fetchedDocument = JSON.parse(body.toString("utf8")) as OpenAPIDocument;
    let pinnedOperationIds: string[] = [];
    let pinnedCensus: CensusCounts | undefined;
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as OperationsManifest;
      pinnedOperationIds = manifest.operations.map((operation) => operation.operationId).sort();
      pinnedCensus = countCensus(manifest.operations);
    } catch {
      // Manifest may be absent in exotic checkouts; still report hash drift.
    }

    const driftOptions: Parameters<typeof buildDriftReport>[0] = {
      pinnedSha256,
      fetchedSha256,
      fetchedDocument,
      pinnedOperationIds,
    };
    if (pinnedCensus !== undefined) {
      driftOptions.pinnedCensus = pinnedCensus;
    }
    return buildDriftReport(driftOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildUnavailableReport(pinnedSha256, message);
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const issueBody = argv.includes("--issue-body");
  const strict = argv.includes("--strict");

  const report = await checkOpenApiDrift({ json, issueBody, strict });

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${report.message}\n`);
    if (report.warning) {
      process.stderr.write(`warning: ${report.warning}\n`);
    }
  }

  if (issueBody && report.status === "drift") {
    process.stdout.write("\n--- ISSUE BODY ---\n");
    process.stdout.write(formatDriftIssueBody(report));
    process.stdout.write(`\nlabel: ${DRIFT_ISSUE_LABEL}\n`);
    process.stdout.write(`title: ${DRIFT_ISSUE_TITLE}\n`);
  }

  if (report.status === "drift" && strict) {
    process.exitCode = 2;
    return;
  }
  process.exitCode = 0;
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
