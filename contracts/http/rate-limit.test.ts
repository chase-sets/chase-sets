import { describe, expect, it, vi } from "vitest";
import {
  clearRateLimitExceededCounters,
  createConfiguredInMemoryRateLimiter,
  createInMemoryRateLimiter,
  createPolicyBackedRateLimiter,
  getRateLimitExceededCounters,
  publicClientRequestKey,
  rateLimitExceededJsonResponse,
  resolveRateLimitRule,
} from "./rate-limit";

describe("in-memory rate limiter", () => {
  it("uses forwarded client identity before local fallback", () => {
    expect(
      publicClientRequestKey(
        new Request("http://example.test", {
          headers: {
            "x-forwarded-for": "203.0.113.10, 198.51.100.1",
            "cf-connecting-ip": "203.0.113.11",
          },
        }),
      ),
    ).toBe("203.0.113.10");
    expect(
      publicClientRequestKey(
        new Request("http://example.test", {
          headers: {
            "cf-connecting-ip": "203.0.113.11",
          },
        }),
      ),
    ).toBe("203.0.113.11");
    expect(publicClientRequestKey(new Request("http://example.test"))).toBe("local");
  });

  it("limits requests until the window resets", () => {
    let now = new Date("2026-06-11T12:00:00.000Z").getTime();
    const limiter = createInMemoryRateLimiter({
      keyPrefix: "test",
      max: 2,
      windowMs: 60_000,
      now: () => now,
    });

    expect(limiter.check("client_1")).toMatchObject({ limited: false, remaining: 1 });
    expect(limiter.check("client_1")).toMatchObject({ limited: false, remaining: 0 });
    expect(limiter.check("client_1")).toMatchObject({
      limited: true,
      key: "test:client_1",
      count: 3,
      limit: 2,
      remaining: 0,
      retryAfterSeconds: 60,
    });

    now += 60_001;
    expect(limiter.check("client_1")).toMatchObject({ limited: false, count: 1, remaining: 1 });
  });

  it("peeks without consuming failure-only buckets", () => {
    const limiter = createInMemoryRateLimiter({
      keyPrefix: "failure",
      max: 2,
      windowMs: 60_000,
      now: () => new Date("2026-06-11T12:00:00.000Z").getTime(),
    });

    expect(limiter.peek("client_1")).toMatchObject({ limited: false, count: 0, remaining: 2 });
    expect(limiter.check("client_1")).toMatchObject({ limited: false, count: 1, remaining: 1 });
    expect(limiter.peek("client_1")).toMatchObject({ limited: false, count: 1, remaining: 1 });
    expect(limiter.check("client_1")).toMatchObject({ limited: false, count: 2, remaining: 0 });
    expect(limiter.peek("client_1")).toMatchObject({ limited: true, count: 2, remaining: 0 });
  });

  it("resolves env overrides and kill switches per surface", () => {
    const env = {
      CHASE_SETS_RATE_LIMIT_AUTH_SIGN_IN_IP_FAILURES_MAX: "7",
      CHASE_SETS_RATE_LIMIT_AUTH_SIGN_IN_IP_FAILURES_WINDOW_MS: "120000",
      CHASE_SETS_RATE_LIMIT_AUTH_SIGN_IN_IP_FAILURES_DISABLED: "true",
    };

    expect(resolveRateLimitRule("auth.sign-in.ip-failures", { max: 5, windowMs: 60_000 }, env)).toEqual({
      max: 7,
      windowMs: 120_000,
      disabled: true,
    });
  });

  it("can disable configured limiters without consuming buckets", () => {
    const limiter = createConfiguredInMemoryRateLimiter(
      "auth.register.ip",
      { max: 1, windowMs: 60_000 },
      {
        env: { CHASE_SETS_RATE_LIMIT_AUTH_REGISTER_IP_DISABLED: "true" },
      },
    );

    expect(limiter.check("client_1")).toMatchObject({ limited: false, count: 0, remaining: 1 });
    expect(limiter.check("client_1")).toMatchObject({ limited: false, count: 0, remaining: 1 });
  });

  it("records a support-safe counter for limit exceeded responses", async () => {
    clearRateLimitExceededCounters();
    const response = rateLimitExceededJsonResponse("auth.register.ip", {
      limited: true,
      key: "auth.register.ip:client_1",
      count: 4,
      limit: 3,
      remaining: 0,
      resetAt: Date.now() + 60_000,
      retryAfterSeconds: 60,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "rate_limited", surface: "auth.register.ip", retryAfterSeconds: 60 },
    });
    expect(getRateLimitExceededCounters()).toEqual({ "auth.register.ip": 1 });
  });

  it("bounds stored client buckets", () => {
    const limiter = createInMemoryRateLimiter({
      keyPrefix: "bounded",
      max: 1,
      maxBuckets: 2,
      windowMs: 60_000,
      now: () => new Date("2026-06-11T12:00:00.000Z").getTime(),
    });

    expect(limiter.check("client_1")).toMatchObject({ limited: false });
    expect(limiter.check("client_2")).toMatchObject({ limited: false });
    expect(limiter.check("client_3")).toMatchObject({ limited: false });

    expect(limiter.check("client_1")).toMatchObject({ limited: false, count: 1 });
  });
});

describe("policy-backed rate limiter", () => {
  const defaults = { max: 2, windowMs: 60_000 };

  it("behaves identically to the compiled defaults when the resolver echoes them back", async () => {
    let now = new Date("2026-06-11T12:00:00.000Z").getTime();
    const limiter = createPolicyBackedRateLimiter(
      "test.surface",
      defaults,
      async (_surface, resolverDefaults) => resolverDefaults,
      { keyPrefix: "test", now: () => now },
    );

    await expect(limiter.check("client_1")).resolves.toMatchObject({ limited: false, remaining: 1 });
    await expect(limiter.check("client_1")).resolves.toMatchObject({ limited: false, remaining: 0 });
    await expect(limiter.check("client_1")).resolves.toMatchObject({ limited: true, count: 3, remaining: 0 });

    now += 60_001;
    await expect(limiter.check("client_1")).resolves.toMatchObject({ limited: false, count: 1 });
  });

  it("re-resolves the rule on every check, so a revision changes enforcement without resetting counters", async () => {
    let rule = { max: 1, windowMs: 60_000 };
    const limiter = createPolicyBackedRateLimiter("test.surface", defaults, async () => rule, {
      keyPrefix: "test",
      now: () => new Date("2026-06-11T12:00:00.000Z").getTime(),
    });

    await expect(limiter.check("client_1")).resolves.toMatchObject({ limited: false, count: 1, remaining: 0 });
    await expect(limiter.check("client_1")).resolves.toMatchObject({ limited: true, count: 2 });

    // The operator revises the policy mid-incident: raise the ceiling.
    rule = { max: 5, windowMs: 60_000 };
    await expect(limiter.check("client_1")).resolves.toMatchObject({ limited: false, count: 3, remaining: 2 });
  });

  it("honors a per-surface kill switch resolved from policy", async () => {
    const limiter = createPolicyBackedRateLimiter(
      "test.surface",
      defaults,
      async () => ({ max: 1, windowMs: 60_000, disabled: true }),
      { keyPrefix: "test" },
    );

    await expect(limiter.check("client_1")).resolves.toMatchObject({ limited: false, count: 0 });
    await expect(limiter.check("client_1")).resolves.toMatchObject({ limited: false, count: 0 });
  });

  it("fails safe to the compiled defaults when the resolver throws (policy store unavailable)", async () => {
    let now = new Date("2026-06-11T12:00:00.000Z").getTime();
    const resolveRule = vi.fn(async () => {
      throw new Error("policy store unavailable");
    });
    const limiter = createPolicyBackedRateLimiter("test.surface", defaults, resolveRule, {
      keyPrefix: "test",
      now: () => now,
    });

    await expect(limiter.check("client_1")).resolves.toMatchObject({ limited: false, remaining: 1 });
    await expect(limiter.check("client_1")).resolves.toMatchObject({ limited: false, remaining: 0 });
    await expect(limiter.check("client_1")).resolves.toMatchObject({ limited: true, count: 3 });
    expect(resolveRule).toHaveBeenCalledTimes(3);
  });

  it("gives two limiters independent bucket stores under a shared surface name", async () => {
    const cart = createPolicyBackedRateLimiter("checkout.anonymous-rail-capture", defaults, async () => defaults, {
      keyPrefix: "checkout:anonymous-cart-capture",
    });
    const sellList = createPolicyBackedRateLimiter("checkout.anonymous-rail-capture", defaults, async () => defaults, {
      keyPrefix: "checkout:anonymous-sell-list-capture",
    });

    await expect(cart.check("client_1")).resolves.toMatchObject({ count: 1 });
    await expect(cart.check("client_1")).resolves.toMatchObject({ count: 2 });
    await expect(sellList.check("client_1")).resolves.toMatchObject({ count: 1 });
  });
});
