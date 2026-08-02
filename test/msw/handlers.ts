import { http, HttpResponse, type HttpHandler } from "msw";

import operationsManifest from "../../src/generated/operations.manifest.json" with { type: "json" };
import type { ManifestOperation } from "../../src/manifest/types.ts";

export const API_BASE_URL = "https://api.skyslope.com";

export type CapturedApiRequest = {
  method: string;
  pathname: string;
  search: string;
  headers: Record<string, string>;
  bodyText: string | undefined;
};

const capturedRequests: CapturedApiRequest[] = [];

/**
 * Return a snapshot of captured upstream requests since the last reset.
 */
export function getCapturedRequests(): readonly CapturedApiRequest[] {
  return [...capturedRequests];
}

/**
 * Clear captured upstream requests.
 */
export function resetCapturedRequests(): void {
  capturedRequests.length = 0;
}

async function captureRequest(request: Request): Promise<CapturedApiRequest> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  let bodyText: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    bodyText = await request.clone().text();
  }
  const captured: CapturedApiRequest = {
    method: request.method.toUpperCase(),
    pathname: url.pathname,
    search: url.search,
    headers,
    bodyText,
  };
  capturedRequests.push(captured);
  return captured;
}

/**
 * Convert an OpenAPI path template to an MSW path with `:param` segments.
 */
export function openApiPathToMswPath(openApiPath: string): string {
  return openApiPath.replace(/\{([^}]+)\}/g, ":$1");
}

/**
 * Build a deterministic synthetic JSON body for a manifest operation.
 */
export function syntheticResponseFor(operation: ManifestOperation): unknown {
  return {
    value: {
      synthetic: true,
      operationId: operation.operationId,
      toolName: operation.toolName,
      method: operation.method.toUpperCase(),
      path: operation.path,
    },
    warnings: [],
    links: [],
  };
}

/**
 * Explicit auth + codec handlers used by binder tests.
 * Synthetic credentials and payloads only — no network.
 */
export const explicitHandlers: HttpHandler[] = [
  http.post(`${API_BASE_URL}/auth/login`, async ({ request }) => {
    await captureRequest(request);
    return HttpResponse.json({
      Session: "test-session-token",
      Expiration: "2099-01-01T00:00:00Z",
    });
  }),

  http.get(`${API_BASE_URL}/api/contacts`, async ({ request }) => {
    await captureRequest(request);
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
    await captureRequest(request);
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

  http.delete(`${API_BASE_URL}/api/contacts/:contactGuid`, async ({ request }) => {
    await captureRequest(request);
    return new HttpResponse(null, { status: 204 });
  }),

  http.patch(`${API_BASE_URL}/api/contacts/:contactGuid`, async ({ request }) => {
    await captureRequest(request);
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
      await captureRequest(request);
      await request.json();
      return HttpResponse.json({
        value: { contactGuid: "listing-contact" },
        warnings: [],
        links: [],
      });
    },
  ),

  http.post(`${API_BASE_URL}/api/files/listings/:listingGuid/documents`, async ({ request }) => {
    await captureRequest(request);
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.base64Content === "string" && body.base64Content.length > 0) {
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

  http.get(`${API_BASE_URL}/api/files/sales/:saleGuid/cdaDocumentData`, async ({ request }) => {
    await captureRequest(request);
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
    await captureRequest(request);
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

  http.get(`${API_BASE_URL}/api/files`, async ({ request }) => {
    await captureRequest(request);
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

  http.get(`${API_BASE_URL}/api/files/replica-timestamp`, async ({ request }) => {
    await captureRequest(request);
    return HttpResponse.json({
      replicaTimestamp: "2020-01-02T03:04:05Z",
      server: "synthetic",
    });
  }),

  http.get(`${API_BASE_URL}/api/files/sales/fields`, async ({ request }) => {
    await captureRequest(request);
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
    await captureRequest(request);
    await request.json().catch(() => undefined);
    return new HttpResponse(null, { status: 204 });
  }),

  http.post(
    `${API_BASE_URL}/api/files/listings/:listingGuid/checklist-items/:id/accept`,
    async ({ request }) => {
      await captureRequest(request);
      return HttpResponse.json({
        value: {},
        warnings: [],
        links: [],
      });
    },
  ),

  http.get(`${API_BASE_URL}/api/offices`, async ({ request }) => {
    await captureRequest(request);
    return HttpResponse.json({
      warnings: ["office-warning"],
      links: [{ href: "/api/offices", rel: "self", method: "GET" }],
    });
  }),
];

/**
 * Build deterministic generic handlers for every remaining manifest method/path.
 *
 * Explicit handlers take precedence when registered first.
 */
export function createGenericManifestHandlers(
  operations: readonly ManifestOperation[] = operationsManifest.operations as ManifestOperation[],
): HttpHandler[] {
  const seen = new Set<string>();
  const handlers: HttpHandler[] = [];

  for (const operation of operations) {
    const method = operation.method.toLowerCase();
    const mswPath = openApiPathToMswPath(operation.path);
    const key = `${method} ${mswPath}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const url = `${API_BASE_URL}${mswPath}`;
    const responder = async ({ request }: { request: Request }) => {
      await captureRequest(request);
      if (method === "delete") {
        return new HttpResponse(null, { status: 204 });
      }
      return HttpResponse.json(syntheticResponseFor(operation) as Record<string, unknown>);
    };

    switch (method) {
      case "get":
        handlers.push(http.get(url, responder));
        break;
      case "post":
        handlers.push(http.post(url, responder));
        break;
      case "put":
        handlers.push(http.put(url, responder));
        break;
      case "patch":
        handlers.push(http.patch(url, responder));
        break;
      case "delete":
        handlers.push(http.delete(url, responder));
        break;
      default:
        throw new Error(`Unsupported HTTP method in manifest: ${operation.method}`);
    }
  }

  return handlers;
}

/** Backward-compatible name used by Commit 4 binder tests. */
export const binderHandlers = explicitHandlers;

/** Full fake API: explicit codec handlers first, then generic manifest coverage. */
export const allHandlers: HttpHandler[] = [...explicitHandlers, ...createGenericManifestHandlers()];
