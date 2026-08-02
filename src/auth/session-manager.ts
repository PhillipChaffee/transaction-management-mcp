import { buildLoginAuth } from "./hmac.js";
import type { Credentials } from "../config/credentials.js";
import { SessionAuthError } from "../client/errors.js";

export type SessionCacheEntry = {
  session: string;
  expiration: Date;
};

export type SessionManagerOptions = {
  credentials: Credentials;
  /** Injectable login fetch (defaults to global fetch). */
  fetch?: typeof fetch;
  /** API origin, e.g. `https://api.skyslope.com`. */
  baseUrl?: string;
  /** Injectable clock. Defaults to `() => new Date()`. */
  clock?: () => Date;
  /**
   * Refresh when the cached session expires within this many milliseconds.
   * Defaults to 60_000. Never used as a token TTL — expiration comes from the login response.
   */
  refreshSkewMs?: number;
  /** Login path. Defaults to `/auth/login`. */
  loginPath?: string;
};

type LoginResponseBody = {
  Session?: unknown;
  Expiration?: unknown;
  session?: unknown;
  expiration?: unknown;
  value?: {
    Session?: unknown;
    Expiration?: unknown;
    session?: unknown;
    expiration?: unknown;
  };
};

const DEFAULT_BASE_URL = "https://api.skyslope.com";
const DEFAULT_LOGIN_PATH = "/auth/login";
const DEFAULT_REFRESH_SKEW_MS = 60_000;

/**
 * In-memory Session + Expiration cache with single-flight refresh.
 *
 * Uses the expiration returned by `/auth/login`; never hard-codes a token lifetime.
 * Errors never include credential, HMAC, or session values.
 */
export class SessionManager {
  readonly #credentials: Credentials;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #loginPath: string;
  readonly #clock: () => Date;
  readonly #refreshSkewMs: number;

  #cache: SessionCacheEntry | undefined;
  #inFlight: Promise<SessionCacheEntry> | undefined;

  constructor(options: SessionManagerOptions) {
    this.#credentials = options.credentials;
    this.#fetch = options.fetch ?? fetch;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#loginPath = options.loginPath ?? DEFAULT_LOGIN_PATH;
    this.#clock = options.clock ?? (() => new Date());
    this.#refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  }

  /** Return a cached session, refreshing proactively before expiration when needed. */
  async getSession(): Promise<SessionCacheEntry> {
    if (this.#isUsable(this.#cache)) {
      return this.#cache;
    }
    return this.#refresh(false);
  }

  /** Discard any cache and perform a login, sharing one in-flight promise with concurrent callers. */
  async forceRefresh(): Promise<SessionCacheEntry> {
    return this.#refresh(true);
  }

  /** Clear the in-memory cache without contacting the network (tests / logout). */
  clear(): void {
    this.#cache = undefined;
  }

  #isUsable(entry: SessionCacheEntry | undefined): entry is SessionCacheEntry {
    if (!entry) {
      return false;
    }
    const refreshAt = entry.expiration.getTime() - this.#refreshSkewMs;
    return this.#clock().getTime() < refreshAt;
  }

  async #refresh(force: boolean): Promise<SessionCacheEntry> {
    if (!force && this.#isUsable(this.#cache)) {
      return this.#cache;
    }
    if (this.#inFlight) {
      return this.#inFlight;
    }

    this.#inFlight = this.#login()
      .then((entry) => {
        this.#cache = entry;
        return entry;
      })
      .finally(() => {
        this.#inFlight = undefined;
      });

    return this.#inFlight;
  }

  async #login(): Promise<SessionCacheEntry> {
    const auth = buildLoginAuth(this.#credentials, this.#clock());
    const url = `${this.#baseUrl}${this.#loginPath}`;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: auth.headers,
        body: JSON.stringify(auth.body),
      });
    } catch {
      throw new SessionAuthError("Authentication request failed");
    }

    if (!response.ok) {
      // Drain body without retaining credential-bearing content.
      try {
        await response.arrayBuffer();
      } catch {
        // ignore
      }
      throw new SessionAuthError("Authentication failed", response.status);
    }

    let body: LoginResponseBody;
    try {
      body = (await response.json()) as LoginResponseBody;
    } catch {
      throw new SessionAuthError("Authentication response was not valid JSON", response.status);
    }

    const session = pickSession(body);
    const expirationRaw = pickExpiration(body);
    if (!session || !expirationRaw) {
      throw new SessionAuthError("Authentication response missing Session or Expiration");
    }

    const expiration = new Date(expirationRaw);
    if (Number.isNaN(expiration.getTime())) {
      throw new SessionAuthError("Authentication response Expiration was not a valid date");
    }

    return { session, expiration };
  }
}

function pickSession(body: LoginResponseBody): string | undefined {
  const candidates = [body.Session, body.session, body.value?.Session, body.value?.session];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function pickExpiration(body: LoginResponseBody): string | undefined {
  const candidates = [
    body.Expiration,
    body.expiration,
    body.value?.Expiration,
    body.value?.expiration,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}
