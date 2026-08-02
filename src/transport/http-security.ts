/**
 * HTTP authentication and origin helpers for the self-hosted Streamable HTTP transport.
 *
 * MCP bearer tokens are distinct from Transaction Management credentials and must
 * never be logged.
 */

import { timingSafeEqual } from "node:crypto";

export const MIN_REMOTE_BEARER_BYTES = 32;

/**
 * Compare two strings in roughly constant time.
 *
 * Length mismatches still short-circuit after a fixed dummy comparison so the
 * early return does not reveal the expected secret contents.
 */
export function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  const compareLength = Math.max(leftBuffer.length, rightBuffer.length, 1);
  const paddedLeft = Buffer.alloc(compareLength);
  const paddedRight = Buffer.alloc(compareLength);
  leftBuffer.copy(paddedLeft);
  rightBuffer.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && leftBuffer.length === rightBuffer.length;
}

/**
 * Extract a Bearer token from an Authorization header value.
 *
 * Returns undefined when the header is missing or not Bearer-shaped. Never logs.
 */
export function extractBearerToken(
  authorizationHeader: string | null | undefined,
): string | undefined {
  if (authorizationHeader === undefined || authorizationHeader === null) {
    return undefined;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
  return match?.[1];
}

/**
 * Return whether the presented bearer matches the configured token.
 */
export function bearerTokenMatches(
  authorizationHeader: string | null | undefined,
  expectedToken: string,
): boolean {
  const presented = extractBearerToken(authorizationHeader);
  if (presented === undefined) {
    return false;
  }
  return timingSafeEqualString(presented, expectedToken);
}

/**
 * Return whether a bind host is loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

/**
 * Parse a comma-separated exact-origin allowlist.
 *
 * Each entry must be an absolute origin (scheme + host [+ port]), with no path.
 */
export function parseExactOrigins(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const origins: string[] = [];
  for (const part of parts) {
    let url: URL;
    try {
      url = new URL(part);
    } catch {
      throw new Error(`Invalid exact origin in SKYSLOPE_TM_HTTP_ALLOWED_ORIGINS: ${part}`);
    }
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      throw new Error(
        `SKYSLOPE_TM_HTTP_ALLOWED_ORIGINS entries must be exact origins without path: ${part}`,
      );
    }
    origins.push(url.origin);
  }
  return origins;
}

/**
 * Parse a comma-separated hostname allowlist for Host-header validation.
 */
export function parseExactHostnames(raw: string | undefined): string[] {
  if (raw === undefined) {
    return [];
  }
  const hostnames = raw
    .split(",")
    .map((hostname) => hostname.trim().toLowerCase())
    .filter((hostname) => hostname.length > 0);
  for (const hostname of hostnames) {
    if (
      hostname.includes("://") ||
      hostname.includes("/") ||
      hostname.includes("@") ||
      /\s/.test(hostname)
    ) {
      throw new Error(`Invalid hostname in SKYSLOPE_TM_HTTP_ALLOWED_HOSTS: ${hostname}`);
    }
  }
  return [...new Set(hostnames)];
}

/**
 * Validate an Origin header against an exact-origin allowlist.
 *
 * Missing Origin is allowed (non-browser MCP clients). A present Origin must
 * match an allowlist entry exactly (scheme, host, and port).
 */
export function validateExactOrigin(
  originHeader: string | null | undefined,
  allowedOrigins: readonly string[],
): { ok: true } | { ok: false; status: 403; message: string } {
  if (originHeader === undefined || originHeader === null || originHeader.trim() === "") {
    return { ok: true };
  }
  const trimmed = originHeader.trim();
  let origin: string;
  try {
    origin = new URL(trimmed).origin;
  } catch {
    return { ok: false, status: 403, message: "Invalid Origin header" };
  }
  if (!allowedOrigins.includes(origin)) {
    return { ok: false, status: 403, message: "Origin not allowed" };
  }
  return { ok: true };
}

export type HttpTransportConfig = {
  host: string;
  port: number;
  bearerToken: string;
  allowRemote: boolean;
  allowedHostnames: readonly string[];
  allowedOrigins: readonly string[];
  isLoopback: boolean;
};

/**
 * Resolve and validate HTTP transport configuration from env.
 *
 * Loopback still requires a non-empty bearer. Non-loopback binding requires
 * ALLOW_REMOTE=true, a bearer of at least 32 bytes, and a non-empty exact
 * origin allowlist.
 */
export function resolveHttpTransportConfig(
  env: Record<string, string | undefined>,
): HttpTransportConfig {
  const host = (env.SKYSLOPE_TM_HTTP_HOST ?? "127.0.0.1").trim();
  if (host.length === 0) {
    throw new Error("SKYSLOPE_TM_HTTP_HOST must not be empty");
  }

  const portRaw = env.SKYSLOPE_TM_HTTP_PORT ?? "3000";
  if (!/^\d+$/.test(portRaw)) {
    throw new Error("SKYSLOPE_TM_HTTP_PORT must be an integer between 0 and 65535");
  }
  const port = Number(portRaw);
  // Port 0 is allowed for ephemeral test binds; production defaults to 3000.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("SKYSLOPE_TM_HTTP_PORT must be an integer between 0 and 65535");
  }

  const bearerToken = env.SKYSLOPE_TM_HTTP_BEARER_TOKEN ?? "";
  if (bearerToken.length === 0) {
    throw new Error("SKYSLOPE_TM_HTTP_BEARER_TOKEN is required for HTTP transport");
  }

  const allowRemote = parseEnvBoolean(env.SKYSLOPE_TM_HTTP_ALLOW_REMOTE, false);
  const loopback = isLoopbackHost(host);
  const allowedHostnames = parseExactHostnames(env.SKYSLOPE_TM_HTTP_ALLOWED_HOSTS);
  const allowedOrigins = parseExactOrigins(env.SKYSLOPE_TM_HTTP_ALLOWED_ORIGINS);

  if (!loopback) {
    if (!allowRemote) {
      throw new Error(
        "Non-loopback HTTP bind requires SKYSLOPE_TM_HTTP_ALLOW_REMOTE=true (TLS termination required)",
      );
    }
    if (Buffer.byteLength(bearerToken, "utf8") < MIN_REMOTE_BEARER_BYTES) {
      throw new Error(
        `Non-loopback HTTP bind requires SKYSLOPE_TM_HTTP_BEARER_TOKEN of at least ${MIN_REMOTE_BEARER_BYTES} bytes`,
      );
    }
    if (allowedOrigins.length === 0) {
      throw new Error(
        "Non-loopback HTTP bind requires SKYSLOPE_TM_HTTP_ALLOWED_ORIGINS with at least one exact origin",
      );
    }
    if (allowedHostnames.length === 0) {
      throw new Error(
        "Non-loopback HTTP bind requires SKYSLOPE_TM_HTTP_ALLOWED_HOSTS with at least one exact hostname",
      );
    }
  }

  return {
    host,
    port,
    bearerToken,
    allowRemote,
    allowedHostnames,
    allowedOrigins,
    isLoopback: loopback,
  };
}

function parseEnvBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new Error("SKYSLOPE_TM_HTTP_ALLOW_REMOTE must be true or false");
}
