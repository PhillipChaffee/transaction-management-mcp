import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { allManifestToolNames, registerTools } from "../../src/binder/register.ts";
import { createRuntimeLimits } from "../../src/config/runtime-limits.ts";
import { createResolvedRuntimePolicy } from "../../src/config/runtime-policy.ts";
import { toolSchemas } from "../../src/generated/tool-schemas.ts";
import operationsManifest from "../../src/generated/operations.manifest.json" with { type: "json" };
import { createBinderHarness } from "./harness.ts";
import { mswServer } from "../msw/server.ts";

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
});
