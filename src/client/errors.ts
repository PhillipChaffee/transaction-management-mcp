/**
 * Safe upstream / MCP-facing error model for Transaction Management HTTP calls.
 *
 * Upstream errors expose only HTTP status, vendor code/message/errors, trace id,
 * and retry/ambiguous state. They never include response headers, HMAC material,
 * session tokens, raw body dumps, or credentials.
 */

export type UpstreamErrorDetails = {
  httpStatus: number;
  code?: string | null;
  message?: string;
  errors?: string[];
  traceId?: string;
  retryable: boolean;
  ambiguous: boolean;
};

export type McpToolErrorResult = {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: {
    httpStatus?: number;
    code?: string | null;
    message: string;
    errors?: string[];
    traceId?: string;
    retryable: boolean;
    ambiguous: boolean;
  };
};

export class UpstreamApiError extends Error {
  override readonly name = "UpstreamApiError";
  readonly details: UpstreamErrorDetails;

  constructor(details: UpstreamErrorDetails) {
    super(safeUpstreamMessage(details));
    this.details = details;
  }
}

export class AmbiguousCompletionError extends Error {
  override readonly name = "AmbiguousCompletionError";
  readonly ambiguous = true as const;
  readonly retryable = false as const;

  constructor(
    message = "Request completion is ambiguous; read the current resource state before retrying",
  ) {
    super(message);
  }
}

export class NetworkRequestError extends Error {
  override readonly name = "NetworkRequestError";
  readonly retryable: boolean;
  readonly ambiguous: boolean;

  constructor(message: string, options: { retryable?: boolean; ambiguous?: boolean } = {}) {
    super(message);
    this.retryable = options.retryable ?? false;
    this.ambiguous = options.ambiguous ?? false;
  }
}

export class SessionAuthError extends Error {
  override readonly name = "SessionAuthError";
  readonly httpStatus?: number;

  constructor(message: string, httpStatus?: number) {
    super(message);
    if (httpStatus !== undefined) {
      this.httpStatus = httpStatus;
    }
  }
}

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 502, 503]);

/**
 * Return whether an HTTP status is eligible for GET-side automatic retry.
 */
export function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status);
}

function safeUpstreamMessage(details: UpstreamErrorDetails): string {
  const vendorMessage = details.message?.trim();
  if (vendorMessage) {
    return vendorMessage;
  }
  if (details.errors && details.errors.length > 0) {
    return details.errors.join("; ");
  }
  return `Upstream request failed with HTTP ${details.httpStatus}`;
}

type VendorErrorBody = {
  code?: unknown;
  message?: unknown;
  errors?: unknown;
  Message?: unknown;
  Error?: unknown;
  traceId?: unknown;
  TraceId?: unknown;
  value?: unknown;
};

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Map an upstream HTTP error response into a safe `UpstreamApiError`.
 *
 * Only status, vendor code/message/errors, and trace id are retained from the body.
 */
export async function mapUpstreamError(
  response: Response,
  options: { ambiguous?: boolean } = {},
): Promise<UpstreamApiError> {
  const httpStatus = response.status;
  let code: string | null | undefined;
  let message: string | undefined;
  let errors: string[] | undefined;
  let traceId =
    asOptionalString(response.headers.get("x-trace-id")) ??
    asOptionalString(response.headers.get("traceid"));

  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await response.json()) as VendorErrorBody;
      const nested =
        body.value && typeof body.value === "object" ? (body.value as VendorErrorBody) : undefined;
      const source = nested ?? body;
      if (typeof source.code === "string" || source.code === null) {
        code = source.code;
      }
      message =
        asOptionalString(source.message) ??
        asOptionalString(source.Message) ??
        asOptionalString(source.Error);
      errors = asStringArray(source.errors);
      traceId =
        asOptionalString(source.traceId) ??
        asOptionalString(source.TraceId) ??
        asOptionalString(body.traceId) ??
        asOptionalString(body.TraceId) ??
        traceId;
    } else {
      // Drain non-JSON bodies without retaining content in the error.
      await response.arrayBuffer();
    }
  } catch {
    // Ignore parse failures; status alone is enough for a safe error.
  }

  const details: UpstreamErrorDetails = {
    httpStatus,
    retryable: isRetryableHttpStatus(httpStatus),
    ambiguous: options.ambiguous ?? false,
  };
  if (code !== undefined) {
    details.code = code;
  }
  if (message !== undefined) {
    details.message = message;
  }
  if (errors !== undefined) {
    details.errors = errors;
  }
  if (traceId !== undefined) {
    details.traceId = traceId;
  }
  return new UpstreamApiError(details);
}

/**
 * Convert a client/auth error into an MCP tool error result (`isError: true`).
 *
 * Reserved for binder use; JSON-RPC errors remain for unknown tools / invalid MCP input.
 */
export function toMcpToolError(error: unknown): McpToolErrorResult {
  if (error instanceof UpstreamApiError) {
    const structuredContent: McpToolErrorResult["structuredContent"] = {
      httpStatus: error.details.httpStatus,
      message: error.message,
      retryable: error.details.retryable,
      ambiguous: error.details.ambiguous,
    };
    if (error.details.code !== undefined) {
      structuredContent.code = error.details.code;
    }
    if (error.details.errors !== undefined) {
      structuredContent.errors = error.details.errors;
    }
    if (error.details.traceId !== undefined) {
      structuredContent.traceId = error.details.traceId;
    }
    return {
      isError: true,
      content: [{ type: "text", text: error.message }],
      structuredContent,
    };
  }

  if (error instanceof AmbiguousCompletionError) {
    return {
      isError: true,
      content: [{ type: "text", text: error.message }],
      structuredContent: {
        message: error.message,
        retryable: false,
        ambiguous: true,
      },
    };
  }

  if (error instanceof NetworkRequestError) {
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

  if (error instanceof SessionAuthError) {
    const structuredContent: McpToolErrorResult["structuredContent"] = {
      message: error.message,
      retryable: false,
      ambiguous: false,
    };
    if (error.httpStatus !== undefined) {
      structuredContent.httpStatus = error.httpStatus;
    }
    return {
      isError: true,
      content: [{ type: "text", text: error.message }],
      structuredContent,
    };
  }

  return {
    isError: true,
    content: [{ type: "text", text: "Request failed" }],
    structuredContent: {
      message: "Request failed",
      retryable: false,
      ambiguous: false,
    },
  };
}
