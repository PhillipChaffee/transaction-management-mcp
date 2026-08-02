import { describe, expect, it } from "vitest";

import {
  TOOL_NAME_REGEX,
  assignToolNames,
  computeToolName,
  operationIdToSnakeCase,
  shortenToolName,
} from "../../scripts/naming.ts";

describe("naming", () => {
  it("snake_cases operationIds and preserves v2_", () => {
    expect(operationIdToSnakeCase("Sales_GetSales")).toBe("sales_get_sales");
    expect(operationIdToSnakeCase("V2Sales_GetSale")).toBe("v2_sales_get_sale");
    expect(operationIdToSnakeCase("V2ListingCommissions_AddCommissionToListing")).toBe(
      "v2_listing_commissions_add_commission_to_listing",
    );
  });

  it("applies longest-first replacements only when longer than 64 chars", () => {
    const short = "sales_get_sales";
    expect(shortenToolName(short)).toEqual({ toolName: short, replacements: [] });

    const long = "sale_transaction_coordinators_update_sale_commission_breakdowns_and_documents";
    expect(long.length).toBeGreaterThan(64);
    const shortened = shortenToolName(long);
    expect(shortened.toolName.length).toBeLessThanOrEqual(64);
    expect(shortened.replacements[0]).toMatch(/^transaction_coordinators→/);
    expect(TOOL_NAME_REGEX.test(shortened.toolName)).toBe(true);
  });

  it("fails on collisions", () => {
    expect(() => assignToolNames(["Sales_GetSales", "Sales_GetSales"])).toThrow(/collision/);
  });

  it("recomputes baked names identically", () => {
    const naming = assignToolNames([
      "Sales_GetSales",
      "V2Sales_ConvertSaleToUnderContract",
      "ListingTransactionCoordinators_RemoveListingTransactionCoordinator",
    ]);
    for (const [operationId, toolName] of naming.toolNames) {
      expect(computeToolName(operationId)).toBe(toolName);
    }
  });
});
