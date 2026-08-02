#!/usr/bin/env node
/**
 * Default stdio entry for transaction-management-mcp.
 *
 * Protocol traffic is written to stdout only. Diagnostics and startup errors
 * go to stderr. Configuration is parsed once through the shared server factory.
 */

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createTransactionManagementServer, SERVER_NAME } from "../server.js";

const EXPECTED_TRANSPORT = "stdio";

async function main(): Promise<void> {
  const env = process.env;
  const transport = (env.SKYSLOPE_TM_TRANSPORT ?? EXPECTED_TRANSPORT).trim().toLowerCase();
  if (transport !== EXPECTED_TRANSPORT) {
    throw new Error(
      `transaction-management-mcp expects SKYSLOPE_TM_TRANSPORT=stdio (got ${transport || "<empty>"}). Use transaction-management-mcp-http for HTTP.`,
    );
  }

  const handle = await createTransactionManagementServer({
    argv: process.argv.slice(2),
    env,
  });

  const stdioHandle = serveStdio(() => handle.createBoundServer(), {
    onerror: (error) => {
      console.error(`[${SERVER_NAME}] ${error.message}`);
    },
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`Shutting down stdio transport (${signal})`);
    try {
      await stdioHandle.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : "shutdown failed";
      console.error(message);
    }
    try {
      await handle.server.close();
    } catch {
      // Already closed or never connected.
    }
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Failed to start stdio server";
  console.error(message);
  process.exit(1);
});
