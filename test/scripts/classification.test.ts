import { describe, expect, it } from "vitest";

import {
  deriveAnnotations,
  deriveCapabilities,
  deriveRiskTier,
} from "../../scripts/lib/classification.ts";
import type { ResolvedOperation } from "../../scripts/lib/openapi-document.ts";
import { loadClassificationRules } from "../../scripts/lib/overrides.ts";
import { buildTagIndex } from "../../scripts/lib/overrides.ts";
import { detectTwins } from "../../scripts/lib/twins.ts";

function op(
  partial: Pick<ResolvedOperation, "operationId" | "method" | "path"> & {
    tags?: string[];
  },
): ResolvedOperation {
  return {
    operationId: partial.operationId,
    method: partial.method,
    path: partial.path,
    tags: partial.tags ?? ["Sales"],
    operation: {},
    pathItem: {},
  };
}

describe("classification predicates", () => {
  it("loads exclusive tag map without duplicates", async () => {
    const rules = await loadClassificationRules();
    const index = buildTagIndex(rules);
    expect(index.get("Sale documents")).toBe("sale_documents");
    expect(index.get("Sale Documents")).toBe("sale_documents");
    expect(index.get("V2 Listing Tiered Commissions")).toBe("v2_listings");
    expect(index.size).toBe(57);
  });

  it("applies exclusive write-tier precedence", async () => {
    const rules = await loadClassificationRules();

    expect(
      deriveRiskTier(
        op({
          operationId: "Documents_AddDocumentToSale",
          method: "post",
          path: "/api/files/sales/{saleGuid}/documents",
          tags: ["Sale documents"],
        }),
        "Sale documents",
        rules,
      ),
    ).toBe("binary-io");

    expect(
      deriveRiskTier(
        op({
          operationId: "Offices_DeactivateOffice",
          method: "delete",
          path: "/api/offices/{officeGuid}",
          tags: ["Offices"],
        }),
        "Offices",
        rules,
      ),
    ).toBe("admin");

    expect(
      deriveRiskTier(
        op({
          operationId: "Checklists_CopyChecklists",
          method: "post",
          path: "/api/offices/{sourceOfficeGuid}/checklists/copy",
          tags: ["Checklists"],
        }),
        "Checklists",
        rules,
      ),
    ).toBe("admin");

    expect(
      deriveRiskTier(
        op({
          operationId: "SaleCommissions_AddCommissionsToSale",
          method: "post",
          path: "/api/files/sales/{saleGuid}/commissions",
          tags: ["Sale Commissions"],
        }),
        "Sale Commissions",
        rules,
      ),
    ).toBe("financial");

    expect(
      deriveRiskTier(
        op({
          operationId: "Contacts_DeleteContact",
          method: "delete",
          path: "/api/contacts/{contactGuid}",
          tags: ["Contacts"],
        }),
        "Contacts",
        rules,
      ),
    ).toBe("destructive");

    expect(
      deriveRiskTier(
        op({
          operationId: "Sales_CloseSale",
          method: "put",
          path: "/api/files/sales/{saleGuid}/close",
          tags: ["Sales"],
        }),
        "Sales",
        rules,
      ),
    ).toBe("destructive");

    expect(
      deriveRiskTier(
        op({
          operationId: "Contacts_CreateContact",
          method: "post",
          path: "/api/contacts",
          tags: ["Contacts"],
        }),
        "Contacts",
        rules,
      ),
    ).toBe("ordinary");

    expect(
      deriveRiskTier(
        op({
          operationId: "Sales_GetSales",
          method: "get",
          path: "/api/files/sales/fields",
          tags: ["Sales"],
        }),
        "Sales",
        rules,
      ),
    ).toBe("read");
  });

  it("derives conjunctive capabilities independently", async () => {
    const rules = await loadClassificationRules();
    const capabilities = deriveCapabilities(
      op({
        operationId: "Sales_GetSales",
        method: "get",
        path: "/api/files/sales/fields",
        tags: ["Sales"],
      }),
      "Sales",
      "read",
      rules,
      false,
      true,
    );
    expect(capabilities).toEqual(["binary-io", "impersonation"]);

    const financial = deriveCapabilities(
      op({
        operationId: "CdaDocumentData_SetCdaDocumentData",
        method: "put",
        path: "/api/files/sales/{saleGuid}/cdaDocumentData",
        tags: ["Sale CDA document data"],
      }),
      "Sale CDA document data",
      "financial",
      rules,
      false,
      false,
    );
    expect(financial).toEqual(["financial", "binary-io"]);
  });

  it("sets annotation hints from method and tier", () => {
    expect(deriveAnnotations("get", "read")).toEqual({
      openWorldHint: true,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
    expect(deriveAnnotations("post", "ordinary")).toEqual({
      openWorldHint: true,
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
    expect(deriveAnnotations("delete", "destructive").destructiveHint).toBe(true);
    expect(deriveAnnotations("put", "financial").destructiveHint).toBe(true);
  });

  it("detects twins by method + path with /v2 stripped", () => {
    const twins = detectTwins([
      op({
        operationId: "Sales_UpdateSale",
        method: "put",
        path: "/api/files/sales/{saleGuid}",
      }),
      op({
        operationId: "V2Sales_UpdateSale",
        method: "put",
        path: "/api/v2/files/sales/{saleGuid}",
      }),
      op({
        operationId: "V2SaleContacts_AddSaleContacts",
        method: "post",
        path: "/api/v2/files/sales/{saleGuid}/contacts",
      }),
    ]);
    expect(twins.pairCount).toBe(1);
    expect(twins.twinByOperationId.get("Sales_UpdateSale")).toBe("V2Sales_UpdateSale");
    expect(twins.v2OnlyOperationIds).toEqual(["V2SaleContacts_AddSaleContacts"]);
  });
});
