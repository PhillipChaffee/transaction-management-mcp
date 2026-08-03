/**
 * Parse vendor bulk payloads: a JSON array, `{value:[...],links}` envelope, or
 * comma/newline-separated JSON values. Stops after maxItems complete values.
 */
export function parseBulkItems(
  text: string,
  maxItems: number,
): { items: unknown[]; truncated: boolean } {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { items: [], truncated: false };
  }

  if (trimmed.startsWith("[")) {
    return parseJsonArrayPrefix(trimmed, maxItems);
  }

  if (trimmed.startsWith("{")) {
    const valueArrayStart = findEnvelopeValueArrayStart(trimmed);
    if (valueArrayStart !== undefined) {
      return parseJsonArrayPrefix(trimmed.slice(valueArrayStart), maxItems);
    }
  }

  return parseCommaNewlineValues(trimmed, maxItems);
}

/**
 * Locate the `[` of a documented bulk envelope `value` array.
 *
 * Only accepts top-level keys `value` and/or `links`. Any other key means this is
 * not the envelope shape (e.g. a bare comma-newline object that also starts with `{`).
 * Returns the array offset even when the stream is truncated mid-array.
 */
function findEnvelopeValueArrayStart(text: string): number | undefined {
  let i = 1; // skip '{'
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i]!)) {
      i += 1;
    }
    if (i >= text.length || text[i] === "}" || text[i] !== '"') {
      return undefined;
    }
    const parsedKey = readJsonValueAt(text, i);
    if (!parsedKey || typeof parsedKey.value !== "string") {
      return undefined;
    }
    i = parsedKey.end;
    while (i < text.length && /\s/.test(text[i]!)) {
      i += 1;
    }
    if (text[i] !== ":") {
      return undefined;
    }
    i += 1;
    while (i < text.length && /\s/.test(text[i]!)) {
      i += 1;
    }
    if (parsedKey.value === "value") {
      return text[i] === "[" ? i : undefined;
    }
    if (parsedKey.value === "links") {
      const linksEnd = findJsonValueEnd(text, i);
      if (linksEnd === undefined) {
        return undefined;
      }
      i = linksEnd;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function parseJsonArrayPrefix(
  text: string,
  maxItems: number,
): { items: unknown[]; truncated: boolean } {
  const items: unknown[] = [];
  let i = 1; // skip '['
  let truncated = false;

  while (i < text.length && items.length < maxItems) {
    while (i < text.length && /[\s,]/.test(text[i]!)) {
      i += 1;
    }
    if (i >= text.length) {
      break;
    }
    if (text[i] === "]") {
      break;
    }
    const parsed = readJsonValueAt(text, i);
    if (!parsed) {
      truncated = true;
      break;
    }
    items.push(parsed.value);
    i = parsed.end;
  }

  if (items.length >= maxItems) {
    // More complete items may remain after the cap.
    while (i < text.length && /[\s,]/.test(text[i]!)) {
      i += 1;
    }
    if (i < text.length && text[i] !== "]") {
      truncated = true;
    }
  } else if (!text.includes("]", i)) {
    // Stream ended mid-array without a closing bracket after the last item.
    truncated = truncated || looksIncomplete(text);
  }

  return { items, truncated };
}

function parseCommaNewlineValues(
  text: string,
  maxItems: number,
): { items: unknown[]; truncated: boolean } {
  const items: unknown[] = [];
  let i = 0;
  let truncated = false;

  while (i < text.length && items.length < maxItems) {
    while (i < text.length && /[\s,]/.test(text[i]!)) {
      i += 1;
    }
    if (i >= text.length) {
      break;
    }
    const parsed = readJsonValueAt(text, i);
    if (!parsed) {
      truncated = true;
      break;
    }
    items.push(parsed.value);
    i = parsed.end;
  }

  if (items.length >= maxItems) {
    while (i < text.length && /[\s,]/.test(text[i]!)) {
      i += 1;
    }
    if (i < text.length) {
      truncated = true;
    }
  }

  return { items, truncated };
}

function readJsonValueAt(text: string, start: number): { value: unknown; end: number } | undefined {
  const slice = text.slice(start);
  try {
    // Use JSON.parse on progressively longer complete-looking prefixes via end scan.
    const end = findJsonValueEnd(text, start);
    if (end === undefined) {
      return undefined;
    }
    const value = JSON.parse(text.slice(start, end)) as unknown;
    return { value, end };
  } catch {
    void slice;
    return undefined;
  }
}

function findJsonValueEnd(text: string, start: number): number | undefined {
  const first = text[start];
  if (first === undefined) {
    return undefined;
  }

  if (first === '"') {
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] === '"') {
        return i + 1;
      }
      i += 1;
    }
    return undefined;
  }

  if (first === "{" || first === "[") {
    const open = first;
    const close = first === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i]!;
      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === open) {
        depth += 1;
      } else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          return i + 1;
        }
      }
    }
    return undefined;
  }

  // number / literal
  let i = start;
  while (i < text.length && !/[\s,\]}]/.test(text[i]!)) {
    i += 1;
  }
  if (i === start) {
    return undefined;
  }
  return i;
}

function looksIncomplete(text: string): boolean {
  const open = (text.match(/\[/g) ?? []).length;
  const close = (text.match(/\]/g) ?? []).length;
  return open > close;
}
