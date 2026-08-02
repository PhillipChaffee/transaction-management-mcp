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
});
