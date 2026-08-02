import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("package exclusion", () => {
  it("keeps raw OpenAPI / swagger out of the repository root", async () => {
    await expect(access(path.join(root, "openapi.json"))).rejects.toThrow();
    await expect(access(path.join(root, "swagger.json"))).rejects.toThrow();
    await expect(access(path.join(root, "src/generated/openapi.json"))).rejects.toThrow();
    await expect(access(path.join(root, "src/generated/swagger.json"))).rejects.toThrow();
  });

  it("npm pack allowlist excludes specs, scripts, tests, and temp dirs", async () => {
    const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
      cwd: root,
      env: { ...process.env, npm_config_fund: "false", npm_config_audit: "false" },
    });
    const parsed = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
    const files = new Set((parsed[0]?.files ?? []).map((file) => file.path));

    for (const forbidden of [
      "openapi.json",
      "swagger.json",
      "scripts/generate.ts",
      "test/fixtures/openapi/synthetic.openapi.json",
      ".tmp_ss_probe/openapi.json",
      ".env",
      "src/generated/tool-name-abbreviations.json",
      "dist/generated/tool-name-abbreviations.json",
      "overrides/classification-rules.yaml",
      "overrides/operations.yaml",
    ]) {
      expect(files.has(forbidden)).toBe(false);
    }

    expect([...files].some((file) => file.endsWith("tool-name-abbreviations.json"))).toBe(false);

    // Runtime-derived artifacts and public docs are allowed once present.
    for (const allowed of [
      "README.md",
      "LICENSE",
      "NOTICE",
      "SECURITY.md",
      "CONTRIBUTING.md",
      "CHANGELOG.md",
      "server.json",
    ]) {
      expect(files.has(allowed)).toBe(true);
    }
    expect(files.has(".env.example")).toBe(false);
  });
});
