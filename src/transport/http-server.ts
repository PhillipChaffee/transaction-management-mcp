/**
 * Programmatic Streamable HTTP server wiring shared by the CLI entry and tests.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { toNodeHandler, type NodeMcpRequestHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";

import type { CreateTransactionManagementServerOptions } from "../server.js";
import { createTransactionManagementServer } from "../server.js";
import {
  bearerTokenMatches,
  isLoopbackHost,
  resolveHttpTransportConfig,
  type HttpTransportConfig,
  validateExactOrigin,
} from "./http-security.js";

export const REMOTE_TLS_WARNING =
  "WARNING: Remote HTTP exposure requires TLS termination in front of this process. This binary serves plain HTTP only.";

export type StartHttpTransportOptions = CreateTransactionManagementServerOptions & {
  /** Override HTTP env resolution (tests). */
  httpEnv?: Record<string, string | undefined>;
  /** Optional listen port override (e.g. 0 for ephemeral). */
  port?: number;
  /** Optional host override. */
  host?: string;
  /** stderr-like sink for diagnostics. */
  log?: (message: string) => void;
};

export type HttpTransportHandle = {
  server: Server;
  mcpHandler: McpHttpHandler;
  config: Omit<HttpTransportConfig, "bearerToken">;
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
};

/**
 * Start the secured single-tenant Streamable HTTP transport.
 */
export async function startHttpTransport(
  options: StartHttpTransportOptions = {},
): Promise<HttpTransportHandle> {
  const env = options.httpEnv ?? options.env ?? process.env;
  const log = options.log ?? ((message: string) => console.error(message));

  const resolved = resolveHttpTransportConfig(env);
  const host = options.host ?? resolved.host;
  const listenPort = options.port ?? resolved.port;
  const config: HttpTransportConfig = {
    ...resolved,
    host,
    port: listenPort,
    isLoopback: isLoopbackHost(host),
  };

  if (!config.isLoopback) {
    log(REMOTE_TLS_WARNING);
  }

  const serverOptions: CreateTransactionManagementServerOptions = {
    env: options.env ?? env,
  };
  if (options.argv !== undefined) {
    serverOptions.argv = options.argv;
  }
  if (options.credentials !== undefined) {
    serverOptions.credentials = options.credentials;
  }
  if (options.operations !== undefined) {
    serverOptions.operations = options.operations;
  }
  if (options.manifest !== undefined) {
    serverOptions.manifest = options.manifest;
  }
  if (options.fetch !== undefined) {
    serverOptions.fetch = options.fetch;
  }
  if (options.clock !== undefined) {
    serverOptions.clock = options.clock;
  }
  if (options.sleep !== undefined) {
    serverOptions.sleep = options.sleep;
  }
  if (options.baseUrl !== undefined) {
    serverOptions.baseUrl = options.baseUrl;
  }
  if (options.version !== undefined) {
    serverOptions.version = options.version;
  }

  const handle = await createTransactionManagementServer(serverOptions);

  const mcpHandler = createMcpHandler(() => handle.createBoundServer(), {
    onerror: (error) => {
      log(error.message);
    },
  });
  const nodeHandler: NodeMcpRequestHandler = toNodeHandler(mcpHandler, {
    onerror: (error) => {
      log(error.message);
    },
  });

  const allowedHostnames = config.isLoopback
    ? localhostAllowedHostnames()
    : [...config.allowedHostnames];

  const server = createServer((req, res) => {
    void dispatchHttpRequest(req, res, {
      bearerToken: config.bearerToken,
      allowedHostnames,
      allowedOrigins: config.allowedOrigins,
      isLoopback: config.isLoopback,
      nodeHandler,
      log,
    });
  });

  await listen(server, config.port, config.host);
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Failed to bind HTTP server");
  }

  const boundPort = address.port;
  const baseUrl = `http://${formatHostForUrl(config.host)}:${boundPort}`;
  log(`Streamable HTTP listening on ${baseUrl} (single-tenant; bearer auth required)`);

  return {
    server,
    mcpHandler,
    config: publicHttpConfig(config, boundPort),
    port: boundPort,
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      await mcpHandler.close().catch(() => undefined);
      await handle.server.close().catch(() => undefined);
    },
  };
}

function publicHttpConfig(
  config: HttpTransportConfig,
  port: number,
): Omit<HttpTransportConfig, "bearerToken"> {
  return {
    host: config.host,
    port,
    allowRemote: config.allowRemote,
    allowedHostnames: config.allowedHostnames,
    allowedOrigins: config.allowedOrigins,
    isLoopback: config.isLoopback,
  };
}

type DispatchContext = {
  bearerToken: string;
  allowedHostnames: string[];
  allowedOrigins: readonly string[];
  isLoopback: boolean;
  nodeHandler: NodeMcpRequestHandler;
  log: (message: string) => void;
};

async function dispatchHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: DispatchContext,
): Promise<void> {
  try {
    if (!bearerTokenMatches(req.headers.authorization, context.bearerToken)) {
      writeJson(res, 401, { error: "unauthorized", message: "Invalid or missing bearer token" });
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") {
        headers.set(key, value);
      } else if (Array.isArray(value)) {
        for (const entry of value) {
          headers.append(key, entry);
        }
      }
    }
    const webRequest = new Request(url, {
      method: req.method ?? "GET",
      headers,
    });

    const hostRejected = hostHeaderValidationResponse(webRequest, context.allowedHostnames);
    if (hostRejected) {
      await writeWebResponse(res, hostRejected);
      return;
    }

    if (context.isLoopback) {
      const originRejected = originValidationResponse(webRequest, localhostAllowedOrigins());
      if (originRejected) {
        await writeWebResponse(res, originRejected);
        return;
      }
    } else {
      const originResult = validateExactOrigin(
        webRequest.headers.get("origin"),
        context.allowedOrigins,
      );
      if (!originResult.ok) {
        writeJson(res, originResult.status, {
          error: "forbidden",
          message: originResult.message,
        });
        return;
      }
    }

    // Node's IncomingMessage.method is optional; the SDK handler accepts the same runtime shape.
    await context.nodeHandler(req as never, res as never);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    context.log(message);
    if (!res.headersSent) {
      writeJson(res, 500, { error: "internal_error", message: "Request failed" });
    }
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function writeJson(res: ServerResponse, status: number, body: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, headers);
  res.end(buffer);
}

function formatHostForUrl(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }
  return host;
}
