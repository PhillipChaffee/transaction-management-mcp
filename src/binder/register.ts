import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CallToolResult,
  McpServer,
  ServerContext,
  ToolAnnotations,
} from "@modelcontextprotocol/server";
import type { z } from "zod";

import { toMcpToolError } from "../client/errors.js";
import type { TransactionApiClient } from "../client/transaction-api-client.js";
import type { RuntimeLimits } from "../config/runtime-limits.js";
import type { ResolvedRuntimePolicy } from "../config/runtime-policy.js";
import { toolSchemas } from "../generated/tool-schemas.js";
import { TOOL_NAME_REGEX, manifestFileSchema, type ManifestOperation } from "../manifest/types.js";
import { executeOperation, type ToolInput, resolveOutputSchema } from "./codecs/index.js";
import {
  augmentInputSchemaWithConfirmation,
  clientSupportsFormElicitation,
  createSdkConfirmationElicitor,
  type ConfirmationElicitor,
} from "./confirmation.js";
import { ToolExecutionError, toBinderToolError } from "./errors.js";
import { authorizeToolCall } from "./guards.js";

type ManifestFile = {
  operations: ManifestOperation[];
};

export type ToolHandlerBinding = {
  getClientCapabilities: () => { elicitation?: unknown } | undefined;
  createElicitor?: (ctx: ServerContext) => ConfirmationElicitor | undefined;
};

/**
 * Immutable tool registration definition shared across fresh McpServer instances.
 *
 * Schemas/annotations are built once. Handlers are bound per registration so each
 * server can read its own client capabilities safely under concurrent HTTP requests.
 */
export type PreparedToolDefinition = {
  readonly toolName: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly outputSchema: z.ZodTypeAny;
  readonly annotations: ToolAnnotations;
  readonly bindHandler: (
    binding: ToolHandlerBinding,
  ) => (args: unknown, ctx: ServerContext) => Promise<CallToolResult>;
};

export type PrepareToolDefinitionsOptions = {
  client: TransactionApiClient;
  policy: ResolvedRuntimePolicy;
  limits: RuntimeLimits;
  /** Optional manifest override for tests. Defaults to the generated runtime manifest. */
  manifest?: ManifestFile;
};

export type RegisterToolsOptions = PrepareToolDefinitionsOptions & {
  server: McpServer;
  /**
   * Optional precomputed tool definitions. When omitted, definitions are built
   * for this registration call (stdio / unit tests).
   */
  preparedTools?: readonly PreparedToolDefinition[];
  /**
   * Optional elicitation adapter factory for tests. Defaults to an SDK-backed
   * adapter derived from the handler context and client capabilities.
   */
  createElicitor?: (ctx: ServerContext) => ConfirmationElicitor | undefined;
};

/**
 * Precompute immutable tool registration definitions (schemas, annotations, handler factories).
 *
 * HTTP transports call this once in the shared server factory and reuse the
 * definitions across fresh per-request `McpServer` instances.
 */
export async function prepareToolDefinitions(
  options: PrepareToolDefinitionsOptions,
): Promise<PreparedToolDefinition[]> {
  const manifest = options.manifest ?? (await loadOperationsManifest());
  const byToolName = new Map<string, ManifestOperation>();
  for (const operation of manifest.operations) {
    if (!operation.toolName || !TOOL_NAME_REGEX.test(operation.toolName)) {
      throw new Error(`Invalid or missing baked toolName for operation ${operation.operationId}`);
    }
    if (byToolName.has(operation.toolName)) {
      throw new Error(`Duplicate baked toolName ${operation.toolName}`);
    }
    byToolName.set(operation.toolName, operation);
  }

  for (const toolName of options.policy.selectedToolNames) {
    if (!byToolName.has(toolName)) {
      throw new Error(`Unknown selected tool name ${toolName}`);
    }
    if (!TOOL_NAME_REGEX.test(toolName)) {
      throw new Error(`Invalid selected tool name ${toolName}`);
    }
  }

  const prepared: PreparedToolDefinition[] = [];
  for (const operation of manifest.operations) {
    if (!options.policy.selectedToolNames.has(operation.toolName)) {
      continue;
    }

    const schemas = toolSchemas[operation.operationId as keyof typeof toolSchemas];
    if (!schemas) {
      throw new Error(`Missing generated schemas for ${operation.operationId}`);
    }

    const outputSchema = resolveOutputSchema(operation, schemas.output);
    const inputSchema = augmentInputSchemaWithConfirmation(
      operation,
      schemas.input as z.ZodType<unknown>,
    );
    const annotations = operation.annotations as ToolAnnotations;

    prepared.push({
      toolName: operation.toolName,
      title: operation.description,
      description: operation.description,
      inputSchema,
      outputSchema,
      annotations,
      bindHandler: (binding) => {
        return async (args: unknown, ctx: ServerContext): Promise<CallToolResult> => {
          try {
            const input = (args ?? {}) as ToolInput & { confirmation?: unknown };
            const elicitor =
              binding.createElicitor?.(ctx) ??
              createSdkConfirmationElicitor(
                ctx,
                clientSupportsFormElicitation(binding.getClientCapabilities()),
              );

            await authorizeToolCall({
              operation,
              policy: options.policy,
              input,
              ...(elicitor !== undefined ? { elicitor } : {}),
            });

            const toolInput: ToolInput = {};
            if (input.path !== undefined) {
              toolInput.path = input.path;
            }
            if (input.query !== undefined) {
              toolInput.query = input.query;
            }
            if (input.body !== undefined) {
              toolInput.body = input.body;
            }

            return await executeOperation({
              operation,
              input: toolInput,
              client: options.client,
              limits: options.limits,
              outputSchema,
            });
          } catch (error) {
            if (error instanceof ToolExecutionError) {
              return toBinderToolError(error);
            }
            return toMcpToolError(error);
          }
        };
      },
    });
  }

  return prepared;
}

/**
 * Register selected REST operations on an MCP server.
 *
 * Transport-agnostic: callers supply policy, limits, client, and server.
 * Uses baked `manifest.toolName` values only — never recomputes names.
 * High-risk tools receive augmented confirmation input schemas. Every call
 * runs authorization and confirmation guards before `executeOperation`.
 *
 * @returns Registered tool names in manifest order.
 */
export async function registerTools(options: RegisterToolsOptions): Promise<string[]> {
  const prepared =
    options.preparedTools ??
    (await prepareToolDefinitions({
      client: options.client,
      policy: options.policy,
      limits: options.limits,
      ...(options.manifest !== undefined ? { manifest: options.manifest } : {}),
    }));

  const registered: string[] = [];
  for (const definition of prepared) {
    const handler = definition.bindHandler({
      getClientCapabilities: () => options.server.server.getClientCapabilities(),
      ...(options.createElicitor !== undefined ? { createElicitor: options.createElicitor } : {}),
    });
    options.server.registerTool(
      definition.toolName,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        annotations: definition.annotations,
      },
      handler,
    );
    registered.push(definition.toolName);
  }

  return registered;
}

/**
 * Load the committed runtime operations manifest.
 */
export async function loadOperationsManifest(): Promise<ManifestFile> {
  const manifestPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../generated/operations.manifest.json",
  );
  const raw = await readFile(manifestPath, "utf8");
  return manifestFileSchema.parse(JSON.parse(raw));
}

/**
 * Return every baked tool name from the runtime manifest (stable manifest order).
 */
export async function allManifestToolNames(): Promise<string[]> {
  const manifest = await loadOperationsManifest();
  return manifest.operations.map((operation) => operation.toolName);
}
