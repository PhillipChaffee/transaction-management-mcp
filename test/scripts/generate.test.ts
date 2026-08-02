import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";

import { generateFromSpec, GENERATOR_ID } from "../../scripts/generate.ts";
import type { OperationsManifest } from "../../scripts/lib/census.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = path.join(root, "test/fixtures/openapi/synthetic.openapi.json");
const tempRoot = path.join(root, ".tmp");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface ToolSchemasModule {
  generatorId: string;
  toolSchemas: Record<string, { input: z.ZodObject; output: z.ZodType }>;
}

async function generateOnce(): Promise<{
  outDir: string;
  result: Awaited<ReturnType<typeof generateFromSpec>>;
  schemas: ToolSchemasModule;
}> {
  await mkdir(tempRoot, { recursive: true });
  const outDir = await mkdtemp(path.join(tempRoot, "tm-gen-"));
  tempDirs.push(outDir);
  const result = await generateFromSpec({ specPath: fixturePath, outDir });
  const schemas = (await import(
    `${pathToFileURL(path.join(outDir, "tool-schemas.ts")).href}?t=${Date.now()}`
  )) as ToolSchemasModule;
  return { outDir, result, schemas };
}

describe("generateFromSpec (synthetic fixture)", () => {
  it("emits types, schemas, and a census-only manifest for every fixture operation", async () => {
    const { outDir, result, schemas } = await generateOnce();

    expect(result.files).toHaveLength(3);
    expect(GENERATOR_ID).toBe("deterministic-zod-emitter");
    expect(schemas.generatorId).toBe(GENERATOR_ID);

    const manifest = JSON.parse(
      await readFile(path.join(outDir, "operations.manifest.json"), "utf8"),
    ) as OperationsManifest;

    expect(manifest.operations.length).toBeGreaterThan(0);
    expect(Object.keys(schemas.toolSchemas).sort()).toEqual(
      manifest.operations.map((operation) => operation.operationId).sort(),
    );

    for (const operation of manifest.operations) {
      expect(Object.keys(operation).sort()).toEqual([
        "apiVersion",
        "method",
        "operationId",
        "path",
        "tag",
      ]);
      const entry = schemas.toolSchemas[operation.operationId];
      expect(typeof entry?.input.parse).toBe("function");
      expect(typeof entry?.output.parse).toBe("function");
    }

    const dts = await readFile(path.join(outDir, "openapi.d.ts"), "utf8");
    expect(dts).toContain("AUTO-GENERATED FILE");
    expect(dts).toContain("paths");
  });

  it("accepts valid payloads and rejects invalid ones per anomaly class", async () => {
    const { schemas } = await generateOnce();
    const requireSchema = (operationId: string) => {
      const entry = schemas.toolSchemas[operationId];
      if (!entry) {
        throw new Error(`Missing schema for ${operationId}`);
      }
      return entry;
    };

    const getItem = requireSchema("Items_GetItem");
    expect(
      getItem.input.parse({
        path: { itemId: "abc" },
        query: { includeDetails: true },
      }),
    ).toBeTruthy();
    expect(() => getItem.input.parse({ path: { itemId: 1 } })).toThrow();

    const createItem = requireSchema("Items_CreateItem");
    expect(
      createItem.input.parse({
        path: { itemId: "abc" },
        body: { name: "n" },
      }),
    ).toBeTruthy();
    expect(() =>
      createItem.input.parse({
        path: { itemId: "abc" },
        body: { notes: "missing name" },
      }),
    ).toThrow();

    const openBody = requireSchema("Items_OpenBodyUpdate");
    expect(
      openBody.input.parse({
        path: { itemId: "abc" },
        body: { any: "shape" },
      }),
    ).toBeTruthy();
    expect(() =>
      openBody.input.parse({
        path: { itemId: "abc" },
        body: "not-an-object",
      }),
    ).toThrow();

    const queryWrite = requireSchema("Items_QueryWriteStatus");
    expect(
      queryWrite.input.parse({
        path: { itemId: "abc" },
        query: { status: "open" },
      }),
    ).toBeTruthy();
    expect(queryWrite.input.shape.body).toBeUndefined();
    expect(() =>
      queryWrite.input.parse({
        path: { itemId: "abc" },
        query: {},
      }),
    ).toThrow();

    const noBody = requireSchema("Items_NoBodyClose");
    expect(noBody.input.parse({ path: { itemId: "abc" } })).toBeTruthy();
    expect(noBody.input.shape.body).toBeUndefined();
    expect(noBody.input.shape.query).toBeUndefined();
    expect(noBody.output.parse({ success: true, status: 204 })).toBeTruthy();
    expect(() => noBody.output.parse({ success: true, status: 200 })).toThrow();

    const upload = requireSchema("Documents_AddDocument");
    expect(
      upload.input.parse({
        path: { documentId: "d1" },
        body: { fileName: "a.pdf", base64Content: "QQ==" },
      }),
    ).toBeTruthy();
    expect(() =>
      upload.input.parse({
        path: { documentId: "d1" },
        body: { fileName: "a.pdf" },
      }),
    ).toThrow();

    const cda = requireSchema("CdaDocumentData_Update");
    expect(
      cda.input.parse({
        path: { saleGuid: "00000000-0000-0000-0000-000000000001" },
        body: { documentData: { nested: true } },
      }),
    ).toBeTruthy();
    expect(
      cda.input.parse({
        path: { saleGuid: "00000000-0000-0000-0000-000000000001" },
        body: { documentData: null },
      }),
    ).toBeTruthy();
    expect(() =>
      cda.input.parse({
        path: { saleGuid: "00000000-0000-0000-0000-000000000001" },
        body: {},
      }),
    ).toThrow();

    const linked = requireSchema("Items_GetLinkedEmptyValue");
    expect(
      linked.output.parse({
        value: {},
        warnings: [],
        links: [{ href: "/x", rel: "self" }],
      }),
    ).toBeTruthy();
    expect(() => linked.output.parse({ warnings: "nope" })).toThrow();

    const bulk = requireSchema("BulkExport_GetExport");
    expect(
      bulk.output.parse({
        items: [{ id: "1", replicaTimestamp: "t" }],
      }),
    ).toBeTruthy();
    expect(() => bulk.output.parse({ items: "not-array" })).toThrow();

    const octet = requireSchema("Files_GetOctetStream");
    expect(
      octet.output.parse({
        contentType: "application/octet-stream",
        base64: "QQ==",
        truncated: false,
      }),
    ).toBeTruthy();
    expect(() =>
      octet.output.parse({
        contentType: "application/octet-stream",
        base64: "QQ==",
      }),
    ).toThrow();

    const sales = requireSchema("Sales_GetSales");
    expect(
      sales.input.parse({
        query: { userBeingImpersonated: 42, page: 1 },
      }),
    ).toBeTruthy();
    expect(() =>
      sales.input.parse({
        query: { userBeingImpersonated: "42" },
      }),
    ).toThrow();

    const v2 = requireSchema("V2Sales_GetSale");
    expect(
      v2.input.parse({
        path: { saleGuid: "00000000-0000-0000-0000-000000000001" },
      }),
    ).toBeTruthy();
  });

  it("is deterministic for the same fixture", async () => {
    const first = await generateOnce();
    const second = await generateOnce();

    for (const fileName of ["openapi.d.ts", "tool-schemas.ts", "operations.manifest.json"]) {
      const a = await readFile(path.join(first.outDir, fileName));
      const b = await readFile(path.join(second.outDir, fileName));
      expect(createHash("sha256").update(a).digest("hex")).toBe(
        createHash("sha256").update(b).digest("hex"),
      );
    }
  });

  it("never writes the raw OpenAPI document into the output directory", async () => {
    const { outDir } = await generateOnce();
    await expect(readFile(path.join(outDir, "openapi.json"))).rejects.toThrow();
    await expect(readFile(path.join(outDir, "swagger.json"))).rejects.toThrow();
    // Ensure a planted raw file is not part of generation outputs.
    await writeFile(path.join(outDir, "seed.txt"), "ok");
    const listed = await readFile(path.join(outDir, "operations.manifest.json"), "utf8");
    expect(listed).not.toContain('openapi":');
    expect(listed).not.toContain("swagger");
  });
});
