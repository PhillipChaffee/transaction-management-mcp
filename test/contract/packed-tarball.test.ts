import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { syntheticProcessEnv } from "../helpers/synthetic-env.ts";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("packed tarball contract", () => {
  let tempRoot = "";
  let installDir = "";
  let packedBin = "";

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "tm-mcp-pack-"));
    const packDir = path.join(tempRoot, "pack");
    installDir = path.join(tempRoot, "install");
    await mkdir(packDir, { recursive: true });
    await mkdir(installDir, { recursive: true });

    await execFileAsync("npm", ["run", "build"], {
      cwd: root,
      env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" },
    });

    const { stdout } = await execFileAsync(
      "npm",
      ["pack", "--pack-destination", packDir, "--json"],
      {
        cwd: root,
        env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" },
      },
    );
    const packed = JSON.parse(stdout) as Array<{ filename: string }>;
    const tarballName = packed[0]?.filename;
    expect(tarballName).toBeTruthy();
    const tarballPath = path.join(packDir, tarballName!);

    await execFileAsync("npm", ["init", "-y"], {
      cwd: installDir,
      env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" },
    });
    await execFileAsync("npm", ["install", tarballPath], {
      cwd: installDir,
      env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" },
    });

    packedBin = path.join(
      installDir,
      "node_modules",
      "transaction-management-mcp",
      "dist",
      "transport",
      "stdio.js",
    );
  }, 120_000);

  afterAll(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("installs runtime artifacts and excludes specs/overrides/scripts/tests/credentials", async () => {
    const packageRoot = path.join(installDir, "node_modules", "transaction-management-mcp");
    const entries = await readdir(packageRoot, { recursive: true });
    const normalized = entries.map((entry) => entry.replaceAll("\\", "/"));

    expect(normalized).toEqual(
      expect.arrayContaining([
        "dist/transport/stdio.js",
        "dist/generated/operations.manifest.json",
        "dist/generated/tool-schemas.js",
        "README.md",
        "LICENSE",
        "NOTICE",
        "openapi.sha256",
      ]),
    );

    for (const forbidden of [
      "scripts/generate.ts",
      "test/msw/handlers.ts",
      "overrides/operations.yaml",
      "overrides/classification-rules.yaml",
      "src/generated/tool-name-abbreviations.json",
      "dist/generated/tool-name-abbreviations.json",
      "openapi.json",
      "swagger.json",
      ".env",
    ]) {
      expect(normalized.includes(forbidden)).toBe(false);
    }
  });

  it("runs the packed stdio bin via MCP client and lists 30 tools", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [packedBin],
      env: syntheticProcessEnv({
        SKYSLOPE_TM_TRANSPORT: "stdio",
      }),
      cwd: installDir,
      stderr: "pipe",
    });
    const client = new Client({ name: "packed-tarball-client", version: "0.0.0" });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(30);
    } finally {
      await client.close();
      await transport.close();
    }
  });
});
