import { access } from "node:fs/promises";
import path from "node:path";
import type { Stream } from "node:stream";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { beforeAll, describe, expect, it } from "vitest";

import { syntheticProcessEnv } from "../helpers/synthetic-env.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stdioBin = path.join(root, "dist/transport/stdio.js");

function collectStderr(transport: StdioClientTransport): {
  text: () => string;
  done: Promise<void>;
} {
  const stream = transport.stderr;
  const chunks: Buffer[] = [];
  if (!stream) {
    return {
      text: () => "",
      done: Promise.resolve(),
    };
  }
  const readable = stream as Stream & {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
  };
  const done = new Promise<void>((resolve) => {
    readable.on("data", (chunk: unknown) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    });
    readable.on("end", () => {
      resolve();
    });
    readable.on("close", () => {
      resolve();
    });
  });
  return {
    text: () => Buffer.concat(chunks).toString("utf8"),
    done,
  };
}

describe("stdio transport contract", () => {
  beforeAll(async () => {
    await access(stdioBin);
  });

  it("starts the built binary, lists 30 tools, keeps stderr safe, and terminates cleanly", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [stdioBin],
      env: syntheticProcessEnv({
        SKYSLOPE_TM_TRANSPORT: "stdio",
      }),
      cwd: root,
      stderr: "pipe",
    });

    const stderr = collectStderr(transport);
    const client = new Client({ name: "stdio-contract-client", version: "0.0.0" });
    await client.connect(transport);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(30);
    } finally {
      await client.close();
      await transport.close();
    }

    await stderr.done;
    const stderrText = stderr.text();
    expect(stderrText).not.toMatch(/test-client-secret|test-access-secret|test-access-key/i);
    expect(stderrText).not.toMatch(/SKYSLOPE_TM_CLIENT_SECRET=/);
  });

  it("rejects launching the stdio bin when TRANSPORT=http", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [stdioBin],
      env: syntheticProcessEnv({
        SKYSLOPE_TM_TRANSPORT: "http",
      }),
      cwd: root,
      stderr: "pipe",
    });

    const stderr = collectStderr(transport);
    const client = new Client({ name: "stdio-mismatch-client", version: "0.0.0" });
    await expect(client.connect(transport)).rejects.toThrow();
    await transport.close().catch(() => undefined);
    await stderr.done;
    expect(stderr.text()).toMatch(/expects SKYSLOPE_TM_TRANSPORT=stdio/);
  });
});
