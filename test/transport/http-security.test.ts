import { describe, expect, it } from "vitest";

import {
  bearerTokenMatches,
  isLoopbackHost,
  MIN_REMOTE_BEARER_BYTES,
  parseExactHostnames,
  parseExactOrigins,
  resolveHttpTransportConfig,
  timingSafeEqualString,
  validateExactOrigin,
} from "../../src/transport/http-security.ts";
import { SYNTHETIC_HTTP_BEARER } from "../helpers/synthetic-env.ts";

describe("timingSafeEqualString", () => {
  it("accepts equal strings and rejects unequal strings", () => {
    expect(timingSafeEqualString("abc", "abc")).toBe(true);
    expect(timingSafeEqualString("abc", "abd")).toBe(false);
    expect(timingSafeEqualString("abc", "ab")).toBe(false);
  });
});

describe("bearerTokenMatches", () => {
  it("matches Bearer tokens without logging", () => {
    expect(bearerTokenMatches(`Bearer ${SYNTHETIC_HTTP_BEARER}`, SYNTHETIC_HTTP_BEARER)).toBe(true);
    expect(bearerTokenMatches("Bearer wrong-token-value-here-xxxxx", SYNTHETIC_HTTP_BEARER)).toBe(
      false,
    );
    expect(bearerTokenMatches(undefined, SYNTHETIC_HTTP_BEARER)).toBe(false);
    expect(bearerTokenMatches("Basic abc", SYNTHETIC_HTTP_BEARER)).toBe(false);
  });
});

describe("resolveHttpTransportConfig", () => {
  it("defaults to loopback with required bearer", () => {
    const config = resolveHttpTransportConfig({
      SKYSLOPE_TM_HTTP_BEARER_TOKEN: "loopback-token",
    });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3000);
    expect(config.isLoopback).toBe(true);
    expect(isLoopbackHost(config.host)).toBe(true);
  });

  it("rejects non-loopback without remote opt-in, strong bearer, and origins", () => {
    expect(() =>
      resolveHttpTransportConfig({
        SKYSLOPE_TM_HTTP_HOST: "0.0.0.0",
        SKYSLOPE_TM_HTTP_BEARER_TOKEN: SYNTHETIC_HTTP_BEARER,
      }),
    ).toThrow(/ALLOW_REMOTE/);

    expect(() =>
      resolveHttpTransportConfig({
        SKYSLOPE_TM_HTTP_HOST: "0.0.0.0",
        SKYSLOPE_TM_HTTP_ALLOW_REMOTE: "true",
        SKYSLOPE_TM_HTTP_BEARER_TOKEN: "short-token",
        SKYSLOPE_TM_HTTP_ALLOWED_HOSTS: "mcp.example.com",
        SKYSLOPE_TM_HTTP_ALLOWED_ORIGINS: "https://example.com",
      }),
    ).toThrow(new RegExp(String(MIN_REMOTE_BEARER_BYTES)));

    expect(() =>
      resolveHttpTransportConfig({
        SKYSLOPE_TM_HTTP_HOST: "0.0.0.0",
        SKYSLOPE_TM_HTTP_ALLOW_REMOTE: "true",
        SKYSLOPE_TM_HTTP_BEARER_TOKEN: SYNTHETIC_HTTP_BEARER,
        SKYSLOPE_TM_HTTP_ALLOWED_HOSTS: "mcp.example.com",
      }),
    ).toThrow(/ALLOWED_ORIGINS/);

    expect(() =>
      resolveHttpTransportConfig({
        SKYSLOPE_TM_HTTP_HOST: "0.0.0.0",
        SKYSLOPE_TM_HTTP_ALLOW_REMOTE: "true",
        SKYSLOPE_TM_HTTP_BEARER_TOKEN: SYNTHETIC_HTTP_BEARER,
        SKYSLOPE_TM_HTTP_ALLOWED_ORIGINS: "https://example.com",
      }),
    ).toThrow(/ALLOWED_HOSTS/);
  });

  it("accepts remote config when all remote gates pass", () => {
    const config = resolveHttpTransportConfig({
      SKYSLOPE_TM_HTTP_HOST: "0.0.0.0",
      SKYSLOPE_TM_HTTP_ALLOW_REMOTE: "true",
      SKYSLOPE_TM_HTTP_BEARER_TOKEN: SYNTHETIC_HTTP_BEARER,
      SKYSLOPE_TM_HTTP_ALLOWED_HOSTS: "mcp.example.com,api.example.com",
      SKYSLOPE_TM_HTTP_ALLOWED_ORIGINS: "https://app.example.com,https://other.example.com:8443",
    });
    expect(config.isLoopback).toBe(false);
    expect(config.allowedOrigins).toEqual([
      "https://app.example.com",
      "https://other.example.com:8443",
    ]);
    expect(config.allowedHostnames).toEqual(["mcp.example.com", "api.example.com"]);
  });

  it("rejects malformed ports and hostnames", () => {
    expect(() =>
      resolveHttpTransportConfig({
        SKYSLOPE_TM_HTTP_BEARER_TOKEN: "loopback-token",
        SKYSLOPE_TM_HTTP_PORT: "3000x",
      }),
    ).toThrow(/PORT/);
    expect(() => parseExactHostnames("https://mcp.example.com")).toThrow(/Invalid hostname/);
  });
});

describe("exact origin validation", () => {
  it("parses and validates exact origins", () => {
    const origins = parseExactOrigins("https://app.example.com");
    expect(validateExactOrigin(undefined, origins).ok).toBe(true);
    expect(validateExactOrigin("https://app.example.com", origins).ok).toBe(true);
    expect(validateExactOrigin("https://evil.example.com", origins).ok).toBe(false);
  });
});
