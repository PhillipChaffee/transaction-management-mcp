#!/usr/bin/env node
/**
 * Offline-friendly Inspector smoke helper.
 *
 * MCP Inspector's stdio client only inherits a safe env subset, so this helper
 * writes a tiny launcher that injects synthetic credentials before starting the
 * built stdio binary. Not a runtime dependency of the published package.
 */

import { spawn } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stdioBin = path.join(root, "dist/transport/stdio.js");
const launcher = path.join(root, ".tmp", "inspector-stdio-launcher.mjs");

const [majorRaw = "0", minorRaw = "0"] = process.versions.node.split(".");
const major = Number.parseInt(majorRaw, 10);
const minor = Number.parseInt(minorRaw, 10);
const nodeOk = major > 22 || (major === 22 && minor >= 19);

if (!nodeOk) {
  console.error(
    `Skipping Inspector smoke: requires Node >= 22.19 (current ${process.versions.node})`,
  );
  process.exit(0);
}

await access(stdioBin);
await mkdir(path.dirname(launcher), { recursive: true });
await writeFile(
  launcher,
  `#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = ${JSON.stringify(root)};
const bin = path.join(root, "dist/transport/stdio.js");
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

const child = spawn(
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
    stdio: "inherit",
  },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 1);
});
