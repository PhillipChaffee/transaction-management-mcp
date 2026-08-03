/**
 * Call-time authorization guard independent of registration.
 *
 * Consumes only the manifest record, resolved startup policy, and tool input.
 * Does not parse environment or argv.
 */

import type { ResolvedRuntimePolicy } from "../config/runtime-policy.js";
import { isCapabilityId } from "../config/runtime-policy.js";
import { isReadOperation, type ManifestOperation } from "../manifest/types.js";
import type { ToolInput } from "./codecs/index.js";
import {
  type ConfirmationElicitor,
  enforceConfirmation,
  isHighRiskOperation,
} from "./confirmation.js";
import { ToolExecutionError } from "./errors.js";

export type AuthorizeToolCallOptions = {
  operation: ManifestOperation;
  policy: ResolvedRuntimePolicy;
  input: ToolInput & { confirmation?: unknown };
  elicitor?: ConfirmationElicitor;
};

/**
 * Authorize a tool call against the immutable startup policy and confirmation rules.
 *
 * Verifies selection, read/write mode, granted capabilities, and high-risk
 * confirmation before any upstream API call. Unknown or unmatched state fails closed.
 */
export async function authorizeToolCall(options: AuthorizeToolCallOptions): Promise<void> {
  const { operation, policy, input, elicitor } = options;

  if (!operation.toolName) {
    throw new ToolExecutionError("Tool call rejected: missing tool name");
  }

  if (!policy.selectedToolNames.has(operation.toolName)) {
    throw new ToolExecutionError(`Tool call rejected: ${operation.toolName} is not selected`);
  }

  const isWrite = !isReadOperation(operation);
  if (isWrite && !policy.readWrite) {
    throw new ToolExecutionError(
      `Tool call rejected: write access is disabled for ${operation.toolName}`,
    );
  }

  for (const capability of operation.capabilities) {
    if (!isCapabilityId(capability)) {
      throw new ToolExecutionError(`Tool call rejected: unknown capability ${capability}`);
    }
    if (!policy.grantedCapabilities.has(capability)) {
      throw new ToolExecutionError(
        `Tool call rejected: missing capability ${capability} for ${operation.toolName}`,
      );
    }
  }

  if (isHighRiskOperation(operation)) {
    const confirmationOptions =
      elicitor === undefined ? { operation, input } : { operation, input, elicitor };
    await enforceConfirmation(confirmationOptions);
  }
}
