#!/usr/bin/env node
/**
 * Opt-in single-tenant Streamable HTTP entry for transaction-management-mcp.
 *
 * Binds loopback by default. Remote exposure requires explicit opt-in, a strong
 * bearer token, an exact Origin allowlist, and TLS termination in front of the
 * process (this binary does not terminate TLS).
 */

import { startHttpTransport } from "./http-server.js";

const EXPECTED_TRANSPORT = "http";

async function main(): Promise<void> {
  const env = process.env;
  const transport = (env.SKYSLOPE_TM_TRANSPORT ?? "").trim().toLowerCase();
  if (transport !== EXPECTED_TRANSPORT) {
    throw new Error(
      `transaction-management-mcp-http requires SKYSLOPE_TM_TRANSPORT=http (got ${transport || "<unset>"}). Use transaction-management-mcp for stdio.`,
    );
  }

  const handle = await startHttpTransport({
    argv: process.argv.slice(2),
    env,
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.error(`Shutting down HTTP transport (${signal})`);
    try {
      await handle.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : "shutdown failed";
      console.error(message);
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
  const message = error instanceof Error ? error.message : "Failed to start HTTP server";
  console.error(message);
  process.exit(1);
});
