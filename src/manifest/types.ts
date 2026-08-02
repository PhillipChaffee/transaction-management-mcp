export type CodecId =
  | "base64-upload"
  | "cda"
  | "bulk-stream"
  | "replica-timestamp"
  | "octet-stream"
  | "no-content"
  | "query-write"
  | "no-body-write"
  | "open-body"
  | "empty-value"
  | "json";

export type RiskTier = "read" | "ordinary" | "destructive" | "financial" | "admin" | "binary-io";

export const CAPABILITY_IDS = [
  "destructive",
  "financial",
  "admin",
  "binary-io",
  "bulk-export",
  "impersonation",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

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
