import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { generateFromSpec } from "../../scripts/generate.ts";
import {
  EXPECTED_CENSUS,
  EXPECTED_DEFAULT_READS_AFTER_CAPABILITIES,
  EXPECTED_DEFAULT_READS_BEFORE_CAPABILITIES,
  EXPECTED_TWIN_PAIRS,
  EXPECTED_V2_ONLY,
  EXPECTED_WRITE_TIERS,
  countWriteTiers,
} from "../../scripts/lib/census.ts";
import { verifyManifest } from "../../scripts/verify-manifest.ts";
import { TOOLSET_IDS } from "../../src/config/toolsets.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = path.join(root, "test/fixtures/openapi/synthetic.openapi.json");
const tempRoot = path.join(root, ".tmp");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("verify-manifest (full policy)", () => {
  it("accepts the pinned generated policy manifest", async () => {
    const pinPath = path.join(root, "openapi.sha256");
    const manifestPath = path.join(root, "src/generated/operations.manifest.json");
    const pin = (await readFile(pinPath, "utf8")).trim();
    const manifest = await verifyManifest(manifestPath, pinPath);
    expect(manifest.openapiSha256).toBe(pin);
    expect(manifest.census).toEqual(EXPECTED_CENSUS);
    expect(countWriteTiers(manifest.operations)).toEqual(EXPECTED_WRITE_TIERS);
    expect(new Set(manifest.operations.map((operation) => operation.primaryToolset)).size).toBe(
      TOOLSET_IDS.length,
    );

    const twinPairs = manifest.operations.filter(
      (operation) => operation.twinOperationId !== null && operation.apiVersion === "v1",
    ).length;
    expect(twinPairs).toBe(EXPECTED_TWIN_PAIRS);
    expect(
      manifest.operations.filter(
        (operation) => operation.apiVersion === "v2" && operation.twinOperationId === null,
      ).length,
    ).toBe(EXPECTED_V2_ONLY);

    const defaultSet = new Set([
      "reference",
      "users",
      "sales",
      "listings",
      "contacts",
      "listing_contacts",
      "checklists",
      "stages",
      "offices",
    ]);
    const defaultReads = manifest.operations.filter(
      (operation) => operation.method === "get" && defaultSet.has(operation.primaryToolset),
    );
    expect(defaultReads.length).toBe(EXPECTED_DEFAULT_READS_BEFORE_CAPABILITIES);
    expect(defaultReads.filter((operation) => operation.capabilities.length === 0).length).toBe(
      EXPECTED_DEFAULT_READS_AFTER_CAPABILITIES,
    );
  });

  it("rejects manifests that omit required policy fields", async () => {
    await mkdir(tempRoot, { recursive: true });
    const outDir = await mkdtemp(path.join(tempRoot, "tm-verify-"));
    tempDirs.push(outDir);
    const result = await generateFromSpec({
      specPath: fixturePath,
      outDir,
      operationsOverrides: {},
    });
    const manifestPath = path.join(outDir, "operations.manifest.json");
    const pinPath = path.join(outDir, "openapi.sha256");
    const abbreviationsPath = path.join(outDir, "tool-name-abbreviations.json");
    await writeFile(pinPath, `${result.openapiSha256}\n`, "utf8");

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      operations: Array<Record<string, unknown>>;
      census: { total: number; get: number; nonGet: number };
      openapiSha256: string;
    };
    const first = { ...manifest.operations[0] };
    delete first.riskTier;
    manifest.operations[0] = first;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(verifyManifest(manifestPath, pinPath, abbreviationsPath)).rejects.toThrow(
      /policy fields/,
    );
  });
});
