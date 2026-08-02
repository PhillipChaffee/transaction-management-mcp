import { describe, expect, it, vi } from "vitest";

import { TokenBucketRateLimiter } from "../../src/client/rate-limiter.ts";

describe("TokenBucketRateLimiter", () => {
  it("starts with capacity 100 and consumes one token per acquire", async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const limiter = new TokenBucketRateLimiter({
      now: () => now,
      sleep,
    });

    expect(limiter.capacity).toBe(100);
    expect(limiter.tokens).toBe(100);

    await limiter.acquire();
    expect(limiter.tokens).toBe(99);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("refills at 100 tokens per 60 seconds", async () => {
    let now = 0;
    const limiter = new TokenBucketRateLimiter({
      now: () => now,
      sleep: async () => undefined,
    });

    for (let i = 0; i < 100; i += 1) {
      await limiter.acquire();
    }
    expect(limiter.tokens).toBe(0);

    now += 30_000;
    expect(limiter.tokens).toBeCloseTo(50, 5);

    now += 30_000;
    expect(limiter.tokens).toBeCloseTo(100, 5);
  });

  it("waits when empty until refill provides a token", async () => {
    let now = 0;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const limiter = new TokenBucketRateLimiter({
      capacity: 1,
      refillPerMs: 1 / 1000,
      now: () => now,
      sleep,
    });

    await limiter.acquire();
    await limiter.acquire();

    expect(sleep).toHaveBeenCalled();
    expect(now).toBeGreaterThanOrEqual(1000);
  });

  it("honors deferUntil for Retry-After / rate-reset windows", async () => {
    let now = 1_000;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    const limiter = new TokenBucketRateLimiter({
      now: () => now,
      sleep,
    });

    limiter.deferUntil(5_000);
    await limiter.acquire();

    expect(now).toBe(5_000);
    expect(limiter.tokens).toBe(99);
  });

  it("serializes many concurrent deferred callers through one wait path", async () => {
    let now = 0;
    let activeSleeps = 0;
    let maxActiveSleeps = 0;
    const sleep = vi.fn(async (ms: number) => {
      activeSleeps += 1;
      maxActiveSleeps = Math.max(maxActiveSleeps, activeSleeps);
      now += ms;
      activeSleeps -= 1;
    });
    const limiter = new TokenBucketRateLimiter({
      capacity: 100,
      now: () => now,
      sleep,
    });

    limiter.deferUntil(10_000);
    const pending = Array.from({ length: 50 }, () => limiter.acquire());
    await Promise.all(pending);

    expect(limiter.tokens).toBe(50);
    expect(maxActiveSleeps).toBe(1);
    expect(sleep.mock.calls.length).toBeLessThan(50);
  });
});
