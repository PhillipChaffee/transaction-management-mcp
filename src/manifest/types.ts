import { z } from "zod";

/** Cross-host MCP tool-name contract used by generation and runtime registration. */
export const TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export const RISK_TIERS = [
  "read",
  "ordinary",
  "destructive",
  "financial",
  "admin",
  "binary-io",
] as const;

export type RiskTier = (typeof RISK_TIERS)[number];

export const CODEC_IDS = [
  "base64-upload",
  "cda",
  "bulk-stream",
  "replica-timestamp",
  "octet-stream",
  "no-content",
  "query-write",
  "no-body-write",
  "open-body",
  "empty-value",
  "json",
] as const;

export type CodecId = (typeof CODEC_IDS)[number];

export const CAPABILITY_IDS = [
  "destructive",
  "financial",
  "admin",
  "binary-io",
  "bulk-export",
  "impersonation",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export const HIGH_RISK_RISK_TIERS: Record<RiskTier, boolean> = {
  read: false,
  ordinary: false,
  destructive: true,
  financial: true,
  admin: true,
  "binary-io": true,
};

export const HIGH_RISK_CAPABILITIES: Record<CapabilityId, boolean> = {
  destructive: true,
  financial: true,
  admin: true,
  "binary-io": true,
  "bulk-export": true,
  impersonation: true,
};

export type ToolAnnotations = {
  openWorldHint: boolean;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
};

export type ManifestOperation = {
  operationId: string;
  toolName: string;
  method: string;
  path: string;
  primaryToolset: string;
  riskTier: RiskTier;
  capabilities: readonly CapabilityId[];
  inputCodec: CodecId;
  outputCodec: CodecId;
  description: string;
  annotations: ToolAnnotations;
};

/**
 * Return whether an operation is a read (GET + readOnlyHint) tool.
 */
export function isReadOperation(
  operation: Pick<ManifestOperation, "method" | "annotations">,
): boolean {
  return operation.method.toLowerCase() === "get" && operation.annotations.readOnlyHint === true;
}

export const manifestOperationSchema = z.object({
  operationId: z.string().min(1),
  toolName: z.string().regex(TOOL_NAME_REGEX),
  method: z.string().min(1),
  path: z.string().min(1),
  primaryToolset: z.string().min(1),
  riskTier: z.enum(RISK_TIERS),
  capabilities: z.array(z.enum(CAPABILITY_IDS)),
  inputCodec: z.enum(CODEC_IDS),
  outputCodec: z.enum(CODEC_IDS),
  description: z.string(),
  annotations: z.object({
    openWorldHint: z.boolean(),
    readOnlyHint: z.boolean(),
    destructiveHint: z.boolean(),
    idempotentHint: z.boolean(),
  }),
});

export const manifestFileSchema = z.object({
  operations: z.array(manifestOperationSchema),
});
