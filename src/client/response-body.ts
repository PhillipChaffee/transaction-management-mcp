/**
 * Bounded response-body helpers for auth and upstream error parsing.
 *
 * Caps materialization before JSON parse and cancels any unread remainder so
 * undici connections can be released. Parsed results expose only caller-selected
 * fields — never raw body dumps.
 */

export const MAX_AUTH_ERROR_BODY_BYTES = 64 * 1024;

export type ReadJsonBodyWithCapResult =
  { ok: true; value: unknown } | { ok: false; reason: "truncated" | "invalid-json" | "empty" };

export type ReadBytesWithCapOptions = {
  /**
   * When true (default), await stream cancel so undici can release the connection.
   * Codecs set false because some test transports hang on a drained cancel promise.
   */
  awaitCancel?: boolean;
};

/**
 * Read at most `maxBytes` from a Response, cancel the remainder, and JSON-parse.
 */
export async function readJsonBodyWithCap(
  response: Response,
  maxBytes: number = MAX_AUTH_ERROR_BODY_BYTES,
): Promise<ReadJsonBodyWithCapResult> {
  try {
    const { bytes, truncated } = await readBytesWithCap(response, maxBytes);
    if (truncated) {
      return { ok: false, reason: "truncated" };
    }
    if (bytes.byteLength === 0) {
      return { ok: false, reason: "empty" };
    }
    try {
      return { ok: true, value: JSON.parse(new TextDecoder("utf-8").decode(bytes)) as unknown };
    } catch {
      return { ok: false, reason: "invalid-json" };
    }
  } catch {
    await cancelResponseBody(response);
    return { ok: false, reason: "invalid-json" };
  }
}

/**
 * Cancel an unread response body so the underlying connection can be reused.
 */
export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    if (response.body && !response.bodyUsed) {
      await response.body.cancel();
    }
  } catch {
    // Ignore cancel failures; the connection may already be closed or locked.
  }
}

/**
 * Read at most `maxBytes` from a Response body and cancel any unread remainder.
 */
export async function readBytesWithCap(
  response: Response,
  maxBytes: number,
  options: ReadBytesWithCapOptions = {},
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const awaitCancel = options.awaitCancel ?? true;

  if (!response.body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      return { bytes: buffer.slice(0, maxBytes), truncated: true };
    }
    return { bytes: buffer, truncated: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      if (total >= maxBytes) {
        truncated = true;
        break;
      }
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        chunks.push(value.slice(0, remaining));
        total += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    if (awaitCancel) {
      try {
        await reader.cancel();
      } catch {
        // Already closed or locked after a full read — safe to ignore.
      }
    } else {
      void reader.cancel().catch(() => undefined);
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}
