import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowNames = ["ci.yml", "openapi-drift.yml", "release.yml"] as const;

describe("GitHub Actions workflows", () => {
  it.each(workflowNames)("parses %s as YAML with jobs and triggers", async (workflowName) => {
    const source = await readFile(path.join(root, ".github/workflows", workflowName), "utf8");
    const workflow = parse(source) as Record<string, unknown>;

    expect(workflow.name).toBeTypeOf("string");
    expect(workflow.on).toBeTruthy();
    expect(workflow.jobs).toBeTruthy();
  });

  it("pins and verifies release tooling before publishing", async () => {
    const source = await readFile(path.join(root, ".github/workflows/release.yml"), "utf8");

    expect(source).toContain("MCP_PUBLISHER_VERSION: v1.8.0");
    expect(source).toContain("sha256sum -c -");
    expect(source).not.toContain("/releases/latest/");
    expect(source).toContain("npm install -g npm@11.5.1");
    expect(source).toContain('git merge-base --is-ancestor "${GITHUB_SHA}" origin/main');
    expect(source).toContain("npm run package:check");
    expect(source).toContain("cancel-in-progress: false");

    for (const workflowName of workflowNames) {
      const workflowSource = await readFile(
        path.join(root, ".github/workflows", workflowName),
        "utf8",
      );
      expect(workflowSource).not.toMatch(/uses:\s*actions\/[^@\s]+@v\d/);
    }
  });
});
