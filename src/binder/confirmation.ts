/**
 * High-risk confirmation (anti-typo) and optional SDK elicitation UX.
 *
 * Startup policy authorizes access. Confirmation requires an exact echo of
 * path resource ids (and bulk/impersonation fields) before any API call.
 * Elicitation is additional UX when the client supports it; decline, cancel,
 * error, or timeout fail closed and never fall back to model intent-echo.
 */

import { isDeepStrictEqual } from "node:util";

import type {
  ElicitRequestFormParams,
  ElicitResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  HIGH_RISK_CAPABILITIES,
  HIGH_RISK_RISK_TIERS,
  type ManifestOperation,
} from "../manifest/types.js";
import type { ToolInput } from "./codecs/index.js";
import { ToolExecutionError } from "./errors.js";

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
  if (HIGH_RISK_RISK_TIERS[operation.riskTier]) {
    return true;
  }
  return operation.capabilities.some((capability) => HIGH_RISK_CAPABILITIES[capability]);
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
    payload.filters = Object.fromEntries(
      Object.entries(input.query ?? {}).filter(
        ([, value]) => value !== null && value !== undefined,
      ),
    );
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
  if (!isDeepStrictEqual(parsed.data, expected)) {
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
      const reconstructed = reconstructConfirmationFromElicitContent(operation, outcome.content);
      const schema = buildConfirmationSchema(operation);
      const accepted = schema.safeParse(reconstructed);
      if (!accepted.success || !isDeepStrictEqual(accepted.data, expected)) {
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
 *
 * Legacy empty `elicitation: {}` means form. Explicit `.form` means form.
 * URL-only capability objects do not support form elicitation.
 */
export function clientSupportsFormElicitation(
  clientCapabilities: { elicitation?: unknown } | undefined,
): boolean {
  const elicitation = clientCapabilities?.elicitation;
  if (elicitation === undefined || elicitation === null || typeof elicitation !== "object") {
    return false;
  }
  const record = elicitation as Record<string, unknown>;
  if (Object.keys(record).length === 0) {
    return true;
  }
  return Object.prototype.hasOwnProperty.call(record, "form") && record.form !== undefined;
}

/**
 * Build a flat primitive form elicitation schema for MCP hosts.
 *
 * MCP form `requestedSchema` properties must be primitives (not nested objects).
 * Tool input still uses nested `confirmation`; accept content is reconstructed
 * via {@link reconstructConfirmationFromElicitContent}.
 */
export function confirmationToElicitSchema(
  operation: ManifestOperation,
  expected: ConfirmationPayload,
): ElicitRequestFormParams["requestedSchema"] {
  const properties: Record<
    string,
    { type: "string" } | { type: "number" } | { type: "boolean"; description?: string }
  > = {
    confirm: { type: "boolean", description: "Must be true to proceed" },
  };
  const required = ["confirm"];

  for (const key of pathResourceKeys(operation.path)) {
    properties[key] = elicitationPrimitiveSchema(expected.resources[key]);
    required.push(key);
  }
  if (
    requiresImpersonationEcho(operation) &&
    Object.prototype.hasOwnProperty.call(expected.resources, "userBeingImpersonated")
  ) {
    properties.userBeingImpersonated = elicitationPrimitiveSchema(
      expected.resources.userBeingImpersonated,
    );
    required.push("userBeingImpersonated");
  }

  if (requiresBulkExportFilters(operation)) {
    const filters = expected.filters ?? {};
    for (const key of Object.keys(filters).sort((left, right) => left.localeCompare(right))) {
      properties[key] = elicitationPrimitiveSchema(filters[key]);
      required.push(key);
    }
  }

  return {
    type: "object",
    properties: properties as ElicitRequestFormParams["requestedSchema"]["properties"],
    required,
  };
}

/**
 * Rebuild a nested confirmation object from flat elicitation accept content.
 *
 * Returns an untyped shape for schema validation — `confirm` is preserved as
 * provided so false/missing values fail closed.
 */
export function reconstructConfirmationFromElicitContent(
  operation: ManifestOperation,
  content: Record<string, unknown>,
): unknown {
  const resources: Record<string, unknown> = {};
  for (const key of elicitationResourceKeys(operation)) {
    if (Object.prototype.hasOwnProperty.call(content, key)) {
      resources[key] = content[key];
    }
  }

  const payload: Record<string, unknown> = {
    confirm: content.confirm,
    resources,
  };

  if (requiresBulkExportFilters(operation)) {
    const filters: Record<string, unknown> = {};
    const resourceKeys = new Set(elicitationResourceKeys(operation));
    for (const [key, value] of Object.entries(content)) {
      if (key === "confirm" || resourceKeys.has(key)) {
        continue;
      }
      filters[key] = value;
    }
    payload.filters = filters;
  }

  return payload;
}

function elicitationResourceKeys(operation: ManifestOperation): string[] {
  const keys = pathResourceKeys(operation.path);
  if (requiresImpersonationEcho(operation) && !keys.includes("userBeingImpersonated")) {
    return [...keys, "userBeingImpersonated"].sort((left, right) => left.localeCompare(right));
  }
  return keys;
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
