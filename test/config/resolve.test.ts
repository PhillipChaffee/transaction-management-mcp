import { describe, expect, it } from "vitest";

import { isReadOperation, resolveRuntimeConfig } from "../../src/config/resolve.ts";
import { createRuntimeLimits, DEFAULT_RUNTIME_LIMITS } from "../../src/config/runtime-limits.ts";
import operationsManifest from "../../src/generated/operations.manifest.json" with { type: "json" };
import type { ManifestOperation } from "../../src/manifest/types.ts";

const operations = operationsManifest.operations as ManifestOperation[];

function resolve(options: { argv?: string[]; env?: Record<string, string | undefined> }) {
  return resolveRuntimeConfig({
    operations,
    argv: options.argv ?? [],
    env: options.env ?? {},
  });
}

describe("resolveRuntimeConfig", () => {
  it("defaults to 31 pre-capability tools and 30 selected reads", () => {
    const result = resolve({});
    expect(result.preCapabilityToolNames.size).toBe(31);
    expect(result.policy.selectedToolNames.size).toBe(30);
    expect(result.policy.readWrite).toBe(false);
    expect(result.policy.grantedCapabilities.size).toBe(0);
    expect(result.policy.selectedToolNames.has("sales_get_sales")).toBe(false);
    expect(result.limits).toEqual(DEFAULT_RUNTIME_LIMITS);
  });

  it("exposes all 91 reads with toolsets all and allow all in read-only mode", () => {
    const result = resolve({
      argv: ["--toolsets", "all", "--allow", "all"],
    });
    expect(result.policy.readWrite).toBe(false);
    expect(result.policy.selectedToolNames.size).toBe(91);
    for (const toolName of result.policy.selectedToolNames) {
      const operation = operations.find((entry) => entry.toolName === toolName);
      expect(operation?.method.toLowerCase()).toBe("get");
    }
  });

  it("exposes all 207 tools with toolsets all, read-write, and allow all", () => {
    const result = resolve({
      argv: ["--toolsets", "all", "--read-write", "--allow", "all"],
    });
    expect(result.policy.selectedToolNames.size).toBe(207);
    expect(result.policy.readWrite).toBe(true);
    expect(result.policy.grantedCapabilities.size).toBe(6);
  });

  it("unions exact toolsets with explicit tools before filters", () => {
    const result = resolve({
      argv: ["--toolsets", "reference", "--tools", "contacts_get_contacts", "--allow", "all"],
    });
    expect(result.policy.selectedToolNames.has("contacts_get_contacts")).toBe(true);
    expect(result.policy.selectedToolNames.has("users_get_users")).toBe(false);
    const referenceReads = operations.filter(
      (operation) =>
        operation.primaryToolset === "reference" && operation.method.toLowerCase() === "get",
    );
    for (const operation of referenceReads) {
      expect(result.policy.selectedToolNames.has(operation.toolName)).toBe(true);
    }
  });

  it("applies exclusions after capability filtering", () => {
    const result = resolve({
      argv: [
        "--toolsets",
        "default",
        "--exclude-toolsets",
        "sales",
        "--exclude-tools",
        "contacts_get_contacts",
      ],
    });
    expect(result.policy.selectedToolNames.has("contacts_get_contacts")).toBe(false);
    for (const toolName of result.policy.selectedToolNames) {
      const operation = operations.find((entry) => entry.toolName === toolName);
      expect(operation?.primaryToolset).not.toBe("sales");
    }
  });

  it("lets environment selection and exclusion values replace CLI values", () => {
    const result = resolve({
      argv: ["--toolsets", "all", "--tools", "contacts_get_contacts", "--exclude-tools", "x"],
      env: {
        SKYSLOPE_TM_TOOLSETS: "reference",
        SKYSLOPE_TM_TOOLS: "users_get_users",
        SKYSLOPE_TM_EXCLUDE_TOOLS: "users_get_users",
        SKYSLOPE_TM_ALLOW: "all",
      },
    });
    expect(result.policy.selectedToolNames.has("contacts_get_contacts")).toBe(false);
    expect(result.policy.selectedToolNames.has("users_get_users")).toBe(false);
    expect(
      [...result.policy.selectedToolNames].every((toolName) => {
        const operation = operations.find((entry) => entry.toolName === toolName);
        return operation?.primaryToolset === "reference";
      }),
    ).toBe(true);
  });

  it("uses the more restrictive READ_WRITE when both sources are present", () => {
    const bothTrue = resolve({
      argv: ["--toolsets", "contacts", "--read-write"],
      env: { SKYSLOPE_TM_READ_WRITE: "true" },
    });
    expect(bothTrue.policy.readWrite).toBe(true);
    expect(bothTrue.policy.selectedToolNames.has("contacts_create_contact")).toBe(true);

    const envFalse = resolve({
      argv: ["--toolsets", "contacts", "--read-write"],
      env: { SKYSLOPE_TM_READ_WRITE: "false" },
    });
    expect(envFalse.policy.readWrite).toBe(false);
    expect(envFalse.policy.selectedToolNames.has("contacts_create_contact")).toBe(false);

    const onlyEnv = resolve({
      argv: ["--toolsets", "contacts"],
      env: { SKYSLOPE_TM_READ_WRITE: "true" },
    });
    expect(onlyEnv.policy.readWrite).toBe(true);

    const onlyCli = resolve({
      argv: ["--toolsets", "contacts", "--read-write"],
    });
    expect(onlyCli.policy.readWrite).toBe(true);
  });

  it("intersects ALLOW when both sources are present and supports only-one-source", () => {
    const intersection = resolve({
      argv: ["--toolsets", "all", "--allow", "binary-io,impersonation,financial"],
      env: { SKYSLOPE_TM_ALLOW: "binary-io,impersonation,admin" },
    });
    expect([...intersection.policy.grantedCapabilities].sort()).toEqual([
      "binary-io",
      "impersonation",
    ]);
    expect(intersection.policy.selectedToolNames.has("sales_get_sales")).toBe(true);
    expect(intersection.policy.selectedToolNames.has("bulk_export_get_bulk_export")).toBe(false);

    const onlyEnv = resolve({
      argv: ["--toolsets", "all"],
      env: { SKYSLOPE_TM_ALLOW: "bulk-export" },
    });
    expect([...onlyEnv.policy.grantedCapabilities]).toEqual(["bulk-export"]);
    expect(onlyEnv.policy.selectedToolNames.has("bulk_export_get_bulk_export")).toBe(true);
  });

  it("rejects unknown toolsets, tools, capabilities, and bad limit values", () => {
    expect(() => resolve({ argv: ["--toolsets", "not_a_toolset"] })).toThrow(/Unknown toolset/);
    expect(() => resolve({ argv: ["--tools", "not_a_tool"] })).toThrow(/Unknown tool name/);
    expect(() => resolve({ argv: ["--allow", "not-a-cap"] })).toThrow(/Unknown capability/);
    expect(() => resolve({ env: { SKYSLOPE_TM_MAX_OUTPUT_BYTES: "0" } })).toThrow(
      /positive integer/,
    );
    expect(() => resolve({ env: { SKYSLOPE_TM_MAX_BINARY_BYTES: "-1" } })).toThrow(
      /positive integer/,
    );
    expect(() => resolve({ env: { SKYSLOPE_TM_MAX_UPLOAD_BYTES: "1.5" } })).toThrow(
      /positive integer/,
    );
    expect(() => resolve({ env: { SKYSLOPE_TM_MAX_BULK_ITEMS: "NaN" } })).toThrow(
      /positive integer/,
    );
    expect(() => resolve({ env: { SKYSLOPE_TM_READ_WRITE: "maybe" } })).toThrow(/true or false/);
    expect(() => resolve({ argv: ["--toollsets", "all"] })).toThrow(/Unknown argument/);
  });

  it("requires both GET method and read-only annotation for read classification", () => {
    const read = operationById("Contacts_GetContacts");
    expect(isReadOperation(read)).toBe(true);
    expect(
      isReadOperation({
        ...read,
        method: "post",
        annotations: { ...read.annotations, readOnlyHint: true },
      }),
    ).toBe(false);
    expect(
      isReadOperation({
        ...read,
        annotations: { ...read.annotations, readOnlyHint: false },
      }),
    ).toBe(false);
  });

  it("applies capability and read-only filtering after union", () => {
    const withoutCaps = resolve({
      argv: ["--toolsets", "sales"],
    });
    expect(withoutCaps.preCapabilityToolNames.has("sales_get_sales")).toBe(true);
    expect(withoutCaps.policy.selectedToolNames.has("sales_get_sales")).toBe(false);

    const withCapsReadOnly = resolve({
      argv: ["--toolsets", "contacts", "--allow", "all"],
    });
    expect(withCapsReadOnly.policy.selectedToolNames.has("contacts_get_contacts")).toBe(true);
    expect(withCapsReadOnly.policy.selectedToolNames.has("contacts_create_contact")).toBe(false);
  });

  it("accepts positive safe-integer limit overrides", () => {
    const result = resolve({
      env: {
        SKYSLOPE_TM_MAX_OUTPUT_BYTES: "2048",
        SKYSLOPE_TM_MAX_BINARY_BYTES: "4096",
        SKYSLOPE_TM_MAX_UPLOAD_BYTES: "8192",
        SKYSLOPE_TM_MAX_BULK_ITEMS: "7",
      },
    });
    expect(result.limits).toEqual({
      maxStructuredOutputBytes: 2048,
      maxBinaryOutputBytes: 4096,
      maxUploadBytes: 8192,
      maxBulkItems: 7,
    });
    expect(() => createRuntimeLimits({ maxBulkItems: 0 })).toThrow(/positive safe integer/);
  });
});

function operationById(operationId: string): ManifestOperation {
  const operation = operations.find((entry) => entry.operationId === operationId);
  if (!operation) {
    throw new Error(`Missing operation ${operationId}`);
  }
  return operation;
}
