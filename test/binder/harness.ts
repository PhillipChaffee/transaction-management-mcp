import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ServerContext } from "@modelcontextprotocol/server";
import { McpServer } from "@modelcontextprotocol/server";

import { SessionManager } from "../../src/auth/session-manager.ts";
import type { ToolInput } from "../../src/binder/codecs/index.ts";
import {
  expectedConfirmation,
  isHighRiskOperation,
  type ConfirmationElicitor,
} from "../../src/binder/confirmation.ts";
import { registerTools } from "../../src/binder/register.ts";
import { TokenBucketRateLimiter } from "../../src/client/rate-limiter.ts";
import { TransactionApiClient } from "../../src/client/transaction-api-client.ts";
import type { Credentials } from "../../src/config/credentials.ts";
import { createRuntimeLimits } from "../../src/config/runtime-limits.ts";
import {
  createResolvedRuntimePolicy,
  type CapabilityId,
  type ResolvedRuntimePolicy,
} from "../../src/config/runtime-policy.ts";
import operationsManifest from "../../src/generated/operations.manifest.json" with { type: "json" };
import type { ManifestOperation } from "../../src/manifest/types.ts";
import { API_BASE_URL } from "../msw/handlers.ts";

export const syntheticCredentials: Credentials = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  accessKey: "test-access-key",
  accessSecret: "test-access-secret",
};

const ALL_CAPABILITIES: CapabilityId[] = [
  "destructive",
  "financial",
  "admin",
  "binary-io",
  "bulk-export",
  "impersonation",
];

export type BinderHarness = {
  client: Client;
  apiClient: TransactionApiClient;
  registeredNames: string[];
  server: McpServer;
  close: () => Promise<void>;
};

/**
 * Create an in-memory MCP client/server pair with selected tools registered.
 */
export async function createBinderHarness(options: {
  selectedToolNames: Iterable<string>;
  limits?: ReturnType<typeof createRuntimeLimits>;
  readWrite?: boolean;
  grantedCapabilities?: Iterable<CapabilityId>;
  policy?: ResolvedRuntimePolicy;
  createElicitor?: (ctx: ServerContext) => ConfirmationElicitor | undefined;
}): Promise<BinderHarness> {
  const sessionManager = new SessionManager({
    credentials: syntheticCredentials,
    baseUrl: API_BASE_URL,
  });
  const rateLimiter = new TokenBucketRateLimiter();
  const apiClient = new TransactionApiClient({
    sessionManager,
    rateLimiter,
    baseUrl: API_BASE_URL,
  });

  const server = new McpServer(
    { name: "transaction-management-mcp-test", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );

  const policy =
    options.policy ??
    createResolvedRuntimePolicy({
      selectedToolNames: options.selectedToolNames,
      readWrite: options.readWrite ?? true,
      grantedCapabilities: options.grantedCapabilities ?? ALL_CAPABILITIES,
    });

  const registerOptions = {
    server,
    client: apiClient,
    policy,
    limits: options.limits ?? createRuntimeLimits(),
    ...(options.createElicitor !== undefined ? { createElicitor: options.createElicitor } : {}),
  };

  const registeredNames = await registerTools(registerOptions);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "binder-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

  return {
    client: mcpClient,
    apiClient,
    registeredNames,
    server,
    close: async () => {
      await mcpClient.close();
      await server.close();
    },
  };
}

/**
 * Look up a manifest operation by operation id.
 */
export function operationById(operationId: string): ManifestOperation {
  const operation = operationsManifest.operations.find(
    (entry) => entry.operationId === operationId,
  );
  if (!operation) {
    throw new Error(`Missing operation ${operationId}`);
  }
  return operation as ManifestOperation;
}

/**
 * Attach the exact high-risk confirmation echo when the operation requires it.
 */
export function withConfirmation(
  operation: ManifestOperation,
  input: ToolInput,
): ToolInput & { confirmation?: ReturnType<typeof expectedConfirmation> } {
  if (!isHighRiskOperation(operation)) {
    return input;
  }
  return {
    ...input,
    confirmation: expectedConfirmation(operation, input),
  };
}

/**
 * Convenience helper: resolve operation by tool name and attach confirmation.
 */
export function argsForTool(
  toolName: string,
  input: ToolInput,
): ToolInput & { confirmation?: ReturnType<typeof expectedConfirmation> } {
  const operation = operationsManifest.operations.find((entry) => entry.toolName === toolName);
  if (!operation) {
    throw new Error(`Missing tool ${toolName}`);
  }
  return withConfirmation(operation as ManifestOperation, input);
}
