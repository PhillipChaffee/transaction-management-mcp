/**
 * Validate server.json against the official MCP Registry schema.
 *
 * Fetches the schema from `$schema` (never commits it). Also enforces local
 * invariants: mcpName match, version match, stdio-only package, no remotes.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ErrorObject, ValidateFunction } from "ajv";

type AjvInstance = {
  compile: (schema: object) => ValidateFunction;
};

type AjvConstructor = new (options?: { allErrors?: boolean; strict?: boolean }) => AjvInstance;

type AddFormats = (ajv: AjvInstance) => unknown;

const require = createRequire(import.meta.url);
const Ajv = require("ajv") as AjvConstructor;
const addFormats = require("ajv-formats") as AddFormats;

const DEFAULT_SCHEMA_URL =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

type ServerJson = {
  $schema?: string;
  name?: string;
  description?: string;
  version?: string;
  packages?: Array<{
    registryType?: string;
    identifier?: string;
    version?: string;
    transport?: { type?: string };
    environmentVariables?: Array<{ name?: string; isSecret?: boolean; isRequired?: boolean }>;
  }>;
  remotes?: unknown[];
};

type PackageJson = {
  name?: string;
  version?: string;
  mcpName?: string;
};

function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

async function loadJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

export async function validateServerJson(options: {
  root?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const root = options.root ?? repoRoot();
  const fetchImpl = options.fetchImpl ?? fetch;
  const serverPath = path.join(root, "server.json");
  const packagePath = path.join(root, "package.json");

  const server = (await loadJson(serverPath)) as ServerJson;
  const pkg = (await loadJson(packagePath)) as PackageJson;

  const schemaUrl = server.$schema ?? DEFAULT_SCHEMA_URL;
  const schemaResponse = await fetchImpl(schemaUrl, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!schemaResponse.ok) {
    throw new Error(`Failed to fetch schema ${schemaUrl}: HTTP ${schemaResponse.status}`);
  }
  const schema = (await schemaResponse.json()) as object;

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const ok = validate(server);
  if (!ok) {
    const details = ((validate.errors ?? []) as ErrorObject[])
      .map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`)
      .join("\n");
    throw new Error(`server.json failed schema validation:\n${details}`);
  }

  if (pkg.mcpName !== server.name) {
    throw new Error(
      `package.json mcpName (${pkg.mcpName}) must equal server.json name (${server.name})`,
    );
  }
  if (pkg.version !== server.version) {
    throw new Error(
      `package.json version (${pkg.version}) must equal server.json version (${server.version})`,
    );
  }
  if (server.name !== "io.github.PhillipChaffee/transaction-management-mcp") {
    throw new Error(`Unexpected server.json name: ${server.name}`);
  }
  if (server.remotes && server.remotes.length > 0) {
    throw new Error("server.json must not declare remotes (no hosted service)");
  }
  const npmPackage = server.packages?.[0];
  if (!npmPackage) {
    throw new Error("server.json must declare one npm package");
  }
  if (npmPackage.registryType !== "npm" || npmPackage.identifier !== "transaction-management-mcp") {
    throw new Error("server.json package must be npm identifier transaction-management-mcp");
  }
  if (npmPackage.version !== server.version) {
    throw new Error("server.json package.version must match server version");
  }
  if (npmPackage.transport?.type !== "stdio") {
    throw new Error("server.json package transport must be stdio");
  }

  const requiredSecrets = [
    "SKYSLOPE_TM_CLIENT_ID",
    "SKYSLOPE_TM_CLIENT_SECRET",
    "SKYSLOPE_TM_ACCESS_KEY",
    "SKYSLOPE_TM_ACCESS_SECRET",
  ];
  const envVars = npmPackage.environmentVariables ?? [];
  for (const name of requiredSecrets) {
    const entry = envVars.find((variable) => variable.name === name);
    if (!entry?.isRequired || !entry.isSecret) {
      throw new Error(`${name} must be required and secret in server.json`);
    }
  }

  process.stdout.write("server.json is valid against the official MCP Registry schema.\n");
}

async function main(): Promise<void> {
  await validateServerJson({});
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
