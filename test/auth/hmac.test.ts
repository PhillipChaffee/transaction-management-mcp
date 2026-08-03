import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildAuthorizationHeader,
  buildLoginAuth,
  computeLoginHmac,
  formatUtcTimestamp,
} from "../../src/auth/hmac.ts";
import type { Credentials } from "../../src/config/credentials.ts";

const credentials: Credentials = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  accessKey: "test-access-key",
  accessSecret: "test-access-secret",
};

const FIXED_TIMESTAMP = "2020-01-02T03:04:05Z";
const FIXED_DATE = new Date("2020-01-02T03:04:05.000Z");

/** Official construction: Base64(HMAC-SHA256(accessSecret, clientId:clientSecret:timestamp)). */
const OFFICIAL_VECTOR_HMAC = createHmac("sha256", credentials.accessSecret)
  .update(`${credentials.clientId}:${credentials.clientSecret}:${FIXED_TIMESTAMP}`)
  .digest("base64");

describe("hmac auth construction", () => {
  it("formats UTC timestamps as ISO/RFC3339 without fractional seconds", () => {
    expect(formatUtcTimestamp(FIXED_DATE)).toBe(FIXED_TIMESTAMP);
    expect(formatUtcTimestamp(new Date("2020-01-02T03:04:05.678Z"))).toBe("2020-01-02T03:04:05Z");
  });

  it("matches the official SkySlope HMAC vector", () => {
    expect(OFFICIAL_VECTOR_HMAC).toBe("81IHO1r7VVw++2Wug2RimuIzr9VY8lkOzNhsXJJQEuE=");
    expect(
      computeLoginHmac(
        credentials.accessSecret,
        credentials.clientId,
        credentials.clientSecret,
        FIXED_TIMESTAMP,
      ),
    ).toBe(OFFICIAL_VECTOR_HMAC);
  });

  it("builds Authorization as `ss <accessKey>:<hmac>`", () => {
    expect(buildAuthorizationHeader(credentials.accessKey, OFFICIAL_VECTOR_HMAC)).toBe(
      `ss ${credentials.accessKey}:${OFFICIAL_VECTOR_HMAC}`,
    );
  });

  it("uses official header and body casing", () => {
    const auth = buildLoginAuth(credentials, FIXED_DATE);

    expect(auth.timestamp).toBe(FIXED_TIMESTAMP);
    expect(auth.hmac).toBe(OFFICIAL_VECTOR_HMAC);
    expect(auth.authorizationHeader).toBe(`ss ${credentials.accessKey}:${OFFICIAL_VECTOR_HMAC}`);
    expect(auth.headers).toEqual({
      Authorization: `ss ${credentials.accessKey}:${OFFICIAL_VECTOR_HMAC}`,
      Timestamp: FIXED_TIMESTAMP,
      "Content-Type": "application/json",
    });
    expect(auth.body).toEqual({
      ClientId: credentials.clientId,
      ClientSecret: credentials.clientSecret,
    });
    expect(Object.keys(auth.body)).toEqual(["ClientId", "ClientSecret"]);
  });

  it("is deterministic for a fixed clock reading", () => {
    expect(buildLoginAuth(credentials, FIXED_DATE)).toEqual(
      buildLoginAuth(credentials, FIXED_DATE),
    );
  });
});
