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
import { httpRequestBodyLimitBytes } from "../config/runtime-limits.js";
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
  const requestBodyLimitBytes = httpRequestBodyLimitBytes(handle.limits);

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
      requestBodyLimitBytes,
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
  requestBodyLimitBytes: number;
  log: (message: string) => void;
};

async function dispatchHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: DispatchContext,
): Promise<void> {
  try {
    if (!bearerTokenMatches(req.headers.authorization, context.bearerToken)) {
      drainRequest(req);
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
      drainRequest(req);
      await writeWebResponse(res, hostRejected);
      return;
    }

    if (context.isLoopback) {
      const originRejected = originValidationResponse(webRequest, localhostAllowedOrigins());
      if (originRejected) {
        drainRequest(req);
        await writeWebResponse(res, originRejected);
        return;
      }
    } else {
      const originResult = validateExactOrigin(
        webRequest.headers.get("origin"),
        context.allowedOrigins,
      );
      if (!originResult.ok) {
        drainRequest(req);
        writeJson(res, originResult.status, {
          error: "forbidden",
          message: originResult.message,
        });
        return;
      }
    }

    const method = (req.method ?? "GET").toUpperCase();
    let parsedBody: unknown;
    if (method !== "GET" && method !== "HEAD") {
      const bodyResult = await readJsonRequestBody(req, context.requestBodyLimitBytes);
      if (bodyResult.status === "too-large") {
        drainRequest(req);
        writeJson(res, 413, {
          error: "payload_too_large",
          message: "Request body exceeds size limit",
        });
        return;
      }
      if (bodyResult.status === "invalid-json") {
        writeJson(res, 400, {
          error: "invalid_json",
          message: "Request body must be valid JSON",
        });
        return;
      }
      parsedBody = bodyResult.value;
    }

    // Node's IncomingMessage.method is optional; the SDK handler accepts the same runtime shape.
    await context.nodeHandler(req as never, res as never, parsedBody);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    context.log(message);
    if (!res.headersSent) {
      writeJson(res, 500, { error: "internal_error", message: "Request failed" });
    }
  }
}

type ReadBodyResult =
  { status: "ok"; value: unknown } | { status: "too-large" } | { status: "invalid-json" };

/**
 * Read and JSON-parse an inbound MCP request body with a hard byte cap.
 *
 * Rejects oversized Content-Length before reading. For chunked bodies, stops
 * once the cap is exceeded and destroys the request stream.
 */
export async function readJsonRequestBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<ReadBodyResult> {
  const contentLengthHeader = req.headers["content-length"];
  if (typeof contentLengthHeader === "string" && contentLengthHeader.length > 0) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { status: "too-large" };
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        return { status: "too-large" };
      }
      chunks.push(buffer);
    }
  } catch {
    return { status: "invalid-json" };
  }

  if (total === 0) {
    return { status: "ok", value: undefined };
  }

  try {
    const raw = Buffer.concat(chunks, total).toString("utf8");
    return { status: "ok", value: JSON.parse(raw) as unknown };
  } catch {
    return { status: "invalid-json" };
  }
}

/**
 * Drain an inbound request stream so keep-alive sockets can be reused.
 *
 * Uses resume only — IncomingMessage.destroy() tears down the shared socket and
 * prevents writing the HTTP response.
 */
export function drainRequest(req: IncomingMessage): void {
  if (req.readableEnded || req.destroyed) {
    return;
  }
  req.resume();
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
