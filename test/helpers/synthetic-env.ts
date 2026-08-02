import type { Credentials } from "../../src/config/credentials.ts";

export const SYNTHETIC_CREDENTIALS: Credentials = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  accessKey: "test-access-key",
  accessSecret: "test-access-secret",
};

export const SYNTHETIC_CREDENTIAL_ENV: Record<string, string> = {
  SKYSLOPE_TM_CLIENT_ID: SYNTHETIC_CREDENTIALS.clientId,
  SKYSLOPE_TM_CLIENT_SECRET: SYNTHETIC_CREDENTIALS.clientSecret,
  SKYSLOPE_TM_ACCESS_KEY: SYNTHETIC_CREDENTIALS.accessKey,
  SKYSLOPE_TM_ACCESS_SECRET: SYNTHETIC_CREDENTIALS.accessSecret,
};

export const SYNTHETIC_HTTP_BEARER = "test-bearer-token-at-least-32-bytes-long!!";

/**
 * Build a process env for spawning transport binaries under test.
 */
export function syntheticProcessEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "SKYSLOPE_TM_TRANSPORT") {
      // Avoid leaking host TM credentials into child processes under test.
      if (key.startsWith("SKYSLOPE_TM_")) {
        continue;
      }
      env[key] = value;
    }
  }
  Object.assign(env, SYNTHETIC_CREDENTIAL_ENV);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}
