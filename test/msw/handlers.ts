import { http, HttpResponse } from "msw";

export const API_BASE_URL = "https://api.skyslope.com";

/**
 * Minimal MSW handlers for Commit 4 binder/codec tests.
 * Synthetic credentials and payloads only — no network.
 */
export const binderHandlers = [
  http.post(`${API_BASE_URL}/auth/login`, async () => {
    return HttpResponse.json({
      Session: "test-session-token",
      Expiration: "2099-01-01T00:00:00Z",
    });
  }),

  http.get(`${API_BASE_URL}/api/contacts`, ({ request }) => {
    const url = new URL(request.url);
    const firstName = url.searchParams.get("firstName");
    return HttpResponse.json({
      value: {
        contacts: [
          {
            id: "contact-1",
            firstName: firstName ?? "Ada",
            lastName: "Lovelace",
            email: "ada@example.com",
          },
        ],
      },
      warnings: [],
      links: [],
    });
  }),

  http.post(`${API_BASE_URL}/api/contacts`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      value: {
        contactGuid: "new-contact-guid",
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
      },
      warnings: [],
      links: [],
    });
  }),

  http.delete(`${API_BASE_URL}/api/contacts/:contactGuid`, () => {
    return new HttpResponse(null, { status: 204 });
  }),

  http.patch(`${API_BASE_URL}/api/contacts/:contactGuid`, ({ request }) => {
    const url = new URL(request.url);
    return HttpResponse.json({
      value: {
        contact: {
          id: "patched-contact",
          firstName: url.searchParams.get("FirstName"),
        },
      },
      warnings: [],
      links: [],
    });
  }),

  http.put(
    `${API_BASE_URL}/api/files/listings/:listingGuid/contact/:contactGuid`,
    async ({ request }) => {
      // Open-body codecs forward arbitrary JSON; response stays schema-shaped.
      await request.json();
      return HttpResponse.json({
        value: { contactGuid: "listing-contact" },
        warnings: [],
        links: [],
      });
    },
  ),

  http.post(`${API_BASE_URL}/api/files/listings/:listingGuid/documents`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.base64Content === "string" && body.base64Content.length > 0) {
      // Intentionally do not echo base64Content.
      return HttpResponse.json({
        value: {
          listingGuid: "listing-1",
          documentGuid: "doc-1",
          documentName: body.fileName,
        },
        warnings: [],
        links: [],
      });
    }
    return HttpResponse.json(
      { message: "Missing base64Content", code: "bad_request" },
      { status: 400 },
    );
  }),

  http.get(`${API_BASE_URL}/api/files/sales/:saleGuid/cdaDocumentData`, () => {
    return HttpResponse.json({
      value: {
        publishedVersionId: 1,
        documentData: { nested: true, amount: null },
        fieldDefinitions: [],
      },
      warnings: ["cda-warning"],
      links: [],
    });
  }),

  http.put(`${API_BASE_URL}/api/files/sales/:saleGuid/cdaDocumentData`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    return HttpResponse.json({
      value: {
        publishedVersionId: 2,
        documentData: body.documentData ?? null,
        fieldDefinitions: [],
      },
      warnings: [],
      links: [],
    });
  }),

  http.get(`${API_BASE_URL}/api/files`, ({ request }) => {
    const url = new URL(request.url);
    const mode = url.searchParams.get("status") ?? "array";
    if (mode === "comma-newline") {
      const lines = Array.from({ length: 5 }, (_, index) =>
        JSON.stringify({ objectType: "Sale", saleGuid: `sale-${index}` }),
      );
      return new HttpResponse(`${lines.join(",\n")}\n`, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Vendor bulk export streams a JSON array (not a value wrapper).
    const items = Array.from({ length: 150 }, (_, index) => ({
      objectType: "Sale",
      saleGuid: `sale-${index}`,
      createdOn: "2020-01-01T00:00:00Z",
    }));
    return new HttpResponse(JSON.stringify(items), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),

  http.get(`${API_BASE_URL}/api/files/replica-timestamp`, () => {
    return HttpResponse.json({
      replicaTimestamp: "2020-01-02T03:04:05Z",
      server: "synthetic",
    });
  }),

  http.get(`${API_BASE_URL}/api/files/sales/fields`, ({ request }) => {
    const url = new URL(request.url);
    const impersonated = url.searchParams.get("userBeingImpersonated");
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    return new HttpResponse(payload, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Impersonated": impersonated ?? "",
      },
    });
  }),

  http.put(`${API_BASE_URL}/api/files/listings/:listingGuid/reviewer`, async ({ request }) => {
    await request.json().catch(() => undefined);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(`${API_BASE_URL}/api/files/listings/:listingGuid/checklist-items/:id/accept`, () => {
    return HttpResponse.json({
      value: {},
      warnings: [],
      links: [],
    });
  }),

  http.get(`${API_BASE_URL}/api/offices`, () => {
    return HttpResponse.json({
      warnings: ["office-warning"],
      links: [{ href: "/api/offices", rel: "self", method: "GET" }],
    });
  }),
];
