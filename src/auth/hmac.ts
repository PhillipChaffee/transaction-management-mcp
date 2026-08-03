import { createHmac } from "node:crypto";

import type { Credentials } from "../config/credentials.js";

/**
 * Format a UTC timestamp as ISO-8601 / RFC 3339 without fractional seconds.
 *
 * Matches `moment().utc().format()` from the official SkySlope authentication example.
 */
export function formatUtcTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Compute the base64 HMAC-SHA256 used for SkySlope Transaction Management login.
 *
 * Args:
 *   accessSecret: User access secret (HMAC key).
 *   clientId: Partner client id.
 *   clientSecret: Partner client secret.
 *   timestamp: UTC ISO/RFC3339 timestamp string included in the signed message.
 *
 * Returns:
 *   Base64-encoded HMAC digest.
 */
export function computeLoginHmac(
  accessSecret: string,
  clientId: string,
  clientSecret: string,
  timestamp: string,
): string {
  const message = `${clientId}:${clientSecret}:${timestamp}`;
  return createHmac("sha256", accessSecret).update(message).digest("base64");
}

/**
 * Build the `Authorization` header value: `ss <accessKey>:<hmac>`.
 */
export function buildAuthorizationHeader(accessKey: string, hmac: string): string {
  return `ss ${accessKey}:${hmac}`;
}

export type LoginAuthMaterial = {
  timestamp: string;
  authorizationHeader: string;
  hmac: string;
  body: {
    ClientId: string;
    ClientSecret: string;
  };
  headers: {
    Authorization: string;
    Timestamp: string;
    "Content-Type": "application/json";
  };
};

/**
 * Build login auth headers and JSON body from credentials and a clock reading.
 *
 * Pure and deterministic for a fixed `date`. Never logs credential values.
 */
export function buildLoginAuth(credentials: Credentials, date: Date): LoginAuthMaterial {
  const timestamp = formatUtcTimestamp(date);
  const hmac = computeLoginHmac(
    credentials.accessSecret,
    credentials.clientId,
    credentials.clientSecret,
    timestamp,
  );
  const authorizationHeader = buildAuthorizationHeader(credentials.accessKey, hmac);
  return {
    timestamp,
    authorizationHeader,
    hmac,
    body: {
      ClientId: credentials.clientId,
      ClientSecret: credentials.clientSecret,
    },
    headers: {
      Authorization: authorizationHeader,
      Timestamp: timestamp,
      "Content-Type": "application/json",
    },
  };
}
