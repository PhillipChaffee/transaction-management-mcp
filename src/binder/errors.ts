/**
 * Safe binder-side execution errors surfaced as MCP tool results (`isError: true`).
 *
 * Messages must never include request bodies, base64 payloads, credentials, or
 * raw upstream dumps.
 */

export class ToolExecutionError extends Error {
  override readonly name = "ToolExecutionError";
  readonly retryable: boolean;
  readonly ambiguous: boolean;

  constructor(message: string, options: { retryable?: boolean; ambiguous?: boolean } = {}) {
    super(message);
    this.retryable = options.retryable ?? false;
    this.ambiguous = options.ambiguous ?? false;
  }
}

export type BinderToolErrorResult = {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: {
    message: string;
    retryable: boolean;
    ambiguous: boolean;
  };
};

/**
 * Convert a binder execution error into an MCP tool error result.
 */
export function toBinderToolError(error: ToolExecutionError): BinderToolErrorResult {
  return {
    isError: true,
    content: [{ type: "text", text: error.message }],
    structuredContent: {
      message: error.message,
      retryable: error.retryable,
      ambiguous: error.ambiguous,
    },
  };
}
