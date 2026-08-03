import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { checkOpenApiDrift } from "../../scripts/check-openapi-drift.ts";
import {
  buildDriftReport,
  buildUnavailableReport,
  buildUnchangedReport,
  diffSortedIds,
  formatDriftIssueBody,
  operationIdsFromDocument,
  sha256Hex,
} from "../../scripts/lib/openapi-drift.ts";
import type { OpenAPIDocument } from "../../scripts/lib/openapi-document.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = path.join(root, "test/fixtures/openapi");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function loadFixture(name: string): Promise<{ body: Buffer; document: OpenAPIDocument }> {
  const body = await readFile(path.join(fixtures, name));
  return { body, document: JSON.parse(body.toString("utf8")) as OpenAPIDocument };
}

describe("openapi drift helpers", () => {
  it("diffs added and removed operation ids", () => {
    expect(diffSortedIds(["a", "b"], ["b", "c"])).toEqual({
      added: ["c"],
      removed: ["a"],
    });
  });

  it("builds unchanged and unavailable reports", () => {
    const digest = "a".repeat(64);
    expect(buildUnchangedReport(digest).status).toBe("unchanged");
    const unavailable = buildUnavailableReport(digest, "network down");
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.warning).toContain("network down");
  });

  it("builds a drift report from fixture specs", async () => {
    const base = await loadFixture("drift-base.swagger.json");
    const changed = await loadFixture("drift-changed.swagger.json");
    const report = buildDriftReport({
      pinnedSha256: sha256Hex(base.body),
      fetchedSha256: sha256Hex(changed.body),
      pinnedDocument: base.document,
      fetchedDocument: changed.document,
    });

    expect(report.status).toBe("drift");
    expect(report.addedOperationIds).toEqual(["Offices_GetOffices"]);
    expect(report.removedOperationIds).toEqual(["Listings_GetListings"]);
    expect(report.fetchedCensus).toEqual({ total: 3, get: 2, nonGet: 1 });

    const body = formatDriftIssueBody(report);
    expect(body).toContain("Offices_GetOffices");
    expect(body).toContain("Listings_GetListings");
    expect(body).toContain("Do not paste the raw OpenAPI");
  });

  it("lists sorted operation ids from a document", async () => {
    const base = await loadFixture("drift-base.swagger.json");
    expect(operationIdsFromDocument(base.document)).toEqual([
      "Contacts_CreateContact",
      "Listings_GetListings",
      "Sales_GetSales",
    ]);
  });
});

describe("checkOpenApiDrift", () => {
  it("reports unchanged when fetched digest matches the pin", async () => {
    const body = Buffer.from(`{"openapi":"3.0.1","info":{"title":"x","version":"1"},"paths":{}}`);
    const digest = sha256Hex(body);
    const dir = await mkdtemp(path.join(tmpdir(), "tm-drift-pin-"));
    tempDirs.push(dir);
    const pinPath = path.join(dir, "openapi.sha256");
    await writeFile(pinPath, `${digest}\n`, "utf8");

    const report = await checkOpenApiDrift({
      root: dir,
      pinnedShaPath: pinPath,
      manifestPath: path.join(dir, "missing-manifest.json"),
      fetchImpl: (async () => new Response(body, { status: 200 })) as typeof fetch,
    });
    expect(report.status).toBe("unchanged");
    expect(report.fetchedSha256).toBe(digest);
  });

  it("returns unavailable (neutral) on network failure", async () => {
    const report = await checkOpenApiDrift({
      root,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED synthetic");
      }) as typeof fetch,
    });
    expect(report.status).toBe("unavailable");
    expect(report.warning).toMatch(/ECONNREFUSED/);
  });

  it("returns unavailable on upstream HTTP error", async () => {
    const report = await checkOpenApiDrift({
      root,
      fetchImpl: (async () => new Response("nope", { status: 503 })) as typeof fetch,
    });
    expect(report.status).toBe("unavailable");
    expect(report.warning).toMatch(/503/);
  });

  it("detects drift against the committed pin using a changed body", async () => {
    const changed = await loadFixture("drift-changed.swagger.json");
    const report = await checkOpenApiDrift({
      root,
      fetchImpl: (async () => new Response(changed.body, { status: 200 })) as typeof fetch,
    });
    expect(report.status).toBe("drift");
    expect(report.fetchedSha256).toBe(sha256Hex(changed.body));
    expect(report.pinnedSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.message).toContain("Human review required");
  });
});
