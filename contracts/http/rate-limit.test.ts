import { describe, expect, it } from "vitest";
import { createInMemoryRateLimiter, publicClientRequestKey } from "./rate-limit";

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
