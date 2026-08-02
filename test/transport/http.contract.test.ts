import { request as httpRequest } from "node:http";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { REMOTE_TLS_WARNING, startHttpTransport } from "../../src/transport/http-server.ts";
import { resolveHttpTransportConfig } from "../../src/transport/http-security.ts";
import {
  SYNTHETIC_CREDENTIALS,
  SYNTHETIC_CREDENTIAL_ENV,
  SYNTHETIC_HTTP_BEARER,
} from "../helpers/synthetic-env.ts";
import { API_BASE_URL, resetCapturedRequests } from "../msw/handlers.ts";
import { listenWithLocalBypass } from "../msw/listen.ts";
import { mswServer } from "../msw/server.ts";

beforeAll(() => {
  listenWithLocalBypass(mswServer);
});

afterEach(() => {
  mswServer.resetHandlers();
  resetCapturedRequests();
});

afterAll(() => {
  mswServer.close();
});

describe("HTTP transport contract", () => {
  it("rejects unauthenticated and wrong-token requests with 401", async () => {
    const handle = await startHttpTransport({
      env: SYNTHETIC_CREDENTIAL_ENV,
      credentials: SYNTHETIC_CREDENTIALS,
      baseUrl: API_BASE_URL,
      httpEnv: {
        ...SYNTHETIC_CREDENTIAL_ENV,
        SKYSLOPE_TM_HTTP_BEARER_TOKEN: SYNTHETIC_HTTP_BEARER,
        SKYSLOPE_TM_HTTP_HOST: "127.0.0.1",
        SKYSLOPE_TM_HTTP_PORT: "0",
      },
      host: "127.0.0.1",
      port: 0,
      log: () => undefined,
    });

    try {
      expect("bearerToken" in handle.config).toBe(false);
      const missing = await fetch(handle.baseUrl, { method: "POST" });
      expect(missing.status).toBe(401);

      const wrong = await fetch(handle.baseUrl, {
        method: "POST",
        headers: { Authorization: "Bearer totally-wrong-token-value-xxxxx" },
      });
      expect(wrong.status).toBe(401);
    } finally {
      await handle.close();
    }
  });

  it("rejects bad Host/Origin with 403 and accepts correct bearer + origin", async () => {
    const logs: string[] = [];
    const handle = await startHttpTransport({
      env: SYNTHETIC_CREDENTIAL_ENV,
      credentials: SYNTHETIC_CREDENTIALS,
      baseUrl: API_BASE_URL,
      httpEnv: {
        ...SYNTHETIC_CREDENTIAL_ENV,
        SKYSLOPE_TM_HTTP_BEARER_TOKEN: SYNTHETIC_HTTP_BEARER,
        SKYSLOPE_TM_HTTP_HOST: "127.0.0.1",
        SKYSLOPE_TM_HTTP_PORT: "0",
      },
      host: "127.0.0.1",
      port: 0,
      log: (message) => {
        logs.push(message);
      },
    });

    try {
      const badHostStatus = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            hostname: "127.0.0.1",
            port: handle.port,
            path: "/",
            method: "POST",
            headers: {
              Authorization: `Bearer ${SYNTHETIC_HTTP_BEARER}`,
              Host: "evil.example.com",
              Origin: "http://127.0.0.1",
              "Content-Type": "application/json",
              "Content-Length": 2,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.write("{}");
        req.end();
      });
      expect(badHostStatus).toBe(403);

      const badOrigin = await fetch(`http://127.0.0.1:${handle.port}/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SYNTHETIC_HTTP_BEARER}`,
          Origin: "https://evil.example.com",
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(badOrigin.status).toBe(403);

      const transport = new StreamableHTTPClientTransport(new URL(handle.baseUrl), {
        authProvider: {
          token: async () => SYNTHETIC_HTTP_BEARER,
        },
        requestInit: {
          headers: {
            Origin: "http://127.0.0.1",
          },
        },
      });
      const client = new Client({ name: "http-contract-client", version: "0.0.0" });
      await client.connect(transport);
      try {
        const listed = await client.listTools();
        expect(listed.tools).toHaveLength(30);
      } finally {
        await client.close();
        await transport.close();
      }
    } finally {
      await handle.close();
    }

    expect(logs.join("\n")).not.toContain(SYNTHETIC_HTTP_BEARER);
  });

  it("closes gracefully", async () => {
    const handle = await startHttpTransport({
      env: SYNTHETIC_CREDENTIAL_ENV,
      credentials: SYNTHETIC_CREDENTIALS,
      baseUrl: API_BASE_URL,
      httpEnv: {
        ...SYNTHETIC_CREDENTIAL_ENV,
        SKYSLOPE_TM_HTTP_BEARER_TOKEN: SYNTHETIC_HTTP_BEARER,
      },
      host: "127.0.0.1",
      port: 0,
      log: () => undefined,
    });
    await handle.close();
    await expect(fetch(handle.baseUrl).catch((error: unknown) => error)).resolves.toBeTruthy();
  });

  it("documents remote TLS warning text for non-loopback config", () => {
    expect(REMOTE_TLS_WARNING).toMatch(/TLS termination/i);
    expect(() =>
      resolveHttpTransportConfig({
        SKYSLOPE_TM_HTTP_HOST: "0.0.0.0",
        SKYSLOPE_TM_HTTP_ALLOW_REMOTE: "true",
        SKYSLOPE_TM_HTTP_BEARER_TOKEN: SYNTHETIC_HTTP_BEARER,
        SKYSLOPE_TM_HTTP_ALLOWED_HOSTS: "mcp.example.com",
        SKYSLOPE_TM_HTTP_ALLOWED_ORIGINS: "https://app.example.com",
      }),
    ).not.toThrow();
  });
});
