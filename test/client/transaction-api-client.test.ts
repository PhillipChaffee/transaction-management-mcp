import { describe, expect, it, vi } from "vitest";

import { SessionManager } from "../../src/auth/session-manager.ts";
import {
  AmbiguousCompletionError,
  NetworkRequestError,
  UpstreamApiError,
} from "../../src/client/errors.ts";
import { TokenBucketRateLimiter } from "../../src/client/rate-limiter.ts";
import { TransactionApiClient } from "../../src/client/transaction-api-client.ts";
import type { Credentials } from "../../src/config/credentials.ts";

const credentials: Credentials = {
  clientId: "client-id",
  clientSecret: "client-secret",
  accessKey: "access-key",
  accessSecret: "access-secret",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Response(JSON.stringify(body), { ...init, headers });
}

function createHarness(fetchImpl: typeof fetch) {
  let now = Date.parse("2020-01-02T03:00:00Z");
  const clock = () => new Date(now);
  const sleep = vi.fn(async (ms: number) => {
    now += ms;
  });
  const sessionManager = new SessionManager({
    credentials,
    fetch: fetchImpl,
    clock,
  });
  const rateLimiter = new TokenBucketRateLimiter({
    now: () => now,
    sleep,
  });
  const client = new TransactionApiClient({
    sessionManager,
    rateLimiter,
    fetch: fetchImpl,
    clock,
    sleep,
    timeoutMs: 30_000,
  });
  return {
    client,
    sessionManager,
    rateLimiter,
    sleep,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

type FetchInput = Parameters<typeof fetch>[0];

describe("TransactionApiClient", () => {
  it("sends Session and Timestamp on API requests", async () => {
    const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/auth/login") {
        return jsonResponse({
          Session: "sess-abc",
          Expiration: "2020-01-02T05:00:00Z",
        });
      }
      expect(request.headers.get("Session")).toBe("sess-abc");
      expect(request.headers.get("Timestamp")).toBe("2020-01-02T03:00:00Z");
      return jsonResponse({ value: { ok: true } });
    });

    const { client } = createHarness(fetchMock as unknown as typeof fetch);
    const result = await client.request({ method: "GET", path: "/api/sales" });
    expect(result.data).toEqual({ value: { ok: true } });
  });

  it("retries GET at most twice for retryable statuses and respects Retry-After", async () => {
    const statuses = [503, 429, 200];
    let apiCalls = 0;
    const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/auth/login") {
        return jsonResponse({
          Session: "sess",
          Expiration: "2020-01-02T05:00:00Z",
        });
      }
      const status = statuses[apiCalls] ?? 200;
      apiCalls += 1;
      if (status === 429) {
        return new Response(null, {
          status,
          headers: { "Retry-After": "2" },
        });
      }
      if (status === 200) {
        return jsonResponse({ ok: true });
      }
      return new Response(null, { status });
    });

    const { client, sleep } = createHarness(fetchMock as unknown as typeof fetch);
    const result = await client.request({ method: "GET", path: "/api/sales" });
    expect(result.data).toEqual({ ok: true });
    expect(apiCalls).toBe(3);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("does not exceed two GET retries for persistent 503", async () => {
    let apiCalls = 0;
    const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/auth/login") {
        return jsonResponse({
          Session: "sess",
          Expiration: "2020-01-02T05:00:00Z",
        });
      }
      apiCalls += 1;
      return new Response(JSON.stringify({ message: "unavailable" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    });

    const { client } = createHarness(fetchMock as unknown as typeof fetch);
    await expect(client.request({ method: "GET", path: "/api/sales" })).rejects.toBeInstanceOf(
      UpstreamApiError,
    );
    expect(apiCalls).toBe(3); // initial + 2 retries
  });

  it("retries GET pre-response network failures at most twice", async () => {
    let apiCalls = 0;
    const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/auth/login") {
        return jsonResponse({
          Session: "sess",
          Expiration: "2020-01-02T05:00:00Z",
        });
      }
      apiCalls += 1;
      if (apiCalls < 3) {
        throw new TypeError("fetch failed");
      }
      return jsonResponse({ ok: true });
    });

    const { client } = createHarness(fetchMock as unknown as typeof fetch);
    await expect(client.request({ method: "GET", path: "/api/sales" })).resolves.toMatchObject({
      data: { ok: true },
    });
    expect(apiCalls).toBe(3);
  });

  it("never retries writes, including on retryable statuses", async () => {
    let apiCalls = 0;
    const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/auth/login") {
        return jsonResponse({
          Session: "sess",
          Expiration: "2020-01-02T05:00:00Z",
        });
      }
      apiCalls += 1;
      return new Response(JSON.stringify({ message: "busy" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    });

    const { client } = createHarness(fetchMock as unknown as typeof fetch);
    await expect(
      client.request({
        method: "POST",
        path: "/api/sales",
        body: JSON.stringify({ name: "x" }),
        headers: { "Content-Type": "application/json" },
      }),
    ).rejects.toBeInstanceOf(UpstreamApiError);
    expect(apiCalls).toBe(1);
  });

  it("refreshes session once on GET 401 and retries", async () => {
    let loginCalls = 0;
    let apiCalls = 0;
    const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/auth/login") {
        loginCalls += 1;
        return jsonResponse({
          Session: `sess-${loginCalls}`,
          Expiration: "2020-01-02T05:00:00Z",
        });
      }
      apiCalls += 1;
      if (apiCalls === 1) {
        expect(request.headers.get("Session")).toBe("sess-1");
        return new Response(JSON.stringify({ message: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      expect(request.headers.get("Session")).toBe("sess-2");
      return jsonResponse({ ok: true });
    });

    const { client } = createHarness(fetchMock as unknown as typeof fetch);
    await expect(client.request({ method: "GET", path: "/api/sales" })).resolves.toMatchObject({
      data: { ok: true },
    });
    expect(loginCalls).toBe(2);
    expect(apiCalls).toBe(2);
  });

  it("does not replay writes on 401", async () => {
    let apiCalls = 0;
    const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/auth/login") {
        return jsonResponse({
          Session: "sess",
          Expiration: "2020-01-02T05:00:00Z",
        });
      }
      apiCalls += 1;
      return new Response(JSON.stringify({ message: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });

    const { client } = createHarness(fetchMock as unknown as typeof fetch);
    await expect(
      client.request({
        method: "PUT",
        path: "/api/sales/1",
        body: JSON.stringify({ name: "x" }),
        headers: { "Content-Type": "application/json" },
      }),
    ).rejects.toBeInstanceOf(UpstreamApiError);
    expect(apiCalls).toBe(1);
  });

  it("returns ambiguous completion errors for write timeouts", async () => {
    const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/auth/login") {
        return jsonResponse({
          Session: "sess",
          Expiration: "2020-01-02T05:00:00Z",
        });
      }
      const error = new Error("Aborted");
      error.name = "AbortError";
      throw error;
    });

    const { client } = createHarness(fetchMock as unknown as typeof fetch);
    await expect(
      client.request({
        method: "POST",
        path: "/api/sales",
        body: JSON.stringify({ name: "x" }),
        headers: { "Content-Type": "application/json" },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(AmbiguousCompletionError);
      expect(String(error)).toMatch(/read the current resource state/i);
      expect(String(error)).not.toContain("client-secret");
      expect(String(error)).not.toContain("access-secret");
      expect(String(error)).not.toContain("sess");
      return true;
    });
  });

  it("exhausts GET network retries then fails safely", async () => {
    let apiCalls = 0;
    const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/auth/login") {
        return jsonResponse({
          Session: "sess",
          Expiration: "2020-01-02T05:00:00Z",
        });
      }
      apiCalls += 1;
      throw new TypeError("fetch failed");
    });

    const { client } = createHarness(fetchMock as unknown as typeof fetch);
    await expect(client.request({ method: "GET", path: "/api/sales" })).rejects.toBeInstanceOf(
      NetworkRequestError,
    );
    expect(apiCalls).toBe(3);
  });

  it("defers on x-ratelimit-reset without leaking headers into thrown errors", async () => {
    let apiCalls = 0;
    const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/auth/login") {
        return jsonResponse({
          Session: "sess",
          Expiration: "2020-01-02T05:00:00Z",
        });
      }
      apiCalls += 1;
      if (apiCalls === 1) {
        return new Response(JSON.stringify({ message: "rate limited" }), {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "x-ratelimit-reset": "2",
            Authorization: "ss should-not-leak",
          },
        });
      }
      return jsonResponse({ ok: true });
    });

    const { client, rateLimiter } = createHarness(fetchMock as unknown as typeof fetch);
    await client.request({ method: "GET", path: "/api/sales" });
    expect(apiCalls).toBe(2);
    expect(rateLimiter.deferUntilMs).toBeGreaterThan(0);
  });

  it("exposes openapi-fetch without blocking dynamic request dispatch", async () => {
    const fetchMock = vi.fn(async (input: FetchInput, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/auth/login") {
        return jsonResponse({
          Session: "sess",
          Expiration: "2020-01-02T05:00:00Z",
        });
      }
      return jsonResponse({ value: [] });
    });

    const { client } = createHarness(fetchMock as unknown as typeof fetch);
    const typed = client.createOpenApiClient();
    expect(typeof typed.GET).toBe("function");
    expect(typeof typed.request).toBe("function");

    const dynamic = await client.request({ method: "GET", path: "/api/custom/untyped" });
    expect(dynamic.data).toEqual({ value: [] });
  });
});
