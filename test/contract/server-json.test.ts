import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("server.json metadata", () => {
  it("matches package.json mcpName/version and declares stdio npm package only", async () => {
    const server = JSON.parse(await readFile(path.join(root, "server.json"), "utf8")) as {
      $schema: string;
      name: string;
      description: string;
      version: string;
      packages: Array<{
        registryType: string;
        identifier: string;
        version: string;
        transport: { type: string };
        environmentVariables: Array<{ name: string; isRequired?: boolean; isSecret?: boolean }>;
      }>;
      remotes?: unknown[];
    };
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
      mcpName: string;
      version: string;
      name: string;
    };

    expect(server.$schema).toBe(
      "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    );
    expect(server.name).toBe("io.github.PhillipChaffee/transaction-management-mcp");
    expect(pkg.mcpName).toBe(server.name);
    expect(pkg.version).toBe(server.version);
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.remotes ?? []).toEqual([]);
    expect(server.packages).toHaveLength(1);

    const npmPackage = server.packages[0]!;
    expect(npmPackage.registryType).toBe("npm");
    expect(npmPackage.identifier).toBe(pkg.name);
    expect(npmPackage.version).toBe(server.version);
    expect(npmPackage.transport.type).toBe("stdio");

    for (const name of [
      "SKYSLOPE_TM_CLIENT_ID",
      "SKYSLOPE_TM_CLIENT_SECRET",
      "SKYSLOPE_TM_ACCESS_KEY",
      "SKYSLOPE_TM_ACCESS_SECRET",
    ]) {
      const entry = npmPackage.environmentVariables.find((variable) => variable.name === name);
      expect(entry?.isRequired).toBe(true);
      expect(entry?.isSecret).toBe(true);
    }
  });
});
