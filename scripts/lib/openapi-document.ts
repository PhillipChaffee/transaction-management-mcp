import type { HttpMethod } from "./census.ts";
import { HTTP_METHODS } from "./census.ts";

export interface ReferenceObject {
  $ref: string;
}

export type SchemaObject = {
  type?: string | string[];
  format?: string;
  properties?: Record<string, SchemaObject | ReferenceObject>;
  required?: string[];
  items?: SchemaObject | ReferenceObject;
  enum?: unknown[];
  const?: unknown;
  allOf?: Array<SchemaObject | ReferenceObject>;
  oneOf?: Array<SchemaObject | ReferenceObject>;
  anyOf?: Array<SchemaObject | ReferenceObject>;
  nullable?: boolean;
  additionalProperties?: boolean | SchemaObject | ReferenceObject;
  description?: string;
  title?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  default?: unknown;
  // OpenAPI 3.1 / JSON Schema extras we may encounter
  [key: string]: unknown;
};

export interface ParameterObject {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  schema?: SchemaObject | ReferenceObject;
  description?: string;
}

export interface MediaTypeObject {
  schema?: SchemaObject | ReferenceObject;
}

export interface RequestBodyObject {
  required?: boolean;
  content?: Record<string, MediaTypeObject>;
  description?: string;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, MediaTypeObject>;
  headers?: Record<string, unknown>;
}

export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<ParameterObject | ReferenceObject>;
  requestBody?: RequestBodyObject | ReferenceObject;
  responses?: Record<string, ResponseObject | ReferenceObject>;
}

export interface PathItemObject {
  parameters?: Array<ParameterObject | ReferenceObject>;
  get?: OperationObject;
  put?: OperationObject;
  post?: OperationObject;
  delete?: OperationObject;
  options?: OperationObject;
  head?: OperationObject;
  patch?: OperationObject;
  trace?: OperationObject;
}

export interface OpenAPIDocument {
  openapi: string;
  info?: { title?: string; version?: string; description?: string };
  paths?: Record<string, PathItemObject>;
  components?: {
    schemas?: Record<string, SchemaObject | ReferenceObject>;
    parameters?: Record<string, ParameterObject | ReferenceObject>;
    requestBodies?: Record<string, RequestBodyObject | ReferenceObject>;
    responses?: Record<string, ResponseObject | ReferenceObject>;
  };
}

export interface ResolvedOperation {
  operationId: string;
  method: HttpMethod;
  path: string;
  tags: string[];
  operation: OperationObject;
  pathItem: PathItemObject;
}

export function isReferenceObject(value: unknown): value is ReferenceObject {
  return (
    typeof value === "object" &&
    value !== null &&
    "$ref" in value &&
    typeof (value as ReferenceObject).$ref === "string"
  );
}

export function resolveRef<T>(document: OpenAPIDocument, ref: string): T {
  if (!ref.startsWith("#/")) {
    throw new Error(`Unsupported external $ref: ${ref}`);
  }
  const parts = ref.slice(2).split("/");
  let current: unknown = document;
  for (const part of parts) {
    if (typeof current !== "object" || current === null || !(part in current)) {
      throw new Error(`Unresolved $ref: ${ref}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current as T;
}

export function deref<T extends object>(document: OpenAPIDocument, value: T | ReferenceObject): T {
  if (isReferenceObject(value)) {
    return resolveRef<T>(document, value.$ref);
  }
  return value;
}

export function listOperations(document: OpenAPIDocument): ResolvedOperation[] {
  const operations: ResolvedOperation[] = [];
  const paths = document.paths ?? {};
  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) {
        continue;
      }
      const operationId = operation.operationId?.trim();
      if (!operationId) {
        throw new Error(`Missing operationId for ${method.toUpperCase()} ${path}`);
      }
      operations.push({
        operationId,
        method,
        path,
        tags: operation.tags ?? [],
        operation,
        pathItem,
      });
    }
  }
  operations.sort((a, b) => {
    if (a.path !== b.path) {
      return a.path.localeCompare(b.path);
    }
    return a.method.localeCompare(b.method);
  });
  return operations;
}

export function deriveApiVersion(path: string, tags: readonly string[]): "v1" | "v2" {
  if (/\/v2(\/|$)/i.test(path) || tags.some((tag) => /\bv2\b/i.test(tag))) {
    return "v2";
  }
  return "v1";
}

export function primaryTag(tags: readonly string[]): string {
  return tags[0] ?? "untagged";
}

export function collectParameters(
  document: OpenAPIDocument,
  pathItem: PathItemObject,
  operation: OperationObject,
): ParameterObject[] {
  const combined = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
  return combined.map((parameter) => deref<ParameterObject>(document, parameter));
}

export function successStatusCodes(responses: Record<string, unknown> | undefined): string[] {
  if (!responses) {
    return [];
  }
  return Object.keys(responses)
    .filter((status) => status === "default" || /^2\d\d$/.test(status))
    .filter((status) => status !== "default")
    .sort();
}
