import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { SessionManager } from "../../src/auth/session-manager.ts";
import { parseBulkItems } from "../../src/binder/codecs/bulk-stream.ts";
import {
  executeOperation,
  normalizeEmptyValue,
  prepareRequest,
  resolveOutputSchema,
  substitutePath,
  validateBase64Upload,
} from "../../src/binder/codecs/index.ts";
import {
  BulkStreamOutputSchema,
  OctetStreamOutputSchema,
} from "../../src/binder/codecs/output-schemas.ts";
import { ToolExecutionError } from "../../src/binder/errors.ts";
import { TokenBucketRateLimiter } from "../../src/client/rate-limiter.ts";
import { TransactionApiClient } from "../../src/client/transaction-api-client.ts";
import { createRuntimeLimits } from "../../src/config/runtime-limits.ts";
import { toolSchemas } from "../../src/generated/tool-schemas.ts";
import { API_BASE_URL } from "../msw/handlers.ts";
import { mswServer } from "../msw/server.ts";
import {
  argsForTool,
  createBinderHarness,
  operationById,
  syntheticCredentials,
} from "./harness.ts";

beforeAll(() => {
  mswServer.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  mswServer.resetHandlers();
});

afterAll(() => {
  mswServer.close();
});

describe("codec helpers", () => {
  it("substitutes all path placeholders and fails when missing", () => {
    expect(substitutePath("/api/contacts/{contactGuid}", { contactGuid: "abc 1" })).toBe(
      "/api/contacts/abc%201",
    );
    expect(() => substitutePath("/api/contacts/{contactGuid}", {})).toThrow(ToolExecutionError);
  });

  it("keeps literal dotted query keys", () => {
    const prepared = prepareRequest(
      operationById("Contacts_GetContacts"),
      { query: { "address.city": "Austin", firstName: "Ada" } },
      createRuntimeLimits(),
    );
    expect(prepared.query).toEqual({ "address.city": "Austin", firstName: "Ada" });
  });

  it("validates base64 uploads without echoing bytes", () => {
    const ok = Buffer.from("hello").toString("base64");
    validateBase64Upload({ base64Content: ok, fileName: "a.txt" }, 1024);

    expect(() =>
      validateBase64Upload({ base64Content: "%%%not-base64%%%", fileName: "a.txt" }, 1024),
    ).toThrow(/not valid base64/);

    try {
      validateBase64Upload(
        { base64Content: Buffer.alloc(2048).toString("base64"), fileName: "a.txt" },
        100,
      );
      expect.fail("expected size error");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolExecutionError);
      expect(String(error)).not.toMatch(/AAAA/);
      expect((error as Error).message).toMatch(/size limit/);
    }

    // Canonical encoding of "Hello" is SGVsbG8=; SGVsbG9= is same alphabet/padding but non-canonical.
    validateBase64Upload({ base64Content: "SGVsbG8=", fileName: "a.txt" }, 1024);
    expect(() =>
      validateBase64Upload({ base64Content: "SGVsbG9=", fileName: "a.txt" }, 1024),
    ).toThrow(/not valid base64/);
  });

  it("normalizes empty-value wrappers", () => {
    expect(normalizeEmptyValue({ warnings: ["w"], links: [] })).toEqual({
      value: null,
      warnings: ["w"],
      links: [],
    });
    expect(normalizeEmptyValue({ value: { ok: true }, warnings: null })).toEqual({
      value: { ok: true },
      warnings: null,
    });
  });

  it("parses bulk JSON-array and comma-newline streams with caps", () => {
    const arrayText = JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(parseBulkItems(arrayText, 2)).toEqual({
      items: [{ id: 1 }, { id: 2 }],
      truncated: true,
    });

    const csv = `${JSON.stringify({ id: 1 })},\n${JSON.stringify({ id: 2 })}\n`;
    expect(parseBulkItems(csv, 10)).toEqual({
      items: [{ id: 1 }, { id: 2 }],
      truncated: false,
    });
  });

  it("parses documented bulk envelope value arrays with caps", () => {
    const envelope = JSON.stringify({
      value: [{ id: 1 }, { id: 2 }, { id: 3 }],
      links: [{ rel: "self" }],
    });
    expect(parseBulkItems(envelope, 2)).toEqual({
      items: [{ id: 1 }, { id: 2 }],
      truncated: true,
    });

    // Truncated mid-second-element: keep the complete first item.
    const truncatedPrefix = '{"value":[{"id":1},{"id":2';
    expect(parseBulkItems(truncatedPrefix, 10)).toEqual({
      items: [{ id: 1 }],
      truncated: true,
    });
  });

  it("attaches codec-specific output schemas only where needed", () => {
    const bulk = operationById("BulkExport_GetBulkExport");
    expect(resolveOutputSchema(bulk, toolSchemas.BulkExport_GetBulkExport.output)).toBe(
      BulkStreamOutputSchema,
    );
    const octet = operationById("Sales_GetSales");
    expect(resolveOutputSchema(octet, toolSchemas.Sales_GetSales.output)).toBe(
      OctetStreamOutputSchema,
    );
    const normal = operationById("Contacts_GetContacts");
    expect(resolveOutputSchema(normal, toolSchemas.Contacts_GetContacts.output)).toBe(
      toolSchemas.Contacts_GetContacts.output,
    );
  });
});

describe("codec execution via MCP", () => {
  it("dispatches normal JSON path/query/body and includes list counts", async () => {
    const harness = await createBinderHarness({
      selectedToolNames: ["contacts_get_contacts", "contacts_create_contact"],
    });
    try {
      const listed = await harness.client.callTool({
        name: "contacts_get_contacts",
        arguments: { query: { firstName: "Grace" } },
      });
      expect(listed.isError).toBeFalsy();
      expect(listed.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("GET /api/contacts succeeded (200); 1 item(s)"),
      });
      expect(listed.structuredContent).toMatchObject({
        value: { contacts: [{ firstName: "Grace" }] },
      });

      const created = await harness.client.callTool({
        name: "contacts_create_contact",
        arguments: {
          body: {
            firstName: "Grace",
            lastName: "Hopper",
            email: "grace@example.com",
          },
        },
      });
      expect(created.isError).toBeFalsy();
      expect(created.content[0]).toMatchObject({
        type: "text",
        text: "POST /api/contacts succeeded (200)",
      });
    } finally {
      await harness.close();
    }
  });

  it("handles query-write and no-body-write without request bodies", async () => {
    const harness = await createBinderHarness({
      selectedToolNames: [
        "contacts_update_contacts",
        "contacts_delete_contact",
        "listings_accept_checklist_item",
      ],
    });
    try {
      const patched = await harness.client.callTool({
        name: "contacts_update_contacts",
        arguments: {
          path: { contactGuid: "c-1" },
          query: { FirstName: "Alan" },
        },
      });
      expect(patched.isError).toBeFalsy();
      expect(patched.structuredContent).toMatchObject({
        value: { contact: { firstName: "Alan" } },
      });

      const deleted = await harness.client.callTool({
        name: "contacts_delete_contact",
        arguments: argsForTool("contacts_delete_contact", {
          path: { contactGuid: "c-1" },
        }),
      });
      expect(deleted.isError).toBeFalsy();
      expect(deleted.structuredContent).toEqual({ success: true, status: 204 });

      const accepted = await harness.client.callTool({
        name: "listings_accept_checklist_item",
        arguments: {
          path: { listingGuid: "l-1", listingChecklistItemId: 9 },
        },
      });
      expect(accepted.isError).toBeFalsy();
    } finally {
      await harness.close();
    }
  });

  it("sends open-body JSON objects unchanged", async () => {
    let capturedBody: unknown;
    mswServer.use(
      http.put(
        `${API_BASE_URL}/api/files/listings/:listingGuid/contact/:contactGuid`,
        async ({ request }) => {
          capturedBody = await request.json();
          return HttpResponse.json({
            value: { contactGuid: "listing-contact" },
            warnings: [],
            links: [],
          });
        },
      ),
    );

    const harness = await createBinderHarness({
      selectedToolNames: ["listing_contacts_update_listing_contact"],
    });
    try {
      const result = await harness.client.callTool({
        name: "listing_contacts_update_listing_contact",
        arguments: {
          path: { listingGuid: "l-1", contactGuid: "c-1" },
          body: { customField: "value", nested: { a: 1 } },
        },
      });
      expect(result.isError).toBeFalsy();
      expect(capturedBody).toEqual({ customField: "value", nested: { a: 1 } });
      expect(result.structuredContent).toMatchObject({
        value: { contactGuid: "listing-contact" },
      });
    } finally {
      await harness.close();
    }
  });

  it("handles base64-upload without echoing bytes", async () => {
    const harness = await createBinderHarness({
      selectedToolNames: ["documents_add_document_to_listing"],
    });
    try {
      const payload = Buffer.from("synthetic-file-bytes").toString("base64");
      const result = await harness.client.callTool({
        name: "documents_add_document_to_listing",
        arguments: argsForTool("documents_add_document_to_listing", {
          path: { listingGuid: "listing-1" },
          body: { base64Content: payload, fileName: "offer.pdf" },
        }),
      });
      expect(result.isError).toBeFalsy();
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(payload);
      expect(serialized).not.toContain("synthetic-file-bytes");
      expect(result.structuredContent).toMatchObject({
        value: { documentName: "offer.pdf" },
      });
    } finally {
      await harness.close();
    }
  });

  it("preserves CDA documentData unknown/null", async () => {
    const harness = await createBinderHarness({
      selectedToolNames: [
        "cda_document_data_get_cda_document_data",
        "cda_document_data_set_cda_document_data",
      ],
    });
    try {
      const got = await harness.client.callTool({
        name: "cda_document_data_get_cda_document_data",
        arguments: argsForTool("cda_document_data_get_cda_document_data", {
          path: { saleGuid: "sale-1" },
        }),
      });
      expect(got.isError).toBeFalsy();
      expect(got.structuredContent).toMatchObject({
        value: { documentData: { nested: true, amount: null } },
      });

      const set = await harness.client.callTool({
        name: "cda_document_data_set_cda_document_data",
        arguments: argsForTool("cda_document_data_set_cda_document_data", {
          path: { saleGuid: "sale-1" },
          body: { formsFileId: 3, documentData: null },
        }),
      });
      expect(set.isError).toBeFalsy();
      expect(set.structuredContent).toMatchObject({
        value: { documentData: null },
      });
    } finally {
      await harness.close();
    }
  });

  it("bulk-stream caps items and reports truncation metadata", async () => {
    const harness = await createBinderHarness({
      selectedToolNames: ["bulk_export_get_bulk_export"],
      limits: createRuntimeLimits({ maxBulkItems: 100 }),
    });
    try {
      const result = await harness.client.callTool({
        name: "bulk_export_get_bulk_export",
        arguments: argsForTool("bulk_export_get_bulk_export", { query: { status: "envelope" } }),
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        truncated: true,
        returnedItems: 100,
        limits: {
          maxBulkItems: 100,
          maxStructuredOutputBytes: 1 * 1024 * 1024,
        },
      });
      expect((result.structuredContent as { items: unknown[] }).items).toHaveLength(100);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("100 item(s); truncated"),
      });
    } finally {
      await harness.close();
    }
  });

  it("bulk-stream supports comma-newline vendor payloads", async () => {
    const harness = await createBinderHarness({
      selectedToolNames: ["bulk_export_get_bulk_export"],
    });
    try {
      const result = await harness.client.callTool({
        name: "bulk_export_get_bulk_export",
        arguments: argsForTool("bulk_export_get_bulk_export", {
          query: { status: "comma-newline" },
        }),
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        truncated: false,
        returnedItems: 5,
      });
    } finally {
      await harness.close();
    }
  });

  it("replica-timestamp returns a bounded JSON object", async () => {
    const harness = await createBinderHarness({
      selectedToolNames: ["bulk_export_get_replica_timestamp"],
    });
    try {
      const result = await harness.client.callTool({
        name: "bulk_export_get_replica_timestamp",
        arguments: argsForTool("bulk_export_get_replica_timestamp", {}),
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        replicaTimestamp: "2020-01-02T03:04:05Z",
        server: "synthetic",
      });
    } finally {
      await harness.close();
    }
  });

  it("octet-stream returns mediaType/base64/truncated and passes impersonation integers", async () => {
    const harness = await createBinderHarness({
      selectedToolNames: ["sales_get_sales"],
    });
    try {
      const result = await harness.client.callTool({
        name: "sales_get_sales",
        arguments: argsForTool("sales_get_sales", {
          query: { userBeingImpersonated: 42 },
        }),
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        mediaType: "application/octet-stream",
        base64: Buffer.from([1, 2, 3, 4, 5]).toString("base64"),
        truncated: false,
      });
    } finally {
      await harness.close();
    }
  });

  it("no-content tools return success/status 204", async () => {
    const harness = await createBinderHarness({
      selectedToolNames: ["listings_update_reviewer"],
    });
    try {
      const result = await harness.client.callTool({
        name: "listings_update_reviewer",
        arguments: {
          path: { listingGuid: "listing-1" },
          body: { reviewerGuid: "user-1" },
        },
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ success: true, status: 204 });
    } finally {
      await harness.close();
    }
  });

  it("no-content tools reject non-204 responses", async () => {
    mswServer.use(
      http.put(`${API_BASE_URL}/api/files/listings/:listingGuid/reviewer`, async ({ request }) => {
        await request.json().catch(() => undefined);
        return HttpResponse.json({ value: { leaked: true } }, { status: 200 });
      }),
    );

    const harness = await createBinderHarness({
      selectedToolNames: ["listings_update_reviewer"],
    });
    try {
      const result = await harness.client.callTool({
        name: "listings_update_reviewer",
        arguments: {
          path: { listingGuid: "listing-1" },
          body: { reviewerGuid: "user-1" },
        },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        message: expect.stringMatching(/Expected 204 No Content, received 200/),
      });
      expect(result.structuredContent).not.toMatchObject({ success: true, status: 204 });
    } finally {
      await harness.close();
    }
  });

  it("maps upstream errors to isError tool results without body echo", async () => {
    mswServer.use(
      http.get(`${API_BASE_URL}/api/contacts`, () =>
        HttpResponse.json(
          { message: "Nope", code: "forbidden", secretBody: "should-not-leak" },
          { status: 403 },
        ),
      ),
    );

    const harness = await createBinderHarness({
      selectedToolNames: ["contacts_get_contacts"],
    });
    try {
      const result = await harness.client.callTool({
        name: "contacts_get_contacts",
        arguments: { query: {} },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        httpStatus: 403,
        message: "Nope",
        code: "forbidden",
      });
      expect(JSON.stringify(result)).not.toContain("should-not-leak");
    } finally {
      await harness.close();
    }
  });

  it("enforces structured output byte cap for normal JSON", async () => {
    const big = "x".repeat(2048);
    mswServer.use(
      http.get(`${API_BASE_URL}/api/contacts`, () =>
        HttpResponse.json({ value: { contacts: [{ note: big }] } }),
      ),
    );
    const harness = await createBinderHarness({
      selectedToolNames: ["contacts_get_contacts"],
      limits: createRuntimeLimits({ maxStructuredOutputBytes: 512 }),
    });
    try {
      const result = await harness.client.callTool({
        name: "contacts_get_contacts",
        arguments: { query: {} },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        message: "Structured output exceeds MCP size limit",
      });
      expect(JSON.stringify(result)).not.toContain(big);
    } finally {
      await harness.close();
    }
  }, 10_000);

  it("executes empty-value normalization through the dispatcher", async () => {
    mswServer.use(
      http.get(`${API_BASE_URL}/api/synthetic/empty-value`, () =>
        HttpResponse.json({
          warnings: ["keep-me"],
          links: [{ rel: "self" }],
        }),
      ),
    );

    const apiClient = new TransactionApiClient({
      sessionManager: new SessionManager({
        credentials: syntheticCredentials,
        baseUrl: API_BASE_URL,
      }),
      rateLimiter: new TokenBucketRateLimiter(),
      baseUrl: API_BASE_URL,
    });

    const operation = {
      operationId: "Synthetic_EmptyValue",
      toolName: "synthetic_empty_value",
      method: "get",
      path: "/api/synthetic/empty-value",
      primaryToolset: "reference",
      riskTier: "read" as const,
      capabilities: [] as const,
      inputCodec: "json" as const,
      outputCodec: "empty-value" as const,
      description: "Synthetic empty value",
      annotations: {
        openWorldHint: true,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    };

    const result = await executeOperation({
      operation,
      input: {},
      client: apiClient,
      limits: createRuntimeLimits(),
      outputSchema: resolveOutputSchema(operation, toolSchemas.Contacts_GetContacts.output),
    });

    expect(result.structuredContent).toEqual({
      value: null,
      warnings: ["keep-me"],
      links: [{ rel: "self" }],
    });
  });
});
