/**
 * MCP-side safety limits for tool input/output materialization.
 *
 * These are not claims about vendor API limits.
 */

export type RuntimeLimits = Readonly<{
  /** Maximum structured JSON response bytes before parse (1 MiB default). */
  maxStructuredOutputBytes: number;
  /** Maximum decoded binary response bytes (10 MiB default). */
  maxBinaryOutputBytes: number;
  /** Maximum decoded upload bytes for base64 inputs (25 MiB default). */
  maxUploadBytes: number;
  /** Maximum bulk-export items returned to the host (100 default). */
  maxBulkItems: number;
}>;

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {
  maxStructuredOutputBytes: 1 * 1024 * 1024,
  maxBinaryOutputBytes: 10 * 1024 * 1024,
  maxUploadBytes: 25 * 1024 * 1024,
  maxBulkItems: 100,
};

/** Absolute ceiling for structured JSON output overrides (16 MiB). */
export const MAX_STRUCTURED_OUTPUT_BYTES_CEILING = 16 * 1024 * 1024;
/** Absolute ceiling for binary output overrides (64 MiB). */
export const MAX_BINARY_OUTPUT_BYTES_CEILING = 64 * 1024 * 1024;
/** Absolute ceiling for upload overrides (64 MiB). */
export const MAX_UPLOAD_BYTES_CEILING = 64 * 1024 * 1024;
/** Absolute ceiling for bulk item overrides. */
export const MAX_BULK_ITEMS_CEILING = 10_000;
/** Absolute ceiling for inbound HTTP MCP request bodies (96 MiB). */
export const MAX_HTTP_REQUEST_BODY_BYTES_CEILING = 96 * 1024 * 1024;

const LIMIT_CEILINGS: Readonly<Record<keyof RuntimeLimits, number>> = {
  maxStructuredOutputBytes: MAX_STRUCTURED_OUTPUT_BYTES_CEILING,
  maxBinaryOutputBytes: MAX_BINARY_OUTPUT_BYTES_CEILING,
  maxUploadBytes: MAX_UPLOAD_BYTES_CEILING,
  maxBulkItems: MAX_BULK_ITEMS_CEILING,
};

/**
 * Return an immutable limits object, filling omitted fields from defaults.
 */
export function createRuntimeLimits(overrides: Partial<RuntimeLimits> = {}): RuntimeLimits {
  const limits: RuntimeLimits = {
    maxStructuredOutputBytes:
      overrides.maxStructuredOutputBytes ?? DEFAULT_RUNTIME_LIMITS.maxStructuredOutputBytes,
    maxBinaryOutputBytes:
      overrides.maxBinaryOutputBytes ?? DEFAULT_RUNTIME_LIMITS.maxBinaryOutputBytes,
    maxUploadBytes: overrides.maxUploadBytes ?? DEFAULT_RUNTIME_LIMITS.maxUploadBytes,
    maxBulkItems: overrides.maxBulkItems ?? DEFAULT_RUNTIME_LIMITS.maxBulkItems,
  };
  for (const name of Object.keys(limits) as Array<keyof RuntimeLimits>) {
    assertPositiveLimit(limits[name], name, LIMIT_CEILINGS[name]);
  }
  return limits;
}

/**
 * Compute a safe inbound HTTP MCP request body byte limit from runtime limits.
 *
 * Allows headroom for JSON envelopes and base64 expansion, capped by an absolute ceiling.
 */
export function httpRequestBodyLimitBytes(limits: RuntimeLimits): number {
  const encodedUploadWithEnvelope =
    Math.ceil((limits.maxUploadBytes * 4) / 3) + limits.maxStructuredOutputBytes;
  const configured = Math.max(
    encodedUploadWithEnvelope,
    limits.maxStructuredOutputBytes,
    limits.maxBinaryOutputBytes,
  );
  return Math.min(configured, MAX_HTTP_REQUEST_BODY_BYTES_CEILING);
}

/**
 * Parse a boolean environment or CLI flag value.
 *
 * Args:
 *   raw: Raw true/false (or 1/0) string.
 *   name: Flag or environment variable name used in validation errors.
 *
 * Returns:
 *   The parsed boolean.
 *
 * Raises:
 *   Error: If the value is not a recognized boolean token.
 */
export function parseEnvBoolean(raw: string, name: string): boolean {
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

/**
 * Parse a positive integer limit override from an environment string.
 *
 * Args:
 *   raw: Environment value to parse.
 *   name: Environment variable name used in validation errors.
 *   ceiling: Inclusive absolute maximum for this field.
 *
 * Returns:
 *   The parsed positive integer.
 *
 * Raises:
 *   Error: If the value is missing, non-integer, non-positive, or above the ceiling.
 */
export function parsePositiveSafeIntegerLimit(
  raw: string,
  name: string,
  ceiling: number = Number.MAX_SAFE_INTEGER,
): number {
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(trimmed);
  assertPositiveLimit(value, name, ceiling);
  return value;
}

function assertPositiveLimit(value: number, name: string, ceiling: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) {
    throw new Error(`${name} must be a positive safe integer at most ${ceiling}`);
  }
}
