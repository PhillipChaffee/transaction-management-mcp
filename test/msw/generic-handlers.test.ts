import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupServer } from "msw/node";

import operationsManifest from "../../src/generated/operations.manifest.json" with { type: "json" };
import type { ManifestOperation } from "../../src/manifest/types.ts";
import {
  API_BASE_URL,
  createGenericManifestHandlers,
  getCapturedRequests,
  openApiPathToMswPath,
  resetCapturedRequests,
  syntheticResponseFor,
} from "./handlers.ts";

const operations = operationsManifest.operations as ManifestOperation[];

const methodExamples: Array<{ method: string; find: (operation: ManifestOperation) => boolean }> = [
  {
    method: "GET",
    find: (operation) => operation.method.toLowerCase() === "get" && operation.path.includes("{"),
  },
  {
    method: "POST",
    find: (operation) => operation.method.toLowerCase() === "post",
  },
  {
    method: "PUT",
    find: (operation) => operation.method.toLowerCase() === "put" && operation.path.includes("{"),
  },
  {
    method: "PATCH",
    find: (operation) => operation.method.toLowerCase() === "patch",
  },
  {
    method: "DELETE",
    find: (operation) => operation.method.toLowerCase() === "delete",
  },
];

const server = setupServer(...createGenericManifestHandlers(operations));

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  server.resetHandlers();
  resetCapturedRequests();
});

afterAll(() => {
  server.close();
});

describe("manifest-driven generic MSW handlers", () => {
  it("covers all five HTTP methods with path substitution and request capture", async () => {
    for (const example of methodExamples) {
      const operation = operations.find(example.find);
      expect(operation, `missing ${example.method} sample`).toBeDefined();

      const concretePath = operation!.path.replace(/\{[^}]+\}/g, "sample-id");
      const init: RequestInit = {
        method: example.method,
        headers: {
          "Content-Type": "application/json",
          Session: "test-session-token",
        },
      };
      if (example.method !== "GET" && example.method !== "DELETE") {
        init.body = "{}";
      }
      const response = await fetch(`${API_BASE_URL}${concretePath}`, init);

      if (example.method === "DELETE") {
        expect(response.status).toBe(204);
      } else {
        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          value: { operationId: string; synthetic: boolean };
        };
        expect(body.value.synthetic).toBe(true);
        expect(body.value.operationId).toBe(operation!.operationId);
      }
    }

    const captured = getCapturedRequests();
    expect(captured.length).toBeGreaterThanOrEqual(5);
    const methods = new Set(captured.map((entry) => entry.method));
    for (const example of methodExamples) {
      expect(methods.has(example.method)).toBe(true);
    }
  });

  it("maps OpenAPI path templates to MSW params", () => {
    expect(openApiPathToMswPath("/api/contacts/{contactGuid}")).toBe("/api/contacts/:contactGuid");
    const synthetic = syntheticResponseFor(operations[0]!) as {
      value: { synthetic: boolean; operationId: string };
    };
    expect(synthetic.value).toMatchObject({
      synthetic: true,
      operationId: operations[0]!.operationId,
    });
  });

  it("fails closed on unhandled requests", async () => {
    await expect(fetch(`${API_BASE_URL}/api/definitely-not-a-real-path-xyz`)).rejects.toThrow();
  });
});
