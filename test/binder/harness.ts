import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { SessionManager } from "../../src/auth/session-manager.ts";
import { registerTools } from "../../src/binder/register.ts";
import { TokenBucketRateLimiter } from "../../src/client/rate-limiter.ts";
import { TransactionApiClient } from "../../src/client/transaction-api-client.ts";
import type { Credentials } from "../../src/config/credentials.ts";
import { createRuntimeLimits } from "../../src/config/runtime-limits.ts";
import { createResolvedRuntimePolicy } from "../../src/config/runtime-policy.ts";
import { API_BASE_URL } from "../msw/handlers.ts";

export const syntheticCredentials: Credentials = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  accessKey: "test-access-key",
  accessSecret: "test-access-secret",
};

export type BinderHarness = {
  client: Client;
  apiClient: TransactionApiClient;
  registeredNames: string[];
  close: () => Promise<void>;
};

/**
 * Create an in-memory MCP client/server pair with selected tools registered.
 */
export async function createBinderHarness(options: {
  selectedToolNames: Iterable<string>;
  limits?: ReturnType<typeof createRuntimeLimits>;
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

  const policy = createResolvedRuntimePolicy({
    selectedToolNames: options.selectedToolNames,
    readWrite: true,
    grantedCapabilities: [
      "destructive",
      "financial",
      "admin",
      "binary-io",
      "bulk-export",
      "impersonation",
    ],
  });

  const registeredNames = await registerTools({
    server,
    client: apiClient,
    policy,
    limits: options.limits ?? createRuntimeLimits(),
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcpClient = new Client({ name: "binder-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

  return {
    client: mcpClient,
    apiClient,
    registeredNames,
    close: async () => {
      await mcpClient.close();
      await server.close();
    },
  };
}
