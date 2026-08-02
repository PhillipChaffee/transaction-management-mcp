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

/**
 * Return an immutable limits object, filling omitted fields from defaults.
 */
export function createRuntimeLimits(overrides: Partial<RuntimeLimits> = {}): RuntimeLimits {
  return {
    maxStructuredOutputBytes:
      overrides.maxStructuredOutputBytes ?? DEFAULT_RUNTIME_LIMITS.maxStructuredOutputBytes,
    maxBinaryOutputBytes:
      overrides.maxBinaryOutputBytes ?? DEFAULT_RUNTIME_LIMITS.maxBinaryOutputBytes,
    maxUploadBytes: overrides.maxUploadBytes ?? DEFAULT_RUNTIME_LIMITS.maxUploadBytes,
    maxBulkItems: overrides.maxBulkItems ?? DEFAULT_RUNTIME_LIMITS.maxBulkItems,
  };
}
