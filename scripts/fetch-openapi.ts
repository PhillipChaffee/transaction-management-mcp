import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_CENSUS,
  OPENAPI_URL,
  censusMatches,
  countCensus,
  formatCensus,
} from "./lib/census.ts";
import type { OpenAPIDocument } from "./lib/openapi-document.ts";
import { deriveApiVersion, listOperations, primaryTag } from "./lib/openapi-document.ts";
import { generateFromSpec } from "./generate.ts";

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

async function fetchToTemp(): Promise<{ tempDir: string; specPath: string; body: Buffer }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "tm-openapi-"));
  const specPath = path.join(tempDir, "swagger.json");
  const response = await fetch(OPENAPI_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    await rm(tempDir, { recursive: true, force: true });
    throw new Error(`Failed to fetch OpenAPI: HTTP ${response.status} ${response.statusText}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  await writeFile(specPath, body);
  return { tempDir, specPath, body };
}

function censusFromDocument(document: OpenAPIDocument) {
  const operations = listOperations(document).map((operation) => ({
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    apiVersion: deriveApiVersion(operation.path, operation.tags),
    tag: primaryTag(operation.tags),
  }));
  return countCensus(operations);
}

async function main(): Promise<void> {
  const mode = process.argv.includes("--pin")
    ? "pin"
    : process.argv.includes("--generate")
      ? "generate"
      : null;
  if (!mode) {
    throw new Error("Usage: tsx scripts/fetch-openapi.ts --pin|--generate");
  }

  const root = repoRoot();
  const pinPath = path.join(root, "openapi.sha256");
  const outDir = path.join(root, "src/generated");
  let tempDir: string | undefined;

  try {
    const fetched = await fetchToTemp();
    tempDir = fetched.tempDir;
    const digest = sha256Hex(fetched.body);
    const document = JSON.parse(fetched.body.toString("utf8")) as OpenAPIDocument;
    const census = censusFromDocument(document);

    if (mode === "pin") {
      if (!censusMatches(census, EXPECTED_CENSUS)) {
        process.stderr.write(
          [
            "Census mismatch against planned Transaction Management REST counts.",
            `expected: ${formatCensus(EXPECTED_CENSUS)}`,
            `actual:   ${formatCensus(census)}`,
            `sha256:   ${digest}`,
            "Stop and update the plan/acceptance criteria. Do not pad overrides.",
            "",
          ].join("\n"),
        );
        process.exitCode = 2;
        return;
      }
      await writeFile(pinPath, `${digest}\n`, "utf8");
      process.stdout.write(`Pinned openapi.sha256=${digest} (${formatCensus(census)})\n`);
    } else {
      let pinned: string;
      try {
        pinned = (await readFile(pinPath, "utf8")).trim();
      } catch {
        throw new Error("openapi.sha256 is missing. Run npm run openapi:pin first.");
      }
      if (pinned !== digest) {
        throw new Error(
          `OpenAPI digest drift: pinned=${pinned} fetched=${digest}. Re-pin intentionally or investigate upstream changes.`,
        );
      }
      process.stdout.write(`OpenAPI digest matches pin (${digest})\n`);
    }

    const result = await generateFromSpec({
      specPath: fetched.specPath,
      outDir,
      openapiSha256: digest,
    });
    process.stdout.write(
      `Generated derived artifacts under ${path.relative(root, outDir)} (${formatCensus(result.manifest.census)})\n`,
    );
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
