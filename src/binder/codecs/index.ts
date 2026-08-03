import type { z } from "zod";

import { cancelResponseBody, readBytesWithCap } from "../../client/response-body.js";
import type { TransactionApiClient } from "../../client/transaction-api-client.js";
import type { RuntimeLimits } from "../../config/runtime-limits.js";
import type { ManifestOperation } from "../../manifest/types.js";
import { ToolExecutionError } from "../errors.js";
import { parseBulkItems } from "./bulk-stream.js";
import {
  BulkStreamOutputSchema,
  EmptyValueOutputSchema,
  NoContentOutputSchema,
  OctetStreamOutputSchema,
  ReplicaTimestampOutputSchema,
} from "./output-schemas.js";

export { parseBulkItems } from "./bulk-stream.js";

export type ToolInput = {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
};

export type ToolSuccessResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
};

type ZodSchema = z.ZodType<unknown>;

export type ExecuteOperationOptions = {
  operation: ManifestOperation;
  input: ToolInput;
  client: TransactionApiClient;
  limits: RuntimeLimits;
  /** Schema used to validate structuredContent (may be generated or codec-specific). */
  outputSchema: ZodSchema;
};

const PATH_PLACEHOLDER = /\{([^}]+)\}/g;

/**
 * Resolve the output schema for an operation, overriding generated schemas when the
 * codec normalizes a different structured shape.
 */
export function resolveOutputSchema(
  operation: ManifestOperation,
  generatedOutputSchema: ZodSchema,
): ZodSchema {
  switch (operation.outputCodec) {
    case "bulk-stream":
      return BulkStreamOutputSchema;
    case "octet-stream":
      return OctetStreamOutputSchema;
    case "replica-timestamp":
      return ReplicaTimestampOutputSchema;
    case "empty-value":
      return EmptyValueOutputSchema;
    case "no-content":
      return NoContentOutputSchema;
    case "json":
    case "cda":
      return generatedOutputSchema;
    case "base64-upload":
    case "query-write":
    case "no-body-write":
    case "open-body":
      // Input-only codec ids are never stored as outputCodec in the manifest.
      return generatedOutputSchema;
    default: {
      const _exhaustive: never = operation.outputCodec;
      return _exhaustive;
    }
  }
}

/**
 * Execute one manifest operation through the API client using codec rules.
 */
export async function executeOperation(
  options: ExecuteOperationOptions,
): Promise<ToolSuccessResult> {
  const { operation, input, client, limits, outputSchema } = options;
  const prepared = prepareRequest(operation, input, limits);
  const requestInit: Parameters<TransactionApiClient["request"]>[0] = {
    method: operation.method,
    path: prepared.path,
    parseAs: "response",
  };
  if (prepared.query !== undefined) {
    requestInit.query = prepared.query;
  }
  if (prepared.headers !== undefined) {
    requestInit.headers = prepared.headers;
  }
  if (prepared.body !== undefined) {
    requestInit.body = prepared.body;
  }
  const { data } = await client.request<Response>(requestInit);

  const structuredContent = await decodeResponse({
    operation,
    response: data,
    limits,
  });

  const validated = outputSchema.safeParse(structuredContent);
  if (!validated.success) {
    throw new ToolExecutionError("Response failed output schema validation");
  }

  const structured = validated.data as Record<string, unknown>;
  const text = formatSuccessText(operation, data.status, structured);
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
  };
}

type PreparedRequest = {
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  body?: string | null;
};

function buildPreparedRequest(
  path: string,
  options: {
    query?: Record<string, string | number | boolean | null | undefined>;
    headers?: Record<string, string>;
    body?: string | null;
  } = {},
): PreparedRequest {
  const prepared: PreparedRequest = { path };
  if (options.query !== undefined) {
    prepared.query = options.query;
  }
  if (options.headers !== undefined) {
    prepared.headers = options.headers;
  }
  if (options.body !== undefined) {
    prepared.body = options.body;
  }
  return prepared;
}

function jsonBodyRequest(
  path: string,
  query: Record<string, string | number | boolean | null | undefined> | undefined,
  body: string,
): PreparedRequest {
  return buildPreparedRequest(path, {
    ...(query !== undefined ? { query } : {}),
    headers: { "Content-Type": "application/json" },
    body,
  });
}

/**
 * Build path/query/body for the upstream request from MCP tool input.
 */
export function prepareRequest(
  operation: ManifestOperation,
  input: ToolInput,
  limits: RuntimeLimits,
): PreparedRequest {
  const path = substitutePath(operation.path, input.path);
  const query = normalizeQuery(input.query);

  switch (operation.inputCodec) {
    case "query-write":
      return buildPreparedRequest(path, {
        ...(query !== undefined ? { query } : {}),
        body: null,
      });
    case "no-body-write":
      return buildPreparedRequest(path, { body: null });
    case "open-body": {
      const body = requireJsonObjectBody(input.body);
      return jsonBodyRequest(path, query, JSON.stringify(body));
    }
    case "base64-upload": {
      const body = requireJsonObjectBody(input.body);
      validateBase64Upload(body, limits.maxUploadBytes);
      return jsonBodyRequest(path, query, JSON.stringify(body));
    }
    case "cda": {
      // Preserve documentData unknown/null exactly as provided.
      if (input.body === undefined) {
        return buildPreparedRequest(path, {
          ...(query !== undefined ? { query } : {}),
          body: null,
        });
      }
      if (input.body === null || typeof input.body !== "object" || Array.isArray(input.body)) {
        throw new ToolExecutionError("CDA body must be a JSON object");
      }
      return jsonBodyRequest(path, query, JSON.stringify(input.body));
    }
    case "json": {
      if (input.body === undefined) {
        return buildPreparedRequest(path, {
          ...(query !== undefined ? { query } : {}),
          body: null,
        });
      }
      return jsonBodyRequest(path, query, JSON.stringify(input.body));
    }
    case "bulk-stream":
    case "replica-timestamp":
    case "octet-stream":
    case "no-content":
    case "empty-value":
      throw new ToolExecutionError(`Invalid input codec ${operation.inputCodec}`);
    default: {
      const _exhaustive: never = operation.inputCodec;
      return _exhaustive;
    }
  }
}

/**
 * Substitute `{name}` path placeholders. Fails closed when a placeholder is missing.
 */
export function substitutePath(
  template: string,
  pathParams: Record<string, unknown> | undefined,
): string {
  return template.replace(PATH_PLACEHOLDER, (_match, name: string) => {
    const value = pathParams?.[name];
    if (value === undefined || value === null) {
      throw new ToolExecutionError(`Missing path parameter ${name}`);
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new ToolExecutionError(`Invalid path parameter ${name}`);
    }
    return encodeURIComponent(String(value));
  });
}

/**
 * Keep query keys literal (including dotted names) and pass integers unchanged.
 */
export function normalizeQuery(
  query: Record<string, unknown> | undefined,
): Record<string, string | number | boolean | null | undefined> | undefined {
  if (!query) {
    return undefined;
  }
  const result: Record<string, string | number | boolean | null | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }
    if (value === null) {
      result[key] = null;
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      // Impersonation and other integer query params keep exact number values.
      result[key] = value;
      continue;
    }
    throw new ToolExecutionError(`Unsupported query parameter type for ${key}`);
  }
  return result;
}

async function decodeResponse(options: {
  operation: ManifestOperation;
  response: Response;
  limits: RuntimeLimits;
}): Promise<Record<string, unknown>> {
  const { operation, response, limits } = options;

  switch (operation.outputCodec) {
    case "no-content": {
      // Do not await — some test transports hang on a drained cancel promise.
      void cancelResponseBody(response);
      if (response.status !== 204) {
        throw new ToolExecutionError(`Expected 204 No Content, received ${response.status}`);
      }
      return { success: true as const, status: 204 as const };
    }
    case "octet-stream":
      return decodeOctetStream(response, limits.maxBinaryOutputBytes);
    case "bulk-stream":
      return decodeBulkStream(response, limits);
    case "replica-timestamp":
      return decodeReplicaTimestamp(response, limits.maxStructuredOutputBytes);
    case "empty-value":
      return normalizeEmptyValue(
        await readJsonWithByteCap(response, limits.maxStructuredOutputBytes),
      );
    case "cda":
    case "json": {
      const json = await readJsonWithByteCap(response, limits.maxStructuredOutputBytes);
      if (json === null || typeof json !== "object" || Array.isArray(json)) {
        throw new ToolExecutionError("Expected a JSON object response");
      }
      return json as Record<string, unknown>;
    }
    case "base64-upload":
    case "query-write":
    case "no-body-write":
    case "open-body":
      throw new ToolExecutionError(`Invalid output codec ${operation.outputCodec}`);
    default: {
      const _exhaustive: never = operation.outputCodec;
      return _exhaustive;
    }
  }
}

/**
 * Normalize empty-value wrappers: preserve warnings/links and set absent value to null.
 */
export function normalizeEmptyValue(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ToolExecutionError("Expected a JSON object response");
  }
  const record = { ...(payload as Record<string, unknown>) };
  if (!("value" in record) || record.value === undefined) {
    record.value = null;
  }
  return record;
}

async function decodeReplicaTimestamp(
  response: Response,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const json = await readJsonWithByteCap(response, maxBytes);
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new ToolExecutionError("Replica timestamp response must be a JSON object");
  }
  return json as Record<string, unknown>;
}

async function decodeOctetStream(
  response: Response,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const mediaType = response.headers.get("content-type") ?? "application/octet-stream";
  const { bytes, truncated } = await readBytesWithCap(response, maxBytes, { awaitCancel: false });
  return {
    mediaType,
    base64: Buffer.from(bytes).toString("base64"),
    truncated,
  };
}

async function decodeBulkStream(
  response: Response,
  limits: RuntimeLimits,
): Promise<Record<string, unknown>> {
  const { bytes, truncated: byteTruncated } = await readBytesWithCap(
    response,
    limits.maxStructuredOutputBytes,
    { awaitCancel: false },
  );
  const text = new TextDecoder("utf-8").decode(bytes);
  const items = parseBulkItems(text, limits.maxBulkItems);
  const itemTruncated = items.truncated || byteTruncated;
  return {
    items: items.items,
    truncated: itemTruncated,
    returnedItems: items.items.length,
    limits: {
      maxBulkItems: limits.maxBulkItems,
      maxStructuredOutputBytes: limits.maxStructuredOutputBytes,
    },
  };
}

function requireJsonObjectBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ToolExecutionError("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/**
 * Validate base64Content when present. Never include the bytes in error messages.
 *
 * Decodes once, then performs canonical and size checks against that buffer.
 */
export function validateBase64Upload(body: Record<string, unknown>, maxBytes: number): void {
  const raw = body.base64Content;
  if (raw === undefined) {
    return;
  }
  if (typeof raw !== "string") {
    throw new ToolExecutionError("base64Content must be a string");
  }
  const decoded = decodeCanonicalBase64(raw);
  if (decoded === undefined) {
    throw new ToolExecutionError("base64Content is not valid base64");
  }
  if (decoded.byteLength > maxBytes) {
    throw new ToolExecutionError("Decoded upload exceeds MCP size limit");
  }
}

/**
 * Decode a base64 string once and verify the canonical encoding matches.
 *
 * Returns undefined when the value is not valid canonical base64.
 */
function decodeCanonicalBase64(value: string): Buffer | undefined {
  if (value.length === 0) {
    return Buffer.alloc(0);
  }
  if (value.length % 4 !== 0) {
    return undefined;
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(value, "base64");
    if (decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) {
      return undefined;
    }
    return decoded;
  } catch {
    return undefined;
  }
}

async function readJsonWithByteCap(response: Response, maxBytes: number): Promise<unknown> {
  const { bytes, truncated } = await readBytesWithCap(response, maxBytes, { awaitCancel: false });
  if (truncated) {
    throw new ToolExecutionError("Structured output exceeds MCP size limit");
  }
  if (bytes.byteLength === 0) {
    return null;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8").decode(bytes)) as unknown;
  } catch {
    throw new ToolExecutionError("Response is not valid JSON");
  }
}

function formatSuccessText(
  operation: ManifestOperation,
  status: number,
  structured: Record<string, unknown>,
): string {
  const method = operation.method.toUpperCase();
  let text = `${method} ${operation.path} succeeded (${status})`;

  if (operation.outputCodec === "bulk-stream") {
    const count = typeof structured.returnedItems === "number" ? structured.returnedItems : 0;
    text += `; ${count} item(s)`;
    if (structured.truncated === true) {
      text += "; truncated";
    }
    return text;
  }

  if (operation.outputCodec === "octet-stream") {
    if (structured.truncated === true) {
      text += "; truncated";
    }
    return text;
  }

  const itemCount = countListItems(structured);
  if (itemCount !== undefined) {
    text += `; ${itemCount} item(s)`;
  }
  return text;
}

function countListItems(structured: Record<string, unknown>): number | undefined {
  const value = structured.value;
  if (Array.isArray(value)) {
    return value.length;
  }
  if (value !== null && typeof value === "object") {
    const arrays = Object.values(value as Record<string, unknown>).filter((entry) =>
      Array.isArray(entry),
    );
    if (arrays.length === 1) {
      return (arrays[0] as unknown[]).length;
    }
  }
  return undefined;
}
