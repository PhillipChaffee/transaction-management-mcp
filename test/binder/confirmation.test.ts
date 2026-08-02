import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  augmentInputSchemaWithConfirmation,
  buildConfirmationSchema,
  createSdkConfirmationElicitor,
  enforceConfirmation,
  expectedConfirmation,
  isHighRiskOperation,
  pathResourceKeys,
  type ConfirmationElicitor,
  type ElicitationOutcome,
} from "../../src/binder/confirmation.ts";
import { ToolExecutionError } from "../../src/binder/errors.ts";
import { toolSchemas } from "../../src/generated/tool-schemas.ts";
import { argsForTool, createBinderHarness, operationById } from "./harness.ts";
import { mswServer } from "../msw/server.ts";
import { API_BASE_URL } from "../msw/handlers.ts";
import { http, HttpResponse } from "msw";

beforeAll(() => {
  mswServer.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  mswServer.resetHandlers();
});

afterAll(() => {
  mswServer.close();
});

describe("confirmation helpers", () => {
  it("marks high-risk tiers and capabilities, including bulk-export and impersonation", () => {
    expect(isHighRiskOperation(operationById("Contacts_DeleteContact"))).toBe(true);
    expect(isHighRiskOperation(operationById("Documents_AddDocumentToListing"))).toBe(true);
    expect(isHighRiskOperation(operationById("BulkExport_GetBulkExport"))).toBe(true);
    expect(isHighRiskOperation(operationById("Sales_GetSales"))).toBe(true);
    expect(isHighRiskOperation(operationById("Contacts_CreateContact"))).toBe(false);
    expect(isHighRiskOperation(operationById("Contacts_GetContacts"))).toBe(false);
  });

  it("builds strict path-resource confirmation schemas and validates exact echoes", async () => {
    const operation = operationById("Contacts_DeleteContact");
    expect(pathResourceKeys(operation.path)).toEqual(["contactGuid"]);

    const schema = buildConfirmationSchema(operation);
    const input = { path: { contactGuid: "abc" } };
    const confirmation = expectedConfirmation(operation, input);
    expect(confirmation).toEqual({
      confirm: true,
      resources: { contactGuid: "abc" },
    });
    expect(schema.safeParse(confirmation).success).toBe(true);
    expect(schema.safeParse({ confirm: true, resources: { contactGuid: "nope" } }).success).toBe(
      true,
    );

    await expect(
      enforceConfirmation({
        operation,
        input: { ...input, confirmation: { confirm: true, resources: { contactGuid: "nope" } } },
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("requires bulk filter and impersonation echoes", async () => {
    const bulk = operationById("BulkExport_GetBulkExport");
    await expect(
      enforceConfirmation({
        operation: bulk,
        input: {
          query: {},
          confirmation: { confirm: true, resources: {}, filters: {} },
        },
      }),
    ).rejects.toThrow(/at least one filter/);

    const bulkInput = {
      query: { createdAfter: "2020-01-01", status: "Open" },
    };
    await expect(
      enforceConfirmation({
        operation: bulk,
        input: {
          ...bulkInput,
          confirmation: {
            confirm: true,
            resources: {},
            filters: { createdAfter: "2020-01-01" },
          },
        },
      }),
    ).rejects.toThrow(/does not match/);

    await enforceConfirmation({
      operation: bulk,
      input: {
        ...bulkInput,
        confirmation: expectedConfirmation(bulk, bulkInput),
      },
    });

    const sales = operationById("Sales_GetSales");
    const salesInput = { query: { userBeingImpersonated: 7 } };
    await enforceConfirmation({
      operation: sales,
      input: {
        ...salesInput,
        confirmation: expectedConfirmation(sales, salesInput),
      },
    });
    await expect(
      enforceConfirmation({
        operation: sales,
        input: {
          ...salesInput,
          confirmation: {
            confirm: true,
            resources: { userBeingImpersonated: 8 },
          },
        },
      }),
    ).rejects.toThrow(/does not match/);
  });

  it("augments high-risk input schemas and leaves ordinary tools unchanged", () => {
    const deleteOp = operationById("Contacts_DeleteContact");
    const createOp = operationById("Contacts_CreateContact");
    const augmented = augmentInputSchemaWithConfirmation(
      deleteOp,
      toolSchemas.Contacts_DeleteContact.input,
    );
    const unchanged = augmentInputSchemaWithConfirmation(
      createOp,
      toolSchemas.Contacts_CreateContact.input,
    );
    expect(augmented).not.toBe(toolSchemas.Contacts_DeleteContact.input);
    expect(unchanged).toBe(toolSchemas.Contacts_CreateContact.input);
    expect(
      augmented.safeParse({
        path: { contactGuid: "c-1" },
        confirmation: expectedConfirmation(deleteOp, { path: { contactGuid: "c-1" } }),
      }).success,
    ).toBe(true);
  });
});

describe("confirmation elicitation", () => {
  it("uses intent echo only when elicitation is unsupported", async () => {
    const elicit = vi.fn();
    const elicitor: ConfirmationElicitor = { supported: false, elicit };
    const operation = operationById("Contacts_DeleteContact");
    const input = argsForTool("contacts_delete_contact", { path: { contactGuid: "c-1" } });

    await enforceConfirmation({ operation, input, elicitor });
    expect(elicit).not.toHaveBeenCalled();
  });

  it("accepts elicitation and only then allows an API side effect", async () => {
    let apiHits = 0;
    mswServer.use(
      http.delete(`${API_BASE_URL}/api/contacts/:contactGuid`, () => {
        apiHits += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const input = argsForTool("contacts_delete_contact", { path: { contactGuid: "c-1" } });
    const elicitor: ConfirmationElicitor = {
      supported: true,
      elicit: async () => ({ status: "accept", content: input.confirmation! }),
    };

    const harness = await createBinderHarness({
      selectedToolNames: ["contacts_delete_contact"],
      createElicitor: () => elicitor,
    });
    try {
      const result = await harness.client.callTool({
        name: "contacts_delete_contact",
        arguments: input,
      });
      expect(result.isError).toBeFalsy();
      expect(apiHits).toBe(1);
    } finally {
      await harness.close();
    }
  });

  it.each([
    ["decline", { status: "decline" } satisfies ElicitationOutcome],
    ["cancel", { status: "cancel" } satisfies ElicitationOutcome],
    ["error", { status: "error", message: "boom" } satisfies ElicitationOutcome],
    ["timeout", { status: "timeout" } satisfies ElicitationOutcome],
  ])("fails closed on elicitation %s without API side effects", async (_label, outcome) => {
    let apiHits = 0;
    mswServer.use(
      http.delete(`${API_BASE_URL}/api/contacts/:contactGuid`, () => {
        apiHits += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const input = argsForTool("contacts_delete_contact", { path: { contactGuid: "c-1" } });
    const harness = await createBinderHarness({
      selectedToolNames: ["contacts_delete_contact"],
      createElicitor: () => ({
        supported: true,
        elicit: async () => outcome,
      }),
    });
    try {
      const result = await harness.client.callTool({
        name: "contacts_delete_contact",
        arguments: input,
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.structuredContent)).toMatch(/elicitation/i);
      expect(apiHits).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("maps SDK elicitInput results through the context adapter", async () => {
    const elicitInput = vi.fn(async () => ({
      action: "accept" as const,
      content: {
        confirm: true,
        resources: { contactGuid: "c-1" },
      },
    }));
    const ctx = {
      mcpReq: { elicitInput },
    } as unknown as Parameters<typeof createSdkConfirmationElicitor>[0];

    const elicitor = createSdkConfirmationElicitor(ctx, true);
    const outcome = await elicitor.elicit({
      message: "confirm",
      requestedSchema: { type: "object", properties: {} },
    });
    expect(outcome).toEqual({
      status: "accept",
      content: {
        confirm: true,
        resources: { contactGuid: "c-1" },
      },
    });
    expect(elicitInput).toHaveBeenCalledOnce();
  });

  it("uses numeric elicitation fields for numeric path resources", async () => {
    const operation = operationById("Sales_RejectChecklistItem");
    const input = argsForTool("sales_reject_checklist_item", {
      path: { saleGuid: "sale-1", transactionChecklistId: 42 },
      body: { note: "missing document" },
    });
    const elicit = vi.fn(async (_request: Parameters<ConfirmationElicitor["elicit"]>[0]) => ({
      status: "accept" as const,
      content: input.confirmation!,
    }));

    await enforceConfirmation({
      operation,
      input,
      elicitor: { supported: true, elicit },
    });

    expect(elicit).toHaveBeenCalledOnce();
    const requested = elicit.mock.calls[0]![0].requestedSchema as {
      properties?: {
        resources?: {
          properties?: Record<string, { type?: string }>;
        };
      };
    };
    expect(requested.properties?.resources?.properties?.transactionChecklistId?.type).toBe(
      "number",
    );
  });

  it("does not fall back to model echo when elicitation errors", async () => {
    const operation = operationById("Contacts_DeleteContact");
    const input = argsForTool("contacts_delete_contact", { path: { contactGuid: "c-1" } });
    await expect(
      enforceConfirmation({
        operation,
        input,
        elicitor: {
          supported: true,
          elicit: async () => {
            throw new Error("socket timeout");
          },
        },
      }),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });
});
