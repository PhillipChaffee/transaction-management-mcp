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

/** Inclusive upper bound for runtime limit overrides (JS safe integer). */
export const MAX_RUNTIME_LIMIT_VALUE = Number.MAX_SAFE_INTEGER;

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
  for (const [name, value] of Object.entries(limits)) {
    assertPositiveSafeInteger(value, name);
  }
  return limits;
}

/**
 * Parse a positive safe integer limit override from an environment string.
 *
 * Args:
 *   raw: Environment value to parse.
 *   name: Environment variable name used in validation errors.
 *
 * Returns:
 *   The parsed positive integer.
 *
 * Raises:
 *   Error: If the value is missing, non-integer, non-positive, or unsafe.
 */
export function parsePositiveSafeIntegerLimit(raw: string, name: string): number {
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const value = Number(trimmed);
  assertPositiveSafeInteger(value, name);
  return value;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RUNTIME_LIMIT_VALUE) {
    throw new Error(`${name} must be a positive safe integer at most ${MAX_RUNTIME_LIMIT_VALUE}`);
  }
}
