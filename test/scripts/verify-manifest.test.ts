import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { generateFromSpec } from "../../scripts/generate.ts";
import { EXPECTED_CENSUS } from "../../scripts/lib/census.ts";
import { verifyManifest } from "../../scripts/verify-manifest.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = path.join(root, "test/fixtures/openapi/synthetic.openapi.json");
const tempRoot = path.join(root, ".tmp");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("verify-manifest (census-only)", () => {
  it("accepts the pinned generated manifest when present", async () => {
    const pinPath = path.join(root, "openapi.sha256");
    const manifestPath = path.join(root, "src/generated/operations.manifest.json");
    let pin: string;
    try {
      pin = (await readFile(pinPath, "utf8")).trim();
      await readFile(manifestPath, "utf8");
    } catch {
      // Pin/generate happens later in Commit 1; skip until artifacts exist.
      return;
    }
    const manifest = await verifyManifest(manifestPath, pinPath);
    expect(manifest.openapiSha256).toBe(pin);
    expect(manifest.census).toEqual(EXPECTED_CENSUS);
    for (const operation of manifest.operations) {
      expect(Object.keys(operation).sort()).toEqual([
        "apiVersion",
        "method",
        "operationId",
        "path",
        "tag",
      ]);
    }
  });

  it("rejects manifests that include non-census policy fields", async () => {
    await mkdir(tempRoot, { recursive: true });
    const outDir = await mkdtemp(path.join(tempRoot, "tm-verify-"));
    tempDirs.push(outDir);
    const result = await generateFromSpec({ specPath: fixturePath, outDir });
    const manifestPath = path.join(outDir, "operations.manifest.json");
    const pinPath = path.join(outDir, "openapi.sha256");
    await writeFile(pinPath, `${result.openapiSha256}\n`, "utf8");

    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      operations: Array<Record<string, unknown>>;
      census: { total: number; get: number; nonGet: number };
      openapiSha256: string;
    };
    manifest.operations[0] = { ...manifest.operations[0], riskTier: "ordinary" };
    // Satisfy expected census counts artificially so the field-shape check fails first.
    manifest.census = { ...EXPECTED_CENSUS };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(verifyManifest(manifestPath, pinPath)).rejects.toThrow(/census fields/);
  });
});
