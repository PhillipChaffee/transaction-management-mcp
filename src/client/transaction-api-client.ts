import createClient from "openapi-fetch";

import { formatUtcTimestamp } from "../auth/hmac.js";
import type { SessionManager } from "../auth/session-manager.js";
import type { paths } from "../generated/openapi.js";
import {
  AmbiguousCompletionError,
  isRetryableHttpStatus,
  mapUpstreamError,
  NetworkRequestError,
} from "./errors.js";
import type { TokenBucketRateLimiter } from "./rate-limiter.js";
import { cancelResponseBody } from "./response-body.js";

export type FetchLike = (input: Request) => Promise<Response>;
export type ClockFn = () => Date;
export type SleepFn = (ms: number) => Promise<void>;

export const DEFAULT_API_BASE_URL = "https://api.skyslope.com";
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const GET_MAX_RETRIES = 2;

export type TransactionApiClientOptions = {
  sessionManager: SessionManager;
  rateLimiter: TokenBucketRateLimiter;
  /** Injectable fetch. Defaults to global fetch. */
  fetch?: FetchLike | typeof fetch;
  baseUrl?: string;
  clock?: ClockFn;
  sleep?: SleepFn;
  timeoutMs?: number;
};

export type ApiRequestInit = {
  method: string;
  /** Absolute API path beginning with `/`, e.g. `/api/sales`. */
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: RequestInit["headers"];
  body?: RequestInit["body"];
  /**
   * How to parse a successful response.
   * Use `response` to receive the raw Response (caller owns body consumption).
   */
  parseAs?: "json" | "text" | "arrayBuffer" | "blob" | "response";
};

export type ApiSuccess<T = unknown> = {
  data: T;
  response: Response;
};

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Fetch-based Transaction Management client boundary.
 *
 * Always sends `Session` and `Timestamp`. GET requests may retry at most twice for
 * pre-response network failures or 408/429/502/503, and may perform one session
 * refresh retry on 401. Writes never retry — including on 401 or ambiguous completion.
 *
 * Dynamic `request()` stays the primary binder surface. `createOpenApiClient()` wraps
 * the same pipeline with `openapi-fetch` for typed path helpers without unsafe casts.
 */
export class TransactionApiClient {
  readonly #sessionManager: SessionManager;
  readonly #rateLimiter: TokenBucketRateLimiter;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;
  readonly #clock: ClockFn;
  readonly #sleep: SleepFn;
  readonly #timeoutMs: number;

  constructor(options: TransactionApiClientOptions) {
    this.#sessionManager = options.sessionManager;
    this.#rateLimiter = options.rateLimiter;
    this.#fetch = normalizeFetch(options.fetch ?? fetch);
    this.#baseUrl = (options.baseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, "");
    this.#clock = options.clock ?? (() => new Date());
    this.#sleep = options.sleep ?? defaultSleep;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  /**
   * Create an `openapi-fetch` client that shares this instance's auth/retry pipeline.
   *
   * Prefer `request()` for binder-driven dynamic operation dispatch.
   */
  createOpenApiClient() {
    return createClient<paths>({
      baseUrl: this.#baseUrl,
      fetch: (input) => this.dispatch(input),
    });
  }

  /**
   * Perform an authenticated API call with method/path dynamic dispatch.
   */
  async request<T = unknown>(init: ApiRequestInit): Promise<ApiSuccess<T>> {
    const url = this.#buildUrl(init.path, init.query);
    const requestInit: RequestInit = {
      method: init.method.toUpperCase(),
      body: init.body ?? null,
    };
    if (init.headers !== undefined) {
      requestInit.headers = init.headers;
    }
    const request = new Request(url, requestInit);
    const response = await this.dispatch(request);
    if (init.parseAs === "response") {
      return { data: response as T, response };
    }
    if (response.status === 204) {
      return { data: undefined as T, response };
    }
    const data = (await parseBody(response, init.parseAs ?? "json")) as T;
    return { data, response };
  }

  /**
   * Authenticated fetch entry point used by `request()` and `openapi-fetch`.
   */
  async dispatch(input: Request): Promise<Response> {
    const method = input.method.toUpperCase();
    const isGet = method === "GET";
    let transportRetries = 0;
    let sessionRefreshUsed = false;

    for (;;) {
      await this.#rateLimiter.acquire();

      const session = await this.#sessionManager.getSession();
      const timestamp = formatUtcTimestamp(this.#clock());
      const headers = new Headers(input.headers);
      headers.set("Session", session.session);
      headers.set("Timestamp", timestamp);
      if (!headers.has("Accept")) {
        headers.set("Accept", "application/json");
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => {
        controller.abort();
      }, this.#timeoutMs);

      const callerSignal = input.signal;
      const onCallerAbort = (): void => {
        controller.abort();
      };
      if (callerSignal) {
        if (callerSignal.aborted) {
          controller.abort();
        } else {
          callerSignal.addEventListener("abort", onCallerAbort, { once: true });
        }
      }

      let response: Response;
      try {
        const outbound = new Request(input, {
          headers,
          signal: controller.signal,
        });
        response = await this.#fetch(outbound);
      } catch (error) {
        const timedOut = isAbortError(error);
        const message = timedOut ? "Request timed out" : "Network request failed";

        if (isGet && transportRetries < GET_MAX_RETRIES) {
          transportRetries += 1;
          continue;
        }
        if (!isGet) {
          throw new AmbiguousCompletionError(
            `${message}; write completion is ambiguous — read the current resource state before retrying`,
          );
        }
        throw new NetworkRequestError(message, {
          retryable: false,
          ambiguous: timedOut,
        });
      } finally {
        clearTimeout(timeout);
        if (callerSignal) {
          callerSignal.removeEventListener("abort", onCallerAbort);
        }
      }

      if (response.status === 429) {
        this.#applyRateLimitHeaders(response.headers);
      }

      if (response.status === 401) {
        if (isGet && !sessionRefreshUsed) {
          sessionRefreshUsed = true;
          await cancelResponseBody(response);
          await this.#sessionManager.forceRefresh();
          continue;
        }
        throw await mapUpstreamError(response);
      }

      if (isGet && isRetryableHttpStatus(response.status) && transportRetries < GET_MAX_RETRIES) {
        transportRetries += 1;
        const delayMs = retryDelayMs(response.headers, this.#clock);
        await cancelResponseBody(response);
        if (delayMs > 0) {
          await this.#sleep(delayMs);
        }
        continue;
      }

      if (!response.ok) {
        throw await mapUpstreamError(response);
      }

      return response;
    }
  }

  #buildUrl(
    path: string,
    query?: Record<string, string | number | boolean | null | undefined>,
  ): string {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.#baseUrl}${normalized}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) {
          continue;
        }
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  #applyRateLimitHeaders(headers: Headers): void {
    const retryAfter = headers.get("retry-after");
    if (retryAfter) {
      const until = parseRetryAfter(retryAfter, this.#clock);
      if (until !== undefined) {
        this.#rateLimiter.deferUntil(until);
      }
    }

    const reset =
      headers.get("x-ratelimit-reset") ??
      headers.get("ratelimit-reset") ??
      headers.get("x-rate-limit-reset");
    if (reset) {
      const until = parseRateLimitReset(reset, this.#clock);
      if (until !== undefined) {
        this.#rateLimiter.deferUntil(until);
      }
    }
  }
}

function normalizeFetch(fetchImpl: FetchLike | typeof fetch): FetchLike {
  return (input: Request) => Promise.resolve(fetchImpl(input));
}

async function parseBody(
  response: Response,
  parseAs: "json" | "text" | "arrayBuffer" | "blob",
): Promise<unknown> {
  switch (parseAs) {
    case "json":
      return response.json();
    case "text":
      return response.text();
    case "arrayBuffer":
      return response.arrayBuffer();
    case "blob":
      return response.blob();
    default: {
      const _exhaustive: never = parseAs;
      return _exhaustive;
    }
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  );
}

function parseRetryAfter(value: string, clock: ClockFn): number | undefined {
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return clock().getTime() + Math.max(0, seconds) * 1000;
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    return dateMs;
  }
  return undefined;
}

function parseRateLimitReset(value: string, clock: ClockFn): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return parseRetryAfter(value, clock);
  }
  // Heuristic: values that look like epoch seconds vs absolute ms vs delay seconds.
  if (numeric > 1_000_000_000_000) {
    return numeric;
  }
  if (numeric > 1_000_000_000) {
    return numeric * 1000;
  }
  return clock().getTime() + Math.max(0, numeric) * 1000;
}

function retryDelayMs(headers: Headers, clock: ClockFn): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const until = parseRetryAfter(retryAfter, clock);
    if (until !== undefined) {
      return Math.max(0, until - clock().getTime());
    }
  }
  return 0;
}
