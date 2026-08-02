import { describe, expect, it } from "vitest";

import { DEFAULT_TOOLSET_IDS, TOOLSET_IDS, isToolsetId } from "../../src/config/toolsets.ts";

describe("toolsets config", () => {
  it("exports exactly 19 public toolset ids", () => {
    expect(TOOLSET_IDS).toHaveLength(19);
    expect(new Set(TOOLSET_IDS).size).toBe(19);
  });

  it("exports exactly nine default toolset ids that are a subset of public ids", () => {
    expect(DEFAULT_TOOLSET_IDS).toHaveLength(9);
    expect(DEFAULT_TOOLSET_IDS).toEqual([
      "reference",
      "users",
      "sales",
      "listings",
      "contacts",
      "listing_contacts",
      "checklists",
      "stages",
      "offices",
    ]);
    for (const id of DEFAULT_TOOLSET_IDS) {
      expect(isToolsetId(id)).toBe(true);
    }
  });

  it("does not embed operation membership lists", () => {
    const moduleSource = Object.keys({ TOOLSET_IDS, DEFAULT_TOOLSET_IDS }).join(",");
    expect(moduleSource).not.toMatch(/Sales_GetSales|operationId|membership/);
  });
});
