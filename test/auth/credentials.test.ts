import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { loadCredentials } from "../../src/config/credentials.ts";

const validEnv = {
  SKYSLOPE_TM_CLIENT_ID: "client-id",
  SKYSLOPE_TM_CLIENT_SECRET: "client-secret",
  SKYSLOPE_TM_ACCESS_KEY: "access-key",
  SKYSLOPE_TM_ACCESS_SECRET: "access-secret",
};

describe("loadCredentials", () => {
  it("loads typed credentials from an env object", () => {
    expect(loadCredentials(validEnv)).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      accessKey: "access-key",
      accessSecret: "access-secret",
    });
  });

  it("rejects missing or empty values without embedding secrets in the schema shape", () => {
    expect(() => loadCredentials({})).toThrow(ZodError);
    expect(() =>
      loadCredentials({
        ...validEnv,
        SKYSLOPE_TM_ACCESS_SECRET: "",
      }),
    ).toThrow(ZodError);

    try {
      loadCredentials({
        ...validEnv,
        SKYSLOPE_TM_CLIENT_SECRET: "",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain("client-secret");
      expect(serialized).not.toContain("access-secret");
    }
  });
});
