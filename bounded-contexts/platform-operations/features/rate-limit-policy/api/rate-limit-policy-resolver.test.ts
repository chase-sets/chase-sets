import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createNoopRateLimitPolicyResolver, createRateLimitPolicyResolver } from "./rate-limit-policy-resolver";

const defaults = { max: 30, windowMs: 10 * 60 * 1000 };

function stubDb(rows: readonly Record<string, unknown>[]) {
  return { query: vi.fn(async () => ({ rows })) } as unknown as PgQueryable;
}

describe("createRateLimitPolicyResolver", () => {
  it("resolves the compiled defaults when no policy document is active", async () => {
    const db = stubDb([]);
    const resolveRateLimitRule = createRateLimitPolicyResolver(db);

    await expect(resolveRateLimitRule("checkout.anonymous-rail-capture", defaults)).resolves.toEqual({
      max: 30,
      windowMs: 10 * 60 * 1000,
      disabled: false,
    });
  });

  it("applies an active policy document's overrides and incident multiplier", async () => {
    const db = stubDb([
      {
        document_id: "pol_1",
        value: { incidentMultiplier: 2, surfaces: { "checkout.anonymous-rail-capture": { max: 40 } } },
        effective_from: "2020-01-01T00:00:00.000Z",
        effective_until: null,
      },
    ]);
    const resolveRateLimitRule = createRateLimitPolicyResolver(db);

    await expect(resolveRateLimitRule("checkout.anonymous-rail-capture", defaults)).resolves.toEqual({
      max: 20,
      windowMs: 10 * 60 * 1000,
      disabled: false,
    });
  });

  it("memoizes the policy value within the refresh window instead of re-querying every call", async () => {
    let now = 0;
    const db = stubDb([]);
    const query = db.query as ReturnType<typeof vi.fn>;
    const resolveRateLimitRule = createRateLimitPolicyResolver(db, { refreshIntervalMs: 1_000, now: () => now });

    await resolveRateLimitRule("public-presence.waitlist.submit", defaults);
    await resolveRateLimitRule("public-presence.waitlist.submit", defaults);
    await resolveRateLimitRule("checkout.anonymous-rail-capture", defaults);
    expect(query).toHaveBeenCalledTimes(1);

    now += 1_001;
    await resolveRateLimitRule("public-presence.waitlist.submit", defaults);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent refreshes into a single query", async () => {
    let now = 0;
    const db = stubDb([]);
    const query = db.query as ReturnType<typeof vi.fn>;
    const resolveRateLimitRule = createRateLimitPolicyResolver(db, { refreshIntervalMs: 1_000, now: () => now });

    await Promise.all([
      resolveRateLimitRule("public-presence.waitlist.submit", defaults),
      resolveRateLimitRule("public-presence.waitlist.submit", defaults),
      resolveRateLimitRule("checkout.anonymous-rail-capture", defaults),
    ]);

    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("createNoopRateLimitPolicyResolver", () => {
  it("always returns the caller's compiled defaults unchanged", async () => {
    const resolveRateLimitRule = createNoopRateLimitPolicyResolver();

    await expect(resolveRateLimitRule("checkout.anonymous-rail-capture", defaults)).resolves.toBe(defaults);
  });
});
