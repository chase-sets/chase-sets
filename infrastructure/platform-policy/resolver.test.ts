import { describe, expect, it, vi } from "vitest";
import { createPolicyCache } from "./cache";
import { definePolicy } from "./define-policy";
import { createPolicyResolver } from "./resolver";

const holdDaysPolicy = definePolicy({
  policyKey: "settlement.clearance-window",
  contextName: "settlement",
  schemaSummary: "{ holdDays: integer }",
  defaultValue: { holdDays: 2 },
  decodeValue: (raw) => {
    const value = raw as { holdDays?: unknown };
    if (typeof value.holdDays !== "number") {
      throw new Error("holdDays must be a number.");
    }
    return { holdDays: value.holdDays };
  },
});

function fakeDb(rows: readonly Record<string, unknown>[]) {
  const query = vi.fn(async () => ({ rows }));
  return { query } as never;
}

describe("createPolicyResolver", () => {
  it("falls back to the compiled default when no document row exists", async () => {
    const resolver = createPolicyResolver({ db: fakeDb([]) });

    const resolved = await resolver.resolvePolicy(holdDaysPolicy, { at: "2026-05-01T00:00:00.000Z" });

    expect(resolved).toMatchObject({
      policyKey: "settlement.clearance-window",
      value: { holdDays: 2 },
      source: "fallback",
      documentId: null,
    });
  });

  it("falls back to the default when every document's window excludes the requested instant", async () => {
    const resolver = createPolicyResolver({
      db: fakeDb([
        {
          document_id: "pol_1",
          value: { holdDays: 5 },
          effective_from: "2026-06-01T00:00:00.000Z",
          effective_until: null,
        },
      ]),
    });

    const resolved = await resolver.resolvePolicy(holdDaysPolicy, { at: "2026-01-01T00:00:00.000Z" });

    expect(resolved.source).toBe("fallback");
    expect(resolved.value).toEqual({ holdDays: 2 });
  });

  it("resolves the document whose window covers the requested instant", async () => {
    const resolver = createPolicyResolver({
      db: fakeDb([
        {
          document_id: "pol_future",
          value: { holdDays: 7 },
          effective_from: "2026-08-01T00:00:00.000Z",
          effective_until: null,
        },
        {
          document_id: "pol_current",
          value: { holdDays: 5 },
          effective_from: "2026-04-01T00:00:00.000Z",
          effective_until: "2026-08-01T00:00:00.000Z",
        },
      ]),
    });

    const resolved = await resolver.resolvePolicy(holdDaysPolicy, { at: "2026-05-01T00:00:00.000Z" });

    expect(resolved).toMatchObject({
      source: "policy",
      documentId: "pol_current",
      value: { holdDays: 5 },
    });
  });

  it("caches the candidate set across repeated resolutions and reuses it on cache hit", async () => {
    const db = fakeDb([
      {
        document_id: "pol_1",
        value: { holdDays: 5 },
        effective_from: "2026-04-01T00:00:00.000Z",
        effective_until: null,
      },
    ]);
    const resolver = createPolicyResolver({ db, cache: createPolicyCache() });

    await resolver.resolvePolicy(holdDaysPolicy, { at: "2026-05-01T00:00:00.000Z" });
    await resolver.resolvePolicy(holdDaysPolicy, { at: "2026-06-01T00:00:00.000Z" });

    expect((db as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledTimes(1);
  });

  it("re-reads Postgres after the cache is invalidated for that policy key", async () => {
    const db = fakeDb([
      {
        document_id: "pol_1",
        value: { holdDays: 5 },
        effective_from: "2026-04-01T00:00:00.000Z",
        effective_until: null,
      },
    ]);
    const cache = createPolicyCache();
    const resolver = createPolicyResolver({ db, cache });

    await resolver.resolvePolicy(holdDaysPolicy);
    cache.invalidate(holdDaysPolicy.policyKey);
    await resolver.resolvePolicy(holdDaysPolicy);

    expect((db as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledTimes(2);
  });
});
