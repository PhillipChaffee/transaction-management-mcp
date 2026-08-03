export type Clock = () => number;
export type Sleep = (ms: number) => Promise<void>;

export type TokenBucketOptions = {
  /** Maximum tokens in the bucket. Defaults to 100. */
  capacity?: number;
  /** Tokens added per millisecond. Defaults to 100 / 60_000. */
  refillPerMs?: number;
  /** Injectable millisecond clock. Defaults to `Date.now`. */
  now?: Clock;
  /** Injectable sleep. Defaults to a `setTimeout` promise. */
  sleep?: Sleep;
};

const DEFAULT_CAPACITY = 100;
const DEFAULT_REFILL_PER_MS = 100 / 60_000;

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Process-wide token bucket with optional defer-until support for Retry-After / rate reset.
 *
 * Capacity 100 and refill 100 tokens / 60 seconds match the Transaction Management quota.
 * Acquisitions are serialized through a FIFO promise queue so many concurrent waiters share
 * a single sleep path instead of creating one timer per waiter.
 */
export class TokenBucketRateLimiter {
  readonly capacity: number;
  readonly refillPerMs: number;

  #tokens: number;
  #updatedAtMs: number;
  #deferUntilMs = 0;
  #tail: Promise<void> = Promise.resolve();
  readonly #now: Clock;
  readonly #sleep: Sleep;

  constructor(options: TokenBucketOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
    this.refillPerMs = options.refillPerMs ?? DEFAULT_REFILL_PER_MS;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#tokens = this.capacity;
    this.#updatedAtMs = this.#now();
  }

  /** Current token balance after applying refill (for tests). */
  get tokens(): number {
    this.#refill();
    return this.#tokens;
  }

  /** Earliest time requests may proceed after a defer (for tests). */
  get deferUntilMs(): number {
    return this.#deferUntilMs;
  }

  /**
   * Pause acquisition until the given epoch milliseconds (Retry-After / x-ratelimit-reset).
   *
   * Later deadlines replace earlier ones; past deadlines are ignored.
   */
  deferUntil(epochMs: number): void {
    const now = this.#now();
    if (epochMs <= now) {
      return;
    }
    if (epochMs > this.#deferUntilMs) {
      this.#deferUntilMs = epochMs;
    }
  }

  /**
   * Wait until the defer window has elapsed and one token is available, then consume it.
   */
  async acquire(): Promise<void> {
    const run = this.#tail.then(() => this.#acquireSerialized());
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #acquireSerialized(): Promise<void> {
    for (;;) {
      const now = this.#now();
      if (this.#deferUntilMs > now) {
        await this.#sleep(this.#deferUntilMs - now);
        continue;
      }

      this.#refill();
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }

      const missing = 1 - this.#tokens;
      const waitMs = Math.ceil(missing / this.refillPerMs);
      await this.#sleep(Math.max(waitMs, 1));
    }
  }

  #refill(): void {
    const now = this.#now();
    const elapsed = Math.max(0, now - this.#updatedAtMs);
    if (elapsed > 0) {
      this.#tokens = Math.min(this.capacity, this.#tokens + elapsed * this.refillPerMs);
      this.#updatedAtMs = now;
    }
  }
}
