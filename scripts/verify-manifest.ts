import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OperationsManifest } from "./lib/census.ts";
import { EXPECTED_CENSUS, censusMatches, countCensus, formatCensus } from "./lib/census.ts";
import { HTTP_METHODS } from "./lib/census.ts";

const CENSUS_FIELDS = ["operationId", "method", "path", "apiVersion", "tag"] as const;

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export async function verifyManifest(
  manifestPath = path.join(repoRoot(), "src/generated/operations.manifest.json"),
  pinPath = path.join(repoRoot(), "openapi.sha256"),
): Promise<OperationsManifest> {
  const pin = (await readFile(pinPath, "utf8")).trim();
  assert(/^[a-f0-9]{64}$/.test(pin), `Invalid openapi.sha256 contents: ${pin}`);

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as OperationsManifest;
  assert(manifest.openapiSha256 === pin, "manifest.openapiSha256 does not match openapi.sha256");

  assert(Array.isArray(manifest.operations), "manifest.operations must be an array");
  const seen = new Set<string>();
  for (const [index, operation] of manifest.operations.entries()) {
    const keys = Object.keys(operation).sort();
    assert(
      keys.length === CENSUS_FIELDS.length && CENSUS_FIELDS.every((field) => keys.includes(field)),
      `operations[${index}] must contain only census fields ${CENSUS_FIELDS.join(", ")}; got ${keys.join(", ")}`,
    );
    assert(
      typeof operation.operationId === "string" && operation.operationId.length > 0,
      "operationId",
    );
    assert(
      (HTTP_METHODS as readonly string[]).includes(operation.method),
      `invalid method ${operation.method}`,
    );
    assert(typeof operation.path === "string" && operation.path.startsWith("/"), "path");
    assert(operation.apiVersion === "v1" || operation.apiVersion === "v2", "apiVersion");
    assert(typeof operation.tag === "string" && operation.tag.length > 0, "tag");
    assert(!seen.has(operation.operationId), `duplicate operationId ${operation.operationId}`);
    seen.add(operation.operationId);
  }

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

  return manifest;
}

async function main(): Promise<void> {
  const manifest = await verifyManifest();
  process.stdout.write(
    `Manifest OK: sha256=${manifest.openapiSha256} ${formatCensus(manifest.census)}\n`,
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
