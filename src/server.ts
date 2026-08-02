/**
 * Shared MCP server factory for stdio and HTTP transports.
 *
 * Resolves argv/env once into an immutable policy and limits, constructs shared
 * API dependencies, and registers tools. Transports must not re-resolve config.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/server";
import { ZodError } from "zod";

import { SessionManager } from "./auth/session-manager.js";
import { loadOperationsManifest, registerTools } from "./binder/register.js";
import { TokenBucketRateLimiter } from "./client/rate-limiter.js";
import type { FetchLike, SleepFn } from "./client/transaction-api-client.js";
import { TransactionApiClient } from "./client/transaction-api-client.js";
import { loadCredentials, type Credentials } from "./config/credentials.js";
import { resolveRuntimeConfig } from "./config/resolve.js";
import type { RuntimeLimits } from "./config/runtime-limits.js";
import type { ResolvedRuntimePolicy } from "./config/runtime-policy.js";
import type { ManifestOperation } from "./manifest/types.js";

export const SERVER_NAME = "transaction-management-mcp";

export type ClockFn = () => Date;

export type CreateTransactionManagementServerOptions = {
  /** CLI arguments excluding the node/executable prefix. */
  argv?: readonly string[];
  /** Environment map; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Optional preloaded credentials (tests). */
  credentials?: Credentials;
  /** Optional operations list; defaults to the runtime manifest. */
  operations?: readonly ManifestOperation[];
  /** Optional full manifest override for registration (tests). */
  manifest?: { operations: ManifestOperation[] };
  /** Injectable fetch for the Transaction Management API. */
  fetch?: FetchLike | typeof fetch;
  /** Injectable wall clock. */
  clock?: ClockFn;
  /** Injectable sleep used by the API client / rate limiter. */
  sleep?: SleepFn;
  /** Transaction Management API origin. */
  baseUrl?: string;
  /** Override advertised server version (defaults to package.json version). */
  version?: string;
};

export type TransactionManagementServerHandle = {
  server: McpServer;
  policy: ResolvedRuntimePolicy;
  limits: RuntimeLimits;
  registeredNames: string[];
  client: TransactionApiClient;
  /**
   * Build another tools-only `McpServer` that shares the same policy, limits,
   * and API client. Used by HTTP/stdio serving factories that need a fresh
   * server instance per connection or request.
   */
  createBoundServer: () => Promise<McpServer>;
};

type ManifestFile = {
  operations: ManifestOperation[];
};

/**
 * Create a tools-only MCP server with resolved policy, limits, and API client.
 *
 * Calls `resolveRuntimeConfig` exactly once. Registrar and guards receive the
 * same policy object. Startup failures never include credential values.
 */
export async function createTransactionManagementServer(
  options: CreateTransactionManagementServerOptions = {},
): Promise<TransactionManagementServerHandle> {
  const env = options.env ?? process.env;
  const argv = options.argv ?? [];

  let credentials: Credentials;
  try {
    credentials = options.credentials ?? loadCredentials(env);
  } catch (error) {
    throw toStartupError(error, "Invalid or missing Transaction Management credentials");
  }

  let manifest: ManifestFile;
  try {
    manifest = options.manifest ?? (await loadOperationsManifest());
  } catch (error) {
    throw toStartupError(error, "Failed to load operations manifest");
  }

  const operations = options.operations ?? manifest.operations;

  let policy: ResolvedRuntimePolicy;
  let limits: RuntimeLimits;
  try {
    const resolved = resolveRuntimeConfig({ argv, env, operations });
    policy = resolved.policy;
    limits = resolved.limits;
  } catch (error) {
    throw toStartupError(error, "Invalid server configuration");
  }

  const clock = options.clock ?? (() => new Date());
  const sessionManagerOptions: ConstructorParameters<typeof SessionManager>[0] = {
    credentials,
    clock,
  };
  if (options.fetch !== undefined) {
    sessionManagerOptions.fetch = options.fetch as typeof fetch;
  }
  if (options.baseUrl !== undefined) {
    sessionManagerOptions.baseUrl = options.baseUrl;
  }
  const sessionManager = new SessionManager(sessionManagerOptions);

  const rateLimiterOptions: ConstructorParameters<typeof TokenBucketRateLimiter>[0] = {
    now: () => clock().getTime(),
  };
  if (options.sleep !== undefined) {
    rateLimiterOptions.sleep = options.sleep;
  }
  const rateLimiter = new TokenBucketRateLimiter(rateLimiterOptions);

  const clientOptions: ConstructorParameters<typeof TransactionApiClient>[0] = {
    sessionManager,
    rateLimiter,
    clock,
  };
  if (options.fetch !== undefined) {
    clientOptions.fetch = options.fetch;
  }
  if (options.sleep !== undefined) {
    clientOptions.sleep = options.sleep;
  }
  if (options.baseUrl !== undefined) {
    clientOptions.baseUrl = options.baseUrl;
  }
  const client = new TransactionApiClient(clientOptions);

  const version = options.version ?? readPackageVersion();

  const createBoundServer = async (): Promise<McpServer> => {
    const server = new McpServer({ name: SERVER_NAME, version }, { capabilities: { tools: {} } });
    await registerTools({
      server,
      client,
      policy,
      limits,
      manifest,
    });
    return server;
  };

  const server = await createBoundServer();
  const registeredNames = manifest.operations
    .map((operation) => operation.toolName)
    .filter((toolName) => policy.selectedToolNames.has(toolName));

  return {
    server,
    policy,
    limits,
    registeredNames,
    client,
    createBoundServer,
  };
}

/**
 * Format a startup failure without embedding secret values.
 */
export function toStartupError(error: unknown, fallback: string): Error {
  if (error instanceof ZodError) {
    const fields = error.issues
      .map((issue) => issue.path.join("."))
      .filter((field) => field.length > 0);
    if (fields.length > 0) {
      return new Error(`${fallback}: ${fields.join(", ")}`);
    }
    return new Error(fallback);
  }
  if (error instanceof Error) {
    const message = sanitizeStartupMessage(error.message);
    return new Error(message.length > 0 ? message : fallback);
  }
  return new Error(fallback);
}

function sanitizeStartupMessage(message: string): string {
  return message.replace(
    /SKYSLOPE_TM_(CLIENT_SECRET|ACCESS_SECRET|ACCESS_KEY|CLIENT_ID)=[^\s]+/gi,
    "SKYSLOPE_TM_$1=<redacted>",
  );
}

function readPackageVersion(): string {
  try {
    const packageJsonPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../package.json",
    );
    const raw = readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall through to the scaffold default.
  }
  return "0.1.0";
}
