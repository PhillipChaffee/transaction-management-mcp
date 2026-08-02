import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { authorizeToolCall } from "../../src/binder/guards.ts";
import { ToolExecutionError } from "../../src/binder/errors.ts";
import { createResolvedRuntimePolicy } from "../../src/config/runtime-policy.ts";
import { argsForTool, createBinderHarness, operationById } from "./harness.ts";
import { API_BASE_URL } from "../msw/handlers.ts";
import { mswServer } from "../msw/server.ts";

beforeAll(() => {
  mswServer.listen({ onUnhandledRequest: "error" });
});

afterEach(() => {
  mswServer.resetHandlers();
});

afterAll(() => {
  mswServer.close();
});

describe("authorizeToolCall", () => {
  it("fails closed for unselected tools and missing capabilities", async () => {
    const operation = operationById("Contacts_DeleteContact");
    await expect(
      authorizeToolCall({
        operation,
        policy: createResolvedRuntimePolicy({
          selectedToolNames: [],
          readWrite: true,
          grantedCapabilities: ["destructive"],
        }),
        input: argsForTool("contacts_delete_contact", { path: { contactGuid: "c-1" } }),
      }),
    ).rejects.toThrow(/not selected/);

    await expect(
      authorizeToolCall({
        operation,
        policy: createResolvedRuntimePolicy({
          selectedToolNames: ["contacts_delete_contact"],
          readWrite: true,
          grantedCapabilities: [],
        }),
        input: argsForTool("contacts_delete_contact", { path: { contactGuid: "c-1" } }),
      }),
    ).rejects.toThrow(/missing capability/);
  });

  it("blocks writes when readWrite is false even if the tool is selected", async () => {
    const operation = operationById("Contacts_CreateContact");
    await expect(
      authorizeToolCall({
        operation,
        policy: createResolvedRuntimePolicy({
          selectedToolNames: ["contacts_create_contact"],
          readWrite: false,
        }),
        input: { body: { firstName: "Ada" } },
      }),
    ).rejects.toBeInstanceOf(ToolExecutionError);
  });

  it("fails closed when a write has an invalid read-only annotation", async () => {
    const source = operationById("Contacts_CreateContact");
    const operation = {
      ...source,
      annotations: { ...source.annotations, readOnlyHint: true },
    };
    await expect(
      authorizeToolCall({
        operation,
        policy: createResolvedRuntimePolicy({
          selectedToolNames: [operation.toolName],
          readWrite: false,
        }),
        input: { body: { firstName: "Ada" } },
      }),
    ).rejects.toThrow(/write access is disabled/);
  });

  it("defends at call time if a write was registered under a deny policy", async () => {
    let apiHits = 0;
    mswServer.use(
      http.post(`${API_BASE_URL}/api/contacts`, () => {
        apiHits += 1;
        return HttpResponse.json({ value: { contactGuid: "new" } });
      }),
    );

    const harness = await createBinderHarness({
      selectedToolNames: ["contacts_create_contact"],
      policy: createResolvedRuntimePolicy({
        selectedToolNames: ["contacts_create_contact"],
        readWrite: false,
        grantedCapabilities: [],
      }),
    });
    try {
      const result = await harness.client.callTool({
        name: "contacts_create_contact",
        arguments: {
          body: { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.structuredContent)).toMatch(/write access is disabled/);
      expect(apiHits).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("requires high-risk confirmation before the API call", async () => {
    let apiHits = 0;
    mswServer.use(
      http.delete(`${API_BASE_URL}/api/contacts/:contactGuid`, () => {
        apiHits += 1;
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const harness = await createBinderHarness({
      selectedToolNames: ["contacts_delete_contact"],
    });
    try {
      const missing = await harness.client.callTool({
        name: "contacts_delete_contact",
        arguments: { path: { contactGuid: "c-1" } },
      });
      expect(missing.isError).toBe(true);
      expect(apiHits).toBe(0);

      const ok = await harness.client.callTool({
        name: "contacts_delete_contact",
        arguments: argsForTool("contacts_delete_contact", { path: { contactGuid: "c-1" } }),
      });
      expect(ok.isError).toBeFalsy();
      expect(apiHits).toBe(1);
    } finally {
      await harness.close();
    }
  });
});
