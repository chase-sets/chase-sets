import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createNoopRateLimitPolicyResolver, createRateLimitPolicyResolver } from "./rate-limit-policy-resolver";

const defaults = { max: 30, windowMs: 10 * 60 * 1000 };

const operatorDocument = {
  document_id: "pol_1",
  value: { incidentMultiplier: 2, surfaces: { "checkout.anonymous-rail-capture": { max: 40 } } },
  effective_from: "2020-01-01T00:00:00.000Z",
  effective_until: null,
};

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
    const db = stubDb([operatorDocument]);
    const resolveRateLimitRule = createRateLimitPolicyResolver(db);

    await expect(resolveRateLimitRule("checkout.anonymous-rail-capture", defaults)).resolves.toEqual({
      max: 20,
      windowMs: 10 * 60 * 1000,
      disabled: false,
    });
  });

  it("issues one read for calls within one second and reads again once the loaded value is a second old", async () => {
    let now = 0;
    const db = stubDb([]);
    const query = db.query as ReturnType<typeof vi.fn>;
    const resolveRateLimitRule = createRateLimitPolicyResolver(db, { now: () => now });

    await resolveRateLimitRule("public-presence.waitlist.submit", defaults);
    await resolveRateLimitRule("public-presence.waitlist.submit", defaults);
    now += 999;
    await resolveRateLimitRule("checkout.anonymous-rail-capture", defaults);
    expect(query).toHaveBeenCalledTimes(1);

    now += 1;
    await resolveRateLimitRule("public-presence.waitlist.submit", defaults);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent refreshes into a single query", async () => {
    const db = stubDb([]);
    const query = db.query as ReturnType<typeof vi.fn>;
    const resolveRateLimitRule = createRateLimitPolicyResolver(db, { now: () => 0 });

    await Promise.all([
      resolveRateLimitRule("public-presence.waitlist.submit", defaults),
      resolveRateLimitRule("public-presence.waitlist.submit", defaults),
      resolveRateLimitRule("checkout.anonymous-rail-capture", defaults),
    ]);

    expect(query).toHaveBeenCalledTimes(1);
  });

  it("ages the loaded value from when its read began, with no interval of its own", async () => {
    let now = 0;
    const db = stubDb([]);
    const query = db.query as ReturnType<typeof vi.fn>;
    query.mockImplementationOnce(async () => {
      now += 700;
      return { rows: [] };
    });
    const resolveRateLimitRule = createRateLimitPolicyResolver(db, { now: () => now });

    await resolveRateLimitRule("public-presence.waitlist.submit", defaults);
    now += 300;
    await resolveRateLimitRule("public-presence.waitlist.submit", defaults);

    expect(query).toHaveBeenCalledTimes(2);
  });

  it("keeps applying the operator's loaded value, not the compiled rule, when a refresh fails", async () => {
    let now = 0;
    const db = stubDb([operatorDocument]);
    const query = db.query as ReturnType<typeof vi.fn>;
    const resolveRateLimitRule = createRateLimitPolicyResolver(db, { now: () => now });
    const operatorRule = { max: 20, windowMs: 10 * 60 * 1000, disabled: false };

    await expect(resolveRateLimitRule("checkout.anonymous-rail-capture", defaults)).resolves.toEqual(operatorRule);

    query.mockRejectedValue(new Error("connection terminated"));
    now += 5_000;
    await expect(resolveRateLimitRule("checkout.anonymous-rail-capture", defaults)).resolves.toEqual(operatorRule);
    await expect(resolveRateLimitRule("checkout.anonymous-rail-capture", defaults)).resolves.toEqual(operatorRule);

    // Each call during the outage made its own attempt: nothing here memoizes the failure or the value.
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("rejects when the first read fails, so the limiter falls to the compiled rule", async () => {
    const db = stubDb([operatorDocument]);
    const query = db.query as ReturnType<typeof vi.fn>;
    query.mockRejectedValueOnce(new Error("connection terminated"));
    const resolveRateLimitRule = createRateLimitPolicyResolver(db, { now: () => 0 });

    await expect(resolveRateLimitRule("checkout.anonymous-rail-capture", defaults)).rejects.toThrow(
      "connection terminated",
    );
    await expect(resolveRateLimitRule("checkout.anonymous-rail-capture", defaults)).resolves.toMatchObject({ max: 20 });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe("createNoopRateLimitPolicyResolver", () => {
  it("always returns the caller's compiled defaults unchanged", async () => {
    const resolveRateLimitRule = createNoopRateLimitPolicyResolver();

    await expect(resolveRateLimitRule("checkout.anonymous-rail-capture", defaults)).resolves.toBe(defaults);
  });
});
