import type { CodecId, HttpMethod } from "./census.ts";
import type {
  OpenAPIDocument,
  ParameterObject,
  RequestBodyObject,
  ResolvedOperation,
  ResponseObject,
  SchemaObject,
} from "./openapi-document.ts";
import {
  collectParameters,
  deref,
  isReferenceObject,
  successStatusCodes,
} from "./openapi-document.ts";

function mediaTypes(
  content: Record<string, { schema?: SchemaObject | { $ref: string } }> | undefined,
): string[] {
  return content ? Object.keys(content) : [];
}

function resolveRequestBody(
  document: OpenAPIDocument,
  requestBody: RequestBodyObject | { $ref: string } | undefined,
): RequestBodyObject | undefined {
  if (!requestBody) {
    return undefined;
  }
  return deref<RequestBodyObject>(document, requestBody);
}

function bodySchemaHasBase64Content(
  document: OpenAPIDocument,
  requestBody: RequestBodyObject | undefined,
): boolean {
  if (!requestBody?.content) {
    return false;
  }
  for (const media of Object.values(requestBody.content)) {
    if (!media.schema) {
      continue;
    }
    const schema = deref<SchemaObject>(document, media.schema);
    if (schema.properties && "base64Content" in schema.properties) {
      return true;
    }
  }
  return false;
}

function isEmptyBodySchema(
  document: OpenAPIDocument,
  requestBody: RequestBodyObject | undefined,
): boolean {
  if (!requestBody?.content) {
    return false;
  }
  const json = requestBody.content["application/json"];
  if (!json?.schema) {
    // Empty content object → open body.
    return Object.keys(requestBody.content).length === 0;
  }
  const schema = isReferenceObject(json.schema)
    ? deref<SchemaObject>(document, json.schema)
    : json.schema;
  const propertyCount = schema.properties ? Object.keys(schema.properties).length : 0;
  return (
    (schema.type === "object" || schema.type === undefined) &&
    propertyCount === 0 &&
    !schema.allOf &&
    !schema.oneOf &&
    !schema.anyOf &&
    !schema.items
  );
}

function hasRequestBody(requestBody: RequestBodyObject | undefined): boolean {
  return requestBody !== undefined;
}

function hasQueryParameters(parameters: ParameterObject[]): boolean {
  return parameters.some((parameter) => parameter.in === "query");
}

function successResponsesHaveOctetStream(
  document: OpenAPIDocument,
  responses: ResolvedOperation["operation"]["responses"],
): boolean {
  for (const status of successStatusCodes(responses)) {
    const response = deref<ResponseObject>(document, responses![status]!);
    if (mediaTypes(response.content).includes("application/octet-stream")) {
      return true;
    }
  }
  return false;
}

function isNoContentOnly(
  document: OpenAPIDocument,
  responses: ResolvedOperation["operation"]["responses"],
): boolean {
  const statuses = successStatusCodes(responses);
  if (statuses.length === 0) {
    return false;
  }
  return statuses.every((status) => {
    if (status === "204") {
      return true;
    }
    const response = deref<ResponseObject>(document, responses![status]!);
    return !response.content || Object.keys(response.content).length === 0;
  });
}

function isEmptyValueLinkedResponse(
  document: OpenAPIDocument,
  responses: ResolvedOperation["operation"]["responses"],
): boolean {
  for (const status of successStatusCodes(responses)) {
    const response = deref<ResponseObject>(document, responses![status]!);
    const json = response.content?.["application/json"];
    if (!json?.schema) {
      continue;
    }
    const schema = deref<SchemaObject>(document, json.schema);
    if (!schema.properties || !("value" in schema.properties)) {
      continue;
    }
    const hasLinks = "links" in schema.properties;
    const valueSchema = schema.properties.value;
    if (!valueSchema || isReferenceObject(valueSchema)) {
      continue;
    }
    const valueProps = valueSchema.properties ? Object.keys(valueSchema.properties).length : 0;
    const emptyValue =
      (valueSchema.type === "object" || valueSchema.type === undefined) &&
      valueProps === 0 &&
      !valueSchema.allOf &&
      !valueSchema.oneOf &&
      !valueSchema.anyOf;
    if (hasLinks && emptyValue) {
      return true;
    }
  }
  return false;
}

export interface DerivedCodecs {
  inputCodec: CodecId;
  outputCodec: CodecId;
  hasOctetStreamResponse: boolean;
}

/**
 * Derive input/output codec ids in the approved precedence order.
 */
export function deriveCodecs(
  document: OpenAPIDocument,
  resolved: ResolvedOperation,
): DerivedCodecs {
  const parameters = collectParameters(document, resolved.pathItem, resolved.operation);
  const requestBody = resolveRequestBody(document, resolved.operation.requestBody);
  const method = resolved.method as HttpMethod;
  const isWrite = method !== "get";
  const hasOctetStreamResponse = successResponsesHaveOctetStream(
    document,
    resolved.operation.responses,
  );

  let inputCodec: CodecId = "json";
  if (bodySchemaHasBase64Content(document, requestBody)) {
    inputCodec = "base64-upload";
  } else if (resolved.operationId.startsWith("CdaDocumentData_")) {
    inputCodec = "cda";
  } else if (resolved.operationId.startsWith("BulkExport_")) {
    inputCodec = "json";
  } else if (isWrite && hasQueryParameters(parameters) && !hasRequestBody(requestBody)) {
    inputCodec = "query-write";
  } else if (isWrite && !hasRequestBody(requestBody)) {
    inputCodec = "no-body-write";
  } else if (isWrite && isEmptyBodySchema(document, requestBody)) {
    inputCodec = "open-body";
  }

  let outputCodec: CodecId = "json";
  if (resolved.operationId === "BulkExport_GetReplicaTimestamp") {
    outputCodec = "replica-timestamp";
  } else if (resolved.operationId.startsWith("BulkExport_")) {
    outputCodec = "bulk-stream";
  } else if (hasOctetStreamResponse) {
    outputCodec = "octet-stream";
  } else if (isNoContentOnly(document, resolved.operation.responses)) {
    outputCodec = "no-content";
  } else if (isEmptyValueLinkedResponse(document, resolved.operation.responses)) {
    outputCodec = "empty-value";
  }

  // CDA ops keep cda as the distinguishing codec on both sides when not overridden above.
  if (resolved.operationId.startsWith("CdaDocumentData_") && outputCodec === "json") {
    outputCodec = "cda";
  }

  return { inputCodec, outputCodec, hasOctetStreamResponse };
}

/**
 * Build a concise first-party description from summary, falling back to METHOD path.
 */
export function deriveDescription(resolved: ResolvedOperation): string {
  const summary = resolved.operation.summary?.trim();
  if (summary) {
    return summary;
  }
  return `${resolved.method.toUpperCase()} ${resolved.path}`;
}
