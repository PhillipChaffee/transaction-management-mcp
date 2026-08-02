/**
 * Immutable startup authorization snapshot consumed by the registrar and guards.
 *
 * Construct via `resolveRuntimeConfig` (argv/env) or `createResolvedRuntimePolicy`
 * for explicit test/setup values.
 */

export const CAPABILITY_IDS = [
  "destructive",
  "financial",
  "admin",
  "binary-io",
  "bulk-export",
  "impersonation",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export type ResolvedRuntimePolicy = Readonly<{
  /** Tool names (baked `manifest.toolName` values) selected for registration. */
  selectedToolNames: ReadonlySet<string>;
  /** When false, write tools must not be authorized (enforced in Commit 5). */
  readWrite: boolean;
  /** Capability ids granted at startup (enforced in Commit 5). */
  grantedCapabilities: ReadonlySet<CapabilityId>;
}>;

export type CreateResolvedRuntimePolicyOptions = {
  selectedToolNames: Iterable<string>;
  readWrite?: boolean;
  grantedCapabilities?: Iterable<CapabilityId>;
};

/**
 * Build an immutable runtime policy from explicit selection inputs.
 */
export function createResolvedRuntimePolicy(
  options: CreateResolvedRuntimePolicyOptions,
): ResolvedRuntimePolicy {
  return {
    selectedToolNames: new Set(options.selectedToolNames),
    readWrite: options.readWrite ?? false,
    grantedCapabilities: new Set(options.grantedCapabilities ?? []),
  };
}

/**
 * Return whether a string is a known capability id.
 */
export function isCapabilityId(value: string): value is CapabilityId {
  return (CAPABILITY_IDS as readonly string[]).includes(value);
}
