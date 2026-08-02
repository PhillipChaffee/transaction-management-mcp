import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { allManifestToolNames, registerTools } from "../../src/binder/register.ts";
import { createRuntimeLimits } from "../../src/config/runtime-limits.ts";
import { resolveRuntimeConfig } from "../../src/config/resolve.ts";
import { createResolvedRuntimePolicy } from "../../src/config/runtime-policy.ts";
import operationsManifest from "../../src/generated/operations.manifest.json" with { type: "json" };
import { toolSchemas } from "../../src/generated/tool-schemas.ts";
import type { ManifestOperation } from "../../src/manifest/types.ts";
import { API_BASE_URL } from "../msw/handlers.ts";
import { mswServer } from "../msw/server.ts";
import { argsForTool, createBinderHarness } from "./harness.ts";

beforeAll(() => {
  mswServer.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  mswServer.resetHandlers();
});

afterAll(() => {
  mswServer.close();
});

describe("registerTools", () => {
  it("registers all 207 selected operations exactly once", async () => {
    const names = await allManifestToolNames();
    expect(names).toHaveLength(207);
    expect(new Set(names).size).toBe(207);

    const harness = await createBinderHarness({ selectedToolNames: names });
    try {
      expect(harness.registeredNames).toHaveLength(207);
      expect(harness.registeredNames).toEqual(names);

      const listed = await harness.client.listTools();
      expect(listed.tools).toHaveLength(207);
      const listedNames = listed.tools.map((tool) => tool.name).sort();
      expect(listedNames).toEqual([...names].sort());
    } finally {
      await harness.close();
    }
  });

  it("uses baked tool names, descriptions, and manifest annotations", async () => {
    const contact = operationsManifest.operations.find(
      (operation) => operation.operationId === "Contacts_GetContacts",
    );
    expect(contact).toBeDefined();

    const harness = await createBinderHarness({
      selectedToolNames: [contact!.toolName],
    });
    try {
      const listed = await harness.client.listTools();
      expect(listed.tools).toHaveLength(1);
      const tool = listed.tools[0]!;
      expect(tool.name).toBe("contacts_get_contacts");
      expect(tool.description).toBe(contact!.description);
      expect(tool.annotations).toMatchObject({
        openWorldHint: true,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    } finally {
      await harness.close();
    }
  });

  it("fails closed on unknown selected tool names", async () => {
    const { McpServer } = await import("@modelcontextprotocol/server");
    const { SessionManager } = await import("../../src/auth/session-manager.ts");
    const { TokenBucketRateLimiter } = await import("../../src/client/rate-limiter.ts");
    const { TransactionApiClient } = await import("../../src/client/transaction-api-client.ts");
    const { syntheticCredentials } = await import("./harness.ts");
    const { API_BASE_URL } = await import("../msw/handlers.ts");

    const server = new McpServer({ name: "x", version: "0" }, { capabilities: { tools: {} } });
    const client = new TransactionApiClient({
      sessionManager: new SessionManager({
        credentials: syntheticCredentials,
        baseUrl: API_BASE_URL,
      }),
      rateLimiter: new TokenBucketRateLimiter(),
      baseUrl: API_BASE_URL,
    });

    await expect(
      registerTools({
        server,
        client,
        policy: createResolvedRuntimePolicy({ selectedToolNames: ["not_a_real_tool"] }),
        limits: createRuntimeLimits(),
      }),
    ).rejects.toThrow(/Unknown selected tool name/);
  });

  it("has generated schemas for every manifest operation", () => {
    for (const operation of operationsManifest.operations) {
      expect(toolSchemas[operation.operationId as keyof typeof toolSchemas]).toBeDefined();
    }
  });

  it("preserves manifest annotations exactly on registered tools", async () => {
    const samples = operationsManifest.operations.filter((operation) =>
      [
        "Contacts_GetContacts",
        "Contacts_DeleteContact",
        "Contacts_CreateContact",
        "BulkExport_GetBulkExport",
      ].includes(operation.operationId),
    );
    const harness = await createBinderHarness({
      selectedToolNames: samples.map((operation) => operation.toolName),
    });
    try {
      const listed = await harness.client.listTools();
      for (const operation of samples) {
        const tool = listed.tools.find((entry) => entry.name === operation.toolName);
        expect(tool?.annotations).toEqual(operation.annotations);
      }
    } finally {
      await harness.close();
    }
  });

  it("registers only the resolved selected tool set", async () => {
    const resolved = resolveRuntimeConfig({
      operations: operationsManifest.operations as ManifestOperation[],
      argv: [],
      env: {},
    });
    const harness = await createBinderHarness({
      policy: resolved.policy,
      selectedToolNames: resolved.policy.selectedToolNames,
    });
    try {
      expect(harness.registeredNames).toHaveLength(30);
      const listed = await harness.client.listTools();
      expect(listed.tools).toHaveLength(30);
    } finally {
      await harness.close();
    }
  });

  it("does not automatically retry writes through the registered binder path", async () => {
    let hits = 0;
    mswServer.use(
      http.post(`${API_BASE_URL}/api/contacts`, () => {
        hits += 1;
        return HttpResponse.json({ message: "busy" }, { status: 503 });
      }),
    );

    const harness = await createBinderHarness({
      selectedToolNames: ["contacts_create_contact"],
    });
    try {
      const result = await harness.client.callTool({
        name: "contacts_create_contact",
        arguments: {
          body: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
        },
      });
      expect(result.isError).toBe(true);
      expect(hits).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it("blocks guessed tool names that are not registered", async () => {
    const harness = await createBinderHarness({
      selectedToolNames: ["contacts_get_contacts"],
    });
    try {
      await expect(
        harness.client.callTool({
          name: "contacts_delete_contact",
          arguments: argsForTool("contacts_delete_contact", { path: { contactGuid: "c-1" } }),
        }),
      ).rejects.toThrow();
    } finally {
      await harness.close();
    }
  });
});
