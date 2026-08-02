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

export type ManifestOperation = {
  operationId: string;
  toolName: string;
  method: string;
  path: string;
  primaryToolset: string;
  riskTier: RiskTier;
  capabilities: readonly string[];
  inputCodec: CodecId;
  outputCodec: CodecId;
  description: string;
  annotations: {
    openWorldHint: boolean;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
  };
};
