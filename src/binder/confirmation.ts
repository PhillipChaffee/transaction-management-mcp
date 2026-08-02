/**
 * High-risk confirmation (anti-typo) and optional SDK elicitation UX.
 *
 * Startup policy authorizes access. Confirmation requires an exact echo of
 * path resource ids (and bulk/impersonation fields) before any API call.
 * Elicitation is additional UX when the client supports it; decline, cancel,
 * error, or timeout fail closed and never fall back to model intent-echo.
 */

import type {
  ElicitRequestFormParams,
  ElicitResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import type { CapabilityId } from "../config/runtime-policy.js";
import type { ManifestOperation, ToolInput } from "./codecs/index.js";
import { ToolExecutionError } from "./errors.js";

const HIGH_RISK_TIERS = new Set(["destructive", "financial", "admin", "binary-io"]);
const HIGH_RISK_CAPABILITIES = new Set<CapabilityId>([
  "destructive",
  "financial",
  "admin",
  "binary-io",
  "bulk-export",
  "impersonation",
]);

export type ConfirmationPayload = {
  confirm: true;
  resources: Record<string, unknown>;
  filters?: Record<string, unknown>;
};

export type ElicitationOutcome =
  | { status: "accept"; content: Record<string, unknown> }
  | { status: "decline" }
  | { status: "cancel" }
  | { status: "error"; message: string }
  | { status: "timeout" };

/**
 * Transport-agnostic elicitation adapter used by confirmation checks.
 */
export type ConfirmationElicitor = {
  /** When false, hosts use intent-echo confirmation only. */
  readonly supported: boolean;
  elicit(request: {
    message: string;
    requestedSchema: ElicitRequestFormParams["requestedSchema"];
  }): Promise<ElicitationOutcome>;
};

export type EnforceConfirmationOptions = {
  operation: ManifestOperation;
  input: ToolInput & { confirmation?: unknown };
  elicitor?: ConfirmationElicitor;
};

/**
 * Return whether an operation requires high-risk confirmation.
 */
export function isHighRiskOperation(operation: ManifestOperation): boolean {
  if (HIGH_RISK_TIERS.has(operation.riskTier)) {
    return true;
  }
  return operation.capabilities.some((capability) =>
    HIGH_RISK_CAPABILITIES.has(capability as CapabilityId),
  );
}

/**
 * Extract path resource keys from an OpenAPI path template in sorted order.
 */
export function pathResourceKeys(path: string): string[] {
  const keys: string[] = [];
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    const key = match[1];
    if (key !== undefined) {
      keys.push(key);
    }
  }
  return [...new Set(keys)].sort((left, right) => left.localeCompare(right));
}

/**
 * Return whether the operation requires bulk-export filter echoing.
 */
export function requiresBulkExportFilters(operation: ManifestOperation): boolean {
  return operation.operationId === "BulkExport_GetBulkExport";
}

/**
 * Return whether the operation requires impersonation echoing.
 */
export function requiresImpersonationEcho(operation: ManifestOperation): boolean {
  return operation.capabilities.includes("impersonation");
}

/**
 * Build the deterministic Zod schema for a high-risk tool's confirmation object.
 */
export function buildConfirmationSchema(
  operation: ManifestOperation,
): z.ZodType<ConfirmationPayload> {
  const resourceShape: Record<string, z.ZodType<unknown>> = {};
  for (const key of pathResourceKeys(operation.path)) {
    resourceShape[key] = z.unknown();
  }
  if (requiresImpersonationEcho(operation)) {
    resourceShape.userBeingImpersonated = z.unknown().optional();
  }

  const base = z.object({
    confirm: z.literal(true),
    resources: z.object(resourceShape).strict(),
  });

  if (requiresBulkExportFilters(operation)) {
    return base
      .extend({
        filters: z
          .record(z.string(), z.unknown())
          .refine((filters) => Object.keys(filters).length > 0, {
            message: "Bulk export confirmation requires at least one filter",
          }),
      })
      .strict() as z.ZodType<ConfirmationPayload>;
  }

  return base.strict() as z.ZodType<ConfirmationPayload>;
}

/**
 * Augment a tool input schema with the high-risk confirmation object when needed.
 */
export function augmentInputSchemaWithConfirmation(
  operation: ManifestOperation,
  inputSchema: z.ZodType<unknown>,
): z.ZodType<unknown> {
  if (!isHighRiskOperation(operation)) {
    return inputSchema;
  }
  if (!(inputSchema instanceof z.ZodObject)) {
    return z.intersection(
      inputSchema,
      z.object({ confirmation: buildConfirmationSchema(operation) }),
    );
  }
  return inputSchema.extend({
    confirmation: buildConfirmationSchema(operation),
  });
}

/**
 * Build the expected confirmation payload from the tool input.
 */
export function expectedConfirmation(
  operation: ManifestOperation,
  input: ToolInput,
): ConfirmationPayload {
  const resources: Record<string, unknown> = {};
  const path = input.path ?? {};
  for (const key of pathResourceKeys(operation.path)) {
    resources[key] = path[key];
  }
  if (requiresImpersonationEcho(operation)) {
    const query = input.query ?? {};
    if (Object.prototype.hasOwnProperty.call(query, "userBeingImpersonated")) {
      resources.userBeingImpersonated = query.userBeingImpersonated;
    }
  }

  const payload: ConfirmationPayload = {
    confirm: true,
    resources,
  };
  if (requiresBulkExportFilters(operation)) {
    payload.filters = { ...(input.query ?? {}) };
  }
  return payload;
}

/**
 * Validate intent-echo confirmation equality for a high-risk tool call.
 */
export function validateConfirmationEcho(
  operation: ManifestOperation,
  input: ToolInput & { confirmation?: unknown },
): ConfirmationPayload {
  if (!isHighRiskOperation(operation)) {
    throw new ToolExecutionError("Confirmation is not required for this tool");
  }
  if (requiresBulkExportFilters(operation) && Object.keys(input.query ?? {}).length === 0) {
    throw new ToolExecutionError("Bulk export confirmation requires at least one filter");
  }

  const schema = buildConfirmationSchema(operation);
  const parsed = schema.safeParse(input.confirmation);
  if (!parsed.success) {
    throw new ToolExecutionError("High-risk confirmation is missing or invalid");
  }

  const expected = expectedConfirmation(operation, input);
  if (!deepEqual(parsed.data, expected)) {
    throw new ToolExecutionError("High-risk confirmation does not match tool input");
  }
  return parsed.data;
}

/**
 * Enforce confirmation: intent echo always, plus elicitation when supported.
 *
 * When elicitation is supported, accept is required and decline/cancel/error/timeout
 * fail closed without falling back to the model-provided confirmation alone.
 */
export async function enforceConfirmation(options: EnforceConfirmationOptions): Promise<void> {
  const { operation, input, elicitor } = options;
  if (!isHighRiskOperation(operation)) {
    return;
  }

  const expected = expectedConfirmation(operation, input);
  const echoed = validateConfirmationEcho(operation, input);

  if (!elicitor?.supported) {
    // Intent-echo-only hosts: schema equality above is sufficient.
    void echoed;
    return;
  }

  let outcome: ElicitationOutcome;
  try {
    outcome = await elicitor.elicit({
      message: `Confirm high-risk tool ${operation.toolName}`,
      requestedSchema: confirmationToElicitSchema(operation, expected),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "elicitation error";
    if (/timeout/i.test(message)) {
      throw new ToolExecutionError("High-risk confirmation elicitation timed out");
    }
    throw new ToolExecutionError("High-risk confirmation elicitation failed");
  }

  switch (outcome.status) {
    case "accept": {
      const schema = buildConfirmationSchema(operation);
      const accepted = schema.safeParse(outcome.content);
      if (!accepted.success || !deepEqual(accepted.data, expected)) {
        throw new ToolExecutionError("High-risk elicitation confirmation does not match");
      }
      return;
    }
    case "decline":
      throw new ToolExecutionError("High-risk confirmation elicitation was declined");
    case "cancel":
      throw new ToolExecutionError("High-risk confirmation elicitation was cancelled");
    case "timeout":
      throw new ToolExecutionError("High-risk confirmation elicitation timed out");
    case "error":
      throw new ToolExecutionError("High-risk confirmation elicitation failed");
    default: {
      const _exhaustive: never = outcome;
      throw new ToolExecutionError(
        `Unexpected elicitation outcome: ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}

/**
 * Create an elicitation adapter from an MCP server tool-handler context.
 */
export function createSdkConfirmationElicitor(
  ctx: ServerContext,
  clientSupportsElicitation: boolean,
): ConfirmationElicitor {
  return {
    supported: clientSupportsElicitation,
    async elicit(request): Promise<ElicitationOutcome> {
      if (!clientSupportsElicitation) {
        return { status: "error", message: "elicitation is not supported" };
      }
      try {
        const result: ElicitResult = await ctx.mcpReq.elicitInput({
          mode: "form",
          message: request.message,
          requestedSchema: request.requestedSchema,
        });
        if (result.action === "accept") {
          const content =
            result.content && typeof result.content === "object"
              ? (result.content as Record<string, unknown>)
              : {};
          return { status: "accept", content };
        }
        if (result.action === "decline") {
          return { status: "decline" };
        }
        return { status: "cancel" };
      } catch (error) {
        const message = error instanceof Error ? error.message : "elicitation error";
        if (/timeout/i.test(message)) {
          return { status: "timeout" };
        }
        return { status: "error", message };
      }
    },
  };
}

/**
 * Return whether client capabilities advertise form elicitation support.
 */
export function clientSupportsFormElicitation(
  clientCapabilities: { elicitation?: unknown } | undefined,
): boolean {
  return clientCapabilities?.elicitation !== undefined;
}

function confirmationToElicitSchema(
  operation: ManifestOperation,
  expected: ConfirmationPayload,
): ElicitRequestFormParams["requestedSchema"] {
  const resourceProperties: Record<
    string,
    { type: "string" } | { type: "number" } | { type: "boolean" }
  > = {};
  const resourceRequired: string[] = [];
  for (const key of pathResourceKeys(operation.path)) {
    resourceProperties[key] = elicitationPrimitiveSchema(expected.resources[key]);
    resourceRequired.push(key);
  }
  if (requiresImpersonationEcho(operation)) {
    resourceProperties.userBeingImpersonated = elicitationPrimitiveSchema(
      expected.resources.userBeingImpersonated,
    );
  }

  const properties: Record<string, unknown> = {
    confirm: { type: "boolean", description: "Must be true to proceed" },
    resources: {
      type: "object",
      properties: resourceProperties,
      required: resourceRequired,
    },
  };
  const required = ["confirm", "resources"];

  if (requiresBulkExportFilters(operation)) {
    properties.filters = {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
    required.push("filters");
  }

  return {
    type: "object",
    properties: properties as ElicitRequestFormParams["requestedSchema"]["properties"],
    required,
  };
}

function elicitationPrimitiveSchema(
  value: unknown,
): { type: "string" } | { type: "number" } | { type: "boolean" } {
  if (typeof value === "number") {
    return { type: "number" };
  }
  if (typeof value === "boolean") {
    return { type: "boolean" };
  }
  return { type: "string" };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every(
    (key, index) => key === rightKeys[index] && deepEqual(leftRecord[key], rightRecord[key]),
  );
}
