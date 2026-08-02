import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import * as registerModule from "../../src/binder/register.ts";
import { createTransactionManagementServer } from "../../src/server.ts";
import { API_BASE_URL, getCapturedRequests, resetCapturedRequests } from "../msw/handlers.ts";
import { mswServer } from "../msw/server.ts";
import { SYNTHETIC_CREDENTIAL_ENV, SYNTHETIC_CREDENTIALS } from "../helpers/synthetic-env.ts";

beforeAll(() => {
  mswServer.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  mswServer.resetHandlers();
  resetCapturedRequests();
  vi.restoreAllMocks();
});

afterAll(() => {
  mswServer.close();
});

describe("createTransactionManagementServer", () => {
  it("registers 30 tools by default and shares one policy object with the registrar", async () => {
    const registerSpy = vi.spyOn(registerModule, "registerTools");

    const handle = await createTransactionManagementServer({
      env: SYNTHETIC_CREDENTIAL_ENV,
      credentials: SYNTHETIC_CREDENTIALS,
      baseUrl: API_BASE_URL,
      argv: [],
    });

    try {
      expect(handle.registeredNames).toHaveLength(30);
      expect(handle.policy.selectedToolNames.size).toBe(30);
      expect(registerSpy).toHaveBeenCalled();
      const firstCall = registerSpy.mock.calls[0]?.[0];
      expect(firstCall?.policy).toBe(handle.policy);
      expect(firstCall?.limits).toBe(handle.limits);

      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "server-factory-test", version: "0.0.0" });
      await Promise.all([handle.server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        resetCapturedRequests();
        const listed = await client.listTools();
        expect(listed.tools).toHaveLength(30);
        expect(getCapturedRequests()).toHaveLength(0);
      } finally {
        await client.close();
      }
    } finally {
      await handle.server.close();
    }
  });

  it("registers all 91 reads with toolsets all and allow all", async () => {
    const handle = await createTransactionManagementServer({
      env: {
        ...SYNTHETIC_CREDENTIAL_ENV,
        SKYSLOPE_TM_TOOLSETS: "all",
        SKYSLOPE_TM_ALLOW: "all",
      },
      credentials: SYNTHETIC_CREDENTIALS,
      baseUrl: API_BASE_URL,
      argv: [],
    });
    try {
      expect(handle.registeredNames).toHaveLength(91);
      expect(handle.policy.readWrite).toBe(false);
    } finally {
      await handle.server.close();
    }
  });

  it("registers all 207 tools with full write opt-in", async () => {
    const handle = await createTransactionManagementServer({
      env: {
        ...SYNTHETIC_CREDENTIAL_ENV,
        SKYSLOPE_TM_TOOLSETS: "all",
        SKYSLOPE_TM_READ_WRITE: "true",
        SKYSLOPE_TM_ALLOW: "all",
      },
      credentials: SYNTHETIC_CREDENTIALS,
      baseUrl: API_BASE_URL,
      argv: [],
    });
    try {
      expect(handle.registeredNames).toHaveLength(207);
      expect(handle.policy.readWrite).toBe(true);
      expect(handle.policy.grantedCapabilities.size).toBe(6);
    } finally {
      await handle.server.close();
    }
  });

  it("surfaces credential failures without secret values", async () => {
    await expect(
      createTransactionManagementServer({
        env: {
          SKYSLOPE_TM_CLIENT_ID: "id",
          SKYSLOPE_TM_CLIENT_SECRET: "secret-value-should-not-appear",
          SKYSLOPE_TM_ACCESS_KEY: "key",
        },
      }),
    ).rejects.toThrow(/Invalid or missing Transaction Management credentials/);

    try {
      await createTransactionManagementServer({
        env: {
          SKYSLOPE_TM_CLIENT_ID: "id",
          SKYSLOPE_TM_CLIENT_SECRET: "secret-value-should-not-appear",
          SKYSLOPE_TM_ACCESS_KEY: "key",
        },
      });
      expect.unreachable();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).not.toContain("secret-value-should-not-appear");
    }
  });
});
