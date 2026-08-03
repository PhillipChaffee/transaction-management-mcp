import { z } from "zod";

/**
 * Provider-specific Transaction Management credentials loaded from the environment.
 *
 * Values must never be logged, returned in tool schemas, or included in error messages.
 */
export const credentialsSchema = z.object({
  SKYSLOPE_TM_CLIENT_ID: z.string().min(1),
  SKYSLOPE_TM_CLIENT_SECRET: z.string().min(1),
  SKYSLOPE_TM_ACCESS_KEY: z.string().min(1),
  SKYSLOPE_TM_ACCESS_SECRET: z.string().min(1),
});

export type CredentialsEnv = z.infer<typeof credentialsSchema>;

export type Credentials = {
  clientId: string;
  clientSecret: string;
  accessKey: string;
  accessSecret: string;
};

/**
 * Load and validate Transaction Management credentials from an env-like object.
 *
 * Args:
 *   env: Mapping of environment variable names to values (defaults to `process.env`).
 *
 * Returns:
 *   Typed credentials suitable for HMAC login.
 *
 * Raises:
 *   ZodError: When any required credential is missing or empty.
 */
export function loadCredentials(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Credentials {
  const parsed = credentialsSchema.parse(env);
  return {
    clientId: parsed.SKYSLOPE_TM_CLIENT_ID,
    clientSecret: parsed.SKYSLOPE_TM_CLIENT_SECRET,
    accessKey: parsed.SKYSLOPE_TM_ACCESS_KEY,
    accessSecret: parsed.SKYSLOPE_TM_ACCESS_SECRET,
  };
}
