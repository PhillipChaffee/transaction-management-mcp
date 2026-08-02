import { describe, expect, it, vi } from "vitest";

import { SessionManager } from "../../src/auth/session-manager.ts";
import { SessionAuthError } from "../../src/client/errors.ts";
import type { Credentials } from "../../src/config/credentials.ts";

const credentials: Credentials = {
  clientId: "client-id",
  clientSecret: "client-secret",
  accessKey: "access-key",
  accessSecret: "access-secret",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SessionManager", () => {
  it("caches Session and Expiration from the login response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        Session: "session-1",
        Expiration: "2020-01-02T04:00:00Z",
      }),
    );
    const now = Date.parse("2020-01-02T03:00:00Z");
    const manager = new SessionManager({
      credentials,
      fetch: fetchMock as unknown as typeof fetch,
      clock: () => new Date(now),
      refreshSkewMs: 60_000,
    });

    const first = await manager.getSession();
    const second = await manager.getSession();

    expect(first.session).toBe("session-1");
    expect(first.expiration.toISOString()).toBe("2020-01-02T04:00:00.000Z");
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.skyslope.com/auth/login");
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")?.startsWith("ss access-key:")).toBe(true);
    expect(headers.get("Timestamp")).toBe("2020-01-02T03:00:00Z");
    expect(JSON.parse(String(init.body))).toEqual({
      ClientId: "client-id",
      ClientSecret: "client-secret",
    });
  });

  it("proactively refreshes before expiration using skew, not a hardcoded TTL", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          Session: "session-1",
          Expiration: "2020-01-02T03:10:00Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          Session: "session-2",
          Expiration: "2020-01-02T04:10:00Z",
        }),
      );

    let now = Date.parse("2020-01-02T03:00:00Z");
    const manager = new SessionManager({
      credentials,
      fetch: fetchMock as unknown as typeof fetch,
      clock: () => new Date(now),
      refreshSkewMs: 60_000,
    });

    expect((await manager.getSession()).session).toBe("session-1");
    now = Date.parse("2020-01-02T03:09:30Z"); // within 60s of expiration
    expect((await manager.getSession()).session).toBe("session-2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("forceRefresh bypasses a still-valid cache", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          Session: "session-1",
          Expiration: "2020-01-02T05:00:00Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          Session: "session-forced",
          Expiration: "2020-01-02T06:00:00Z",
        }),
      );
    const manager = new SessionManager({
      credentials,
      fetch: fetchMock as unknown as typeof fetch,
      clock: () => new Date("2020-01-02T03:00:00Z"),
    });

    expect((await manager.getSession()).session).toBe("session-1");
    expect((await manager.forceRefresh()).session).toBe("session-forced");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("single-flights concurrent refresh callers", async () => {
    let resolveLogin: ((value: Response) => void) | undefined;
    const loginGate = new Promise<Response>((resolve) => {
      resolveLogin = resolve;
    });
    const fetchMock = vi.fn().mockReturnValue(loginGate);
    const manager = new SessionManager({
      credentials,
      fetch: fetchMock as unknown as typeof fetch,
      clock: () => new Date("2020-01-02T03:00:00Z"),
    });

    const pending = Promise.all([
      manager.getSession(),
      manager.getSession(),
      manager.forceRefresh(),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveLogin?.(
      jsonResponse({
        Session: "shared-session",
        Expiration: "2020-01-02T04:00:00Z",
      }),
    );
    const results = await pending;
    expect(results.map((entry) => entry.session)).toEqual([
      "shared-session",
      "shared-session",
      "shared-session",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns safe auth errors with no credentials, HMAC, or session values", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("unauthorized secret-material", { status: 401 }));
    const manager = new SessionManager({
      credentials,
      fetch: fetchMock as unknown as typeof fetch,
      clock: () => new Date("2020-01-02T03:00:00Z"),
    });

    await expect(manager.getSession()).rejects.toBeInstanceOf(SessionAuthError);
    try {
      await manager.getSession();
    } catch (error) {
      expect(error).toBeInstanceOf(SessionAuthError);
      const text = String(error);
      expect(text).not.toContain("client-secret");
      expect(text).not.toContain("access-secret");
      expect(text).not.toContain("secret-material");
      expect(text).not.toMatch(/ss /);
    }
  });
});
