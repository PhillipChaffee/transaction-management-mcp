import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function nodeMeetsInspectorRequirement(): boolean {
  const [majorRaw = "0", minorRaw = "0"] = process.versions.node.split(".");
  const major = Number.parseInt(majorRaw, 10);
  const minor = Number.parseInt(minorRaw, 10);
  if (major > 22) {
    return true;
  }
  if (major < 22) {
    return false;
  }
  return minor >= 19;
}

describe("MCP Inspector smoke", () => {
  it("lists tools through Inspector CLI when Node >= 22.19", async () => {
    if (!nodeMeetsInspectorRequirement()) {
      // Keep the suite green on Node 20 CI legs; Inspector requires newer Node.
      return;
    }

    // Inspector's StdioClientTransport only inherits a safe env subset, so a
    // tiny launcher injects synthetic credentials before starting the binary.
    const launcher = path.join(root, ".tmp", "inspector-stdio-launcher.mjs");
    await mkdir(path.dirname(launcher), { recursive: true });
    await writeFile(
      launcher,
      `import { spawn } from "node:child_process";
import path from "node:path";

const bin = path.join(${JSON.stringify(root)}, "dist/transport/stdio.js");
const child = spawn(process.execPath, [bin], {
  env: {
    ...process.env,
    SKYSLOPE_TM_CLIENT_ID: "test-client-id",
    SKYSLOPE_TM_CLIENT_SECRET: "test-client-secret",
    SKYSLOPE_TM_ACCESS_KEY: "test-access-key",
    SKYSLOPE_TM_ACCESS_SECRET: "test-access-secret",
    SKYSLOPE_TM_TRANSPORT: "stdio",
  },
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.exit(1);
  process.exit(code ?? 1);
});
`,
      "utf8",
    );

    const { stdout, stderr } = await execFileAsync(
      "npx",
      [
        "--yes",
        "@modelcontextprotocol/inspector",
        "--cli",
        process.execPath,
        launcher,
        "--method",
        "tools/list",
      ],
      {
        cwd: root,
        env: process.env,
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const combined = `${stdout}\n${stderr}`;
    expect(combined).not.toMatch(/test-client-secret|test-access-secret/i);

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      expect(stdout).toMatch(/contacts_get_contacts/);
      return;
    }

    const tools = extractTools(parsed);
    expect(tools.length).toBe(30);
  }, 180_000);
});

function extractTools(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.tools)) {
      return record.tools;
    }
    if (record.result && typeof record.result === "object") {
      const result = record.result as Record<string, unknown>;
      if (Array.isArray(result.tools)) {
        return result.tools;
      }
    }
  }
  return [];
}
