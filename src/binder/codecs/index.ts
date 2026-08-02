import type { z } from "zod";

import type { TransactionApiClient } from "../../client/transaction-api-client.js";
import type { RuntimeLimits } from "../../config/runtime-limits.js";
import { ToolExecutionError } from "../errors.js";
import {
  BulkStreamOutputSchema,
  EmptyValueOutputSchema,
  NoContentOutputSchema,
  OctetStreamOutputSchema,
  ReplicaTimestampOutputSchema,
} from "./output-schemas.js";

export type CodecId =
  | "base64-upload"
  | "cda"
  | "bulk-stream"
  | "replica-timestamp"
  | "octet-stream"
  | "no-content"
  | "query-write"
  | "no-body-write"
  | "open-body"
  | "empty-value"
  | "json";

export type RiskTier = "read" | "ordinary" | "destructive" | "financial" | "admin" | "binary-io";

export type ManifestOperation = {
  operationId: string;
  toolName: string;
  method: string;
  path: string;
  primaryToolset: string;
  riskTier: RiskTier;
  capabilities: readonly string[];
  inputCodec: CodecId;
  outputCodec: CodecId;
  description: string;
  annotations: {
    openWorldHint: boolean;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
};

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
    case "no-content":
      return { success: true as const, status: 204 as const };
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
  const { bytes, truncated } = await readBytesWithCap(response, maxBytes);
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

/**
 * Parse vendor bulk payloads: a JSON array, or comma/newline-separated JSON values.
 * Stops after maxItems complete values.
 */
export function parseBulkItems(
  text: string,
  maxItems: number,
): { items: unknown[]; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { items: [], truncated: false };
  }

  if (trimmed.startsWith("[")) {
    return parseJsonArrayPrefix(trimmed, maxItems);
  }

  return parseCommaNewlineValues(trimmed, maxItems);
}

function parseJsonArrayPrefix(
  text: string,
  maxItems: number,
): { items: unknown[]; truncated: boolean } {
  const items: unknown[] = [];
  let i = 1; // skip '['
  let truncated = false;

  while (i < text.length && items.length < maxItems) {
    while (i < text.length && /[\s,]/.test(text[i]!)) {
      i += 1;
    }
    if (i >= text.length) {
      break;
    }
    if (text[i] === "]") {
      break;
    }
    const parsed = readJsonValueAt(text, i);
    if (!parsed) {
      truncated = true;
      break;
    }
    items.push(parsed.value);
    i = parsed.end;
  }

  if (items.length >= maxItems) {
    // More complete items may remain after the cap.
    while (i < text.length && /[\s,]/.test(text[i]!)) {
      i += 1;
    }
    if (i < text.length && text[i] !== "]") {
      truncated = true;
    }
  } else if (!text.includes("]", i)) {
    // Stream ended mid-array without a closing bracket after the last item.
    truncated = truncated || looksIncomplete(text);
  }

  return { items, truncated };
}

function parseCommaNewlineValues(
  text: string,
  maxItems: number,
): { items: unknown[]; truncated: boolean } {
  const items: unknown[] = [];
  let i = 0;
  let truncated = false;

  while (i < text.length && items.length < maxItems) {
    while (i < text.length && /[\s,]/.test(text[i]!)) {
      i += 1;
    }
    if (i >= text.length) {
      break;
    }
    const parsed = readJsonValueAt(text, i);
    if (!parsed) {
      truncated = true;
      break;
    }
    items.push(parsed.value);
    i = parsed.end;
  }

  if (items.length >= maxItems) {
    while (i < text.length && /[\s,]/.test(text[i]!)) {
      i += 1;
    }
    if (i < text.length) {
      truncated = true;
    }
  }

  return { items, truncated };
}

function readJsonValueAt(text: string, start: number): { value: unknown; end: number } | undefined {
  const slice = text.slice(start);
  try {
    // Use JSON.parse on progressively longer complete-looking prefixes via end scan.
    const end = findJsonValueEnd(text, start);
    if (end === undefined) {
      return undefined;
    }
    const value = JSON.parse(text.slice(start, end)) as unknown;
    return { value, end };
  } catch {
    void slice;
    return undefined;
  }
}

function findJsonValueEnd(text: string, start: number): number | undefined {
  const first = text[start];
  if (first === undefined) {
    return undefined;
  }

  if (first === '"') {
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        return i + 1;
      }
      i += 1;
    }
    return undefined;
  }

  if (first === "{" || first === "[") {
    const open = first;
    const close = first === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]!;
      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === open) {
        depth += 1;
      } else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          return i + 1;
        }
      }
    }
    return undefined;
  }

  // number / literal
  let i = start;
  while (i < text.length && !/[\s,\]}]/.test(text[i]!)) {
    i += 1;
  }
  if (i === start) {
    return undefined;
  }
  return i;
}

function looksIncomplete(text: string): boolean {
  const open = (text.match(/\[/g) ?? []).length;
  const close = (text.match(/\]/g) ?? []).length;
  return open > close;
}

function requireJsonObjectBody(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ToolExecutionError("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/**
 * Validate base64Content when present. Never include the bytes in error messages.
 */
export function validateBase64Upload(body: Record<string, unknown>, maxBytes: number): void {
  const raw = body.base64Content;
  if (raw === undefined) {
    return;
  }
  if (typeof raw !== "string") {
    throw new ToolExecutionError("base64Content must be a string");
  }
  if (!isBase64(raw)) {
    throw new ToolExecutionError("base64Content is not valid base64");
  }
  const decoded = Buffer.from(raw, "base64");
  if (decoded.byteLength > maxBytes) {
    throw new ToolExecutionError("Decoded upload exceeds MCP size limit");
  }
}

function isBase64(value: string): boolean {
  if (value.length === 0) {
    return true;
  }
  if (value.length % 4 !== 0) {
    return false;
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return false;
  }
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "");
  } catch {
    return false;
  }
}

async function readJsonWithByteCap(response: Response, maxBytes: number): Promise<unknown> {
  const { bytes, truncated } = await readBytesWithCap(response, maxBytes);
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

async function readBytesWithCap(
  response: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      return { bytes: buffer.slice(0, maxBytes), truncated: true };
    }
    return { bytes: buffer, truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      if (total >= maxBytes) {
        truncated = true;
        break;
      }
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        total += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    // Do not await cancel — some test transports hang on a drained cancel promise.
    void reader.cancel().catch(() => undefined);
  }

  const bytes = concatBytes(chunks, total);
  return { bytes, truncated };
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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
