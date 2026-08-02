/** Generator-owned tool naming. Runtime never recomputes names. */

export const TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/** Longest-first replacements applied only when the unshortened name exceeds 64 chars. */
export const TOOL_NAME_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  ["transaction_coordinators", "tx_coords"],
  ["transaction_coordinator", "tx_coord"],
  ["commission_breakdowns", "comm_bd"],
  ["referring_agents", "ref_agents"],
  ["referring_agent", "ref_agent"],
  ["tiered_commissions", "tier_comms"],
  ["earnest_money_deposit", "emd"],
  ["miscellaneous", "misc"],
  ["commissions", "comms"],
  ["commission", "comm"],
  ["documents", "docs"],
  ["document", "doc"],
  ["properties", "props"],
  ["property", "prop"],
];

export interface AbbreviationRecord {
  operationId: string;
  unshortened: string;
  toolName: string;
  replacements: string[];
}

export interface NamingResult {
  toolNames: Map<string, string>;
  abbreviations: AbbreviationRecord[];
}

/**
 * Convert an OpenAPI operationId to a snake_case tool name candidate.
 *
 * Preserves a leading `v2_` prefix when the operationId begins with `V2`.
 */
export function operationIdToSnakeCase(operationId: string): string {
  let remainder = operationId;
  let prefix = "";
  if (/^V2/i.test(remainder)) {
    prefix = "v2_";
    remainder = remainder.replace(/^V2/i, "");
  }

  const snake = remainder
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();

  return `${prefix}${snake}`;
}

/**
 * Apply longest-first replacements until the name is ≤64 characters or replacements are exhausted.
 */
export function shortenToolName(unshortened: string): {
  toolName: string;
  replacements: string[];
} {
  if (unshortened.length <= 64) {
    return { toolName: unshortened, replacements: [] };
  }

  let toolName = unshortened;
  const replacements: string[] = [];
  for (const [from, to] of TOOL_NAME_REPLACEMENTS) {
    if (toolName.length <= 64) {
      break;
    }
    if (!toolName.includes(from)) {
      continue;
    }
    toolName = toolName.split(from).join(to);
    replacements.push(`${from}→${to}`);
  }

  return { toolName, replacements };
}

/**
 * Assign unique, regex-valid tool names for every operationId.
 *
 * Raises:
 *   Error: When a name remains invalid after abbreviation or collides with another.
 */
export function assignToolNames(operationIds: readonly string[]): NamingResult {
  const toolNames = new Map<string, string>();
  const abbreviations: AbbreviationRecord[] = [];
  const seen = new Map<string, string>();

  for (const operationId of operationIds) {
    const unshortened = operationIdToSnakeCase(operationId);
    const { toolName, replacements } = shortenToolName(unshortened);

    if (!TOOL_NAME_REGEX.test(toolName)) {
      throw new Error(
        `Invalid toolName for ${operationId}: ${JSON.stringify(toolName)} ` +
          `(unshortened=${JSON.stringify(unshortened)})`,
      );
    }

    const previous = seen.get(toolName);
    if (previous !== undefined) {
      throw new Error(
        `toolName collision ${JSON.stringify(toolName)} between ${previous} and ${operationId}`,
      );
    }
    seen.set(toolName, operationId);
    toolNames.set(operationId, toolName);

    if (replacements.length > 0 || unshortened.length > 64) {
      abbreviations.push({
        operationId,
        unshortened,
        toolName,
        replacements,
      });
    }
  }

  abbreviations.sort((a, b) => a.operationId.localeCompare(b.operationId));
  return { toolNames, abbreviations };
}

/** Recompute a single toolName (for verify-manifest regeneration equality). */
export function computeToolName(operationId: string): string {
  const unshortened = operationIdToSnakeCase(operationId);
  const { toolName } = shortenToolName(unshortened);
  if (!TOOL_NAME_REGEX.test(toolName)) {
    throw new Error(`Invalid recomputed toolName for ${operationId}: ${toolName}`);
  }
  return toolName;
}
