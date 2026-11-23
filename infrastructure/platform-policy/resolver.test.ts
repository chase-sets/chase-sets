import { afterEach, describe, expect, it, vi } from "vitest";
import * as observability from "@chase-sets/observability";
import { createPolicyCache, POLICY_CACHE_MAX_AGE_MS } from "./cache";
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
    const resolver = createPolicyResolver({ db, cache: createPolicyCache({ now: () => 0 }) });

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
    const cache = createPolicyCache({ now: () => 0 });
    const resolver = createPolicyResolver({ db, cache });

    await resolver.resolvePolicy(holdDaysPolicy);
    cache.invalidate(holdDaysPolicy.policyKey);
    await resolver.resolvePolicy(holdDaysPolicy);

    expect((db as { query: ReturnType<typeof vi.fn> }).query).toHaveBeenCalledTimes(2);
  });
});

const at = "2026-05-01T00:00:00.000Z";

const neverLoadedPolicy = definePolicy({
  policyKey: "settlement.payout-bounds",
  contextName: "settlement",
  schemaSummary: "{ minimumCents: integer }",
  defaultValue: { minimumCents: 100 },
  decodeValue: (raw) => raw as { minimumCents: number },
});

function documentRow(documentId: string, holdDays: number) {
  return {
    document_id: documentId,
    value: { holdDays },
    effective_from: "2026-04-01T00:00:00.000Z",
    effective_until: null,
  };
}

/**
 * A resolver over a read model the test rewrites and a cache clock the test
 * moves, so each case states the age at which a resolution happens.
 */
function createHarness(initialRows: readonly Record<string, unknown>[] = []) {
  let rows = initialRows;
  let failure: Error | null = null;
  let nowMs = 1_700_000_000_000;
  const query = vi.fn(async () => {
    if (failure) {
      throw failure;
    }
    return { rows };
  });
  const cache = createPolicyCache({ now: () => nowMs });
  const resolver = createPolicyResolver({ db: { query } as never, cache });

  return {
    cache,
    query,
    resolver,
    resolve: () => resolver.resolvePolicy(holdDaysPolicy, { at }),
    setRows: (next: readonly Record<string, unknown>[]) => {
      rows = next;
    },
    failReads: (error: Error | null) => {
      failure = error;
    },
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function spyOnStaleServed() {
  return vi.spyOn(observability, "recordPlatformPolicyStaleServed").mockImplementation(() => undefined);
}

describe("createPolicyResolver bounded age", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("gives a cached empty set way to the first document once the set is one second old", async () => {
    const harness = createHarness([]);

    expect(await harness.resolve()).toMatchObject({ source: "fallback", value: { holdDays: 2 } });

    harness.setRows([documentRow("pol_1", 5)]);
    harness.advance(POLICY_CACHE_MAX_AGE_MS - 1);
    expect(await harness.resolve()).toMatchObject({ source: "fallback", value: { holdDays: 2 } });

    harness.advance(1);
    expect(await harness.resolve()).toMatchObject({ source: "policy", documentId: "pol_1", value: { holdDays: 5 } });
    expect(harness.query).toHaveBeenCalledTimes(2);
  });

  it("replaces the loaded set when a refresh returns an earlier revision or no rows", async () => {
    const harness = createHarness([documentRow("pol_1", 9)]);
    expect(await harness.resolve()).toMatchObject({ source: "policy", value: { holdDays: 9 } });

    harness.setRows([documentRow("pol_1", 5)]);
    harness.advance(POLICY_CACHE_MAX_AGE_MS);
    expect(await harness.resolve()).toMatchObject({ source: "policy", value: { holdDays: 5 } });

    harness.setRows([]);
    harness.advance(POLICY_CACHE_MAX_AGE_MS);
    expect(await harness.resolve()).toMatchObject({ source: "fallback", documentId: null, value: { holdDays: 2 } });
    expect(harness.cache.lastLoaded(holdDaysPolicy.policyKey)?.candidates).toEqual([]);
  });

  it("issues one read for many resolutions of a key inside one second", async () => {
    const harness = createHarness([documentRow("pol_1", 5)]);

    for (let resolution = 0; resolution < 50; resolution += 1) {
      await harness.resolve();
      harness.advance(10);
    }

    expect(harness.query).toHaveBeenCalledTimes(1);
  });

  it("shares one read among concurrent resolutions that find no fresh set", async () => {
    const harness = createHarness([documentRow("pol_1", 5)]);
    const release = deferred<void>();
    harness.query.mockImplementationOnce(async () => {
      await release.promise;
      return { rows: [documentRow("pol_1", 5)] };
    });

    const resolutions = [harness.resolve(), harness.resolve(), harness.resolve()];
    release.resolve();

    for (const resolved of await Promise.all(resolutions)) {
      expect(resolved).toMatchObject({ source: "policy", value: { holdDays: 5 } });
    }
    expect(harness.query).toHaveBeenCalledTimes(1);

    harness.advance(POLICY_CACHE_MAX_AGE_MS);
    await Promise.all([harness.resolve(), harness.resolve()]);
    expect(harness.query).toHaveBeenCalledTimes(2);
  });

  it("ages a set from when its read began, not from when the read returned", async () => {
    const harness = createHarness();
    const release = deferred<void>();
    harness.query.mockImplementationOnce(async () => {
      await release.promise;
      return { rows: [documentRow("pol_1", 5)] };
    });

    const pending = harness.resolve();
    harness.advance(600);
    release.resolve();
    await pending;
    harness.setRows([documentRow("pol_1", 7)]);

    harness.advance(399);
    expect(await harness.resolve()).toMatchObject({ value: { holdDays: 5 } });

    harness.advance(1);
    expect(await harness.resolve()).toMatchObject({ value: { holdDays: 7 } });
  });

  it("serves the loaded set when a refresh fails, records its key and age once, and reads again next time", async () => {
    const staleServed = spyOnStaleServed();
    const harness = createHarness([documentRow("pol_1", 5)]);
    await harness.resolve();

    harness.failReads(new Error("connection terminated"));
    harness.advance(1_500);

    expect(await harness.resolve()).toMatchObject({ source: "policy", documentId: "pol_1", value: { holdDays: 5 } });
    expect(harness.query).toHaveBeenCalledTimes(2);
    expect(staleServed.mock.calls).toEqual([
      [{ policyKey: "settlement.clearance-window", contextName: "settlement", ageMs: 1_500 }],
    ]);

    // The served set was not stored again: it is still stale and keeps its first stamp.
    expect(harness.cache.get(holdDaysPolicy.policyKey)).toBeUndefined();
    expect(harness.cache.lastLoaded(holdDaysPolicy.policyKey)?.readStartedAtMs).toBe(1_700_000_000_000);

    harness.advance(250);
    expect(await harness.resolve()).toMatchObject({ value: { holdDays: 5 } });
    expect(harness.query).toHaveBeenCalledTimes(3);
    expect(staleServed.mock.calls[1]).toEqual([
      { policyKey: "settlement.clearance-window", contextName: "settlement", ageMs: 1_750 },
    ]);

    harness.failReads(null);
    harness.setRows([documentRow("pol_1", 8)]);
    expect(await harness.resolve()).toMatchObject({ value: { holdDays: 8 } });
    expect(harness.query).toHaveBeenCalledTimes(4);
    expect(staleServed).toHaveBeenCalledTimes(2);
  });

  it("serves a loaded empty set as the compiled default when a refresh fails", async () => {
    const staleServed = spyOnStaleServed();
    const harness = createHarness([]);
    await harness.resolve();

    harness.failReads(new Error("connection terminated"));
    harness.advance(POLICY_CACHE_MAX_AGE_MS);

    expect(await harness.resolve()).toMatchObject({ source: "fallback", value: { holdDays: 2 } });
    expect(staleServed).toHaveBeenCalledTimes(1);
  });

  it("serves the loaded set when the read after an invalidation fails", async () => {
    const staleServed = spyOnStaleServed();
    const harness = createHarness([documentRow("pol_1", 5)]);
    await harness.resolve();

    harness.cache.invalidate(holdDaysPolicy.policyKey);
    harness.failReads(new Error("connection terminated"));
    harness.advance(20);

    expect(await harness.resolve()).toMatchObject({ value: { holdDays: 5 } });
    expect(staleServed.mock.calls).toEqual([
      [{ policyKey: "settlement.clearance-window", contextName: "settlement", ageMs: 20 }],
    ]);
  });

  it("shares one failed read among concurrent resolutions and serves each the loaded set", async () => {
    const staleServed = spyOnStaleServed();
    const harness = createHarness([documentRow("pol_1", 5)]);
    await harness.resolve();
    harness.advance(POLICY_CACHE_MAX_AGE_MS);
    const release = deferred<void>();
    harness.query.mockImplementationOnce(async () => {
      await release.promise;
      throw new Error("connection terminated");
    });

    const resolutions = [harness.resolve(), harness.resolve(), harness.resolve()];
    release.resolve();

    for (const resolved of await Promise.all(resolutions)) {
      expect(resolved).toMatchObject({ source: "policy", value: { holdDays: 5 } });
    }
    expect(harness.query).toHaveBeenCalledTimes(2);
    expect(staleServed).toHaveBeenCalledTimes(3);
  });

  it("rejects when the first read fails, caches nothing, and reads again next time", async () => {
    const staleServed = spyOnStaleServed();
    const harness = createHarness([documentRow("pol_1", 5)]);
    harness.failReads(new Error("connection terminated"));

    await expect(harness.resolve()).rejects.toThrow("connection terminated");
    expect(harness.cache.get(holdDaysPolicy.policyKey)).toBeUndefined();
    expect(harness.cache.lastLoaded(holdDaysPolicy.policyKey)).toBeUndefined();

    await expect(harness.resolve()).rejects.toThrow("connection terminated");
    expect(harness.query).toHaveBeenCalledTimes(2);

    harness.failReads(null);
    expect(await harness.resolve()).toMatchObject({ source: "policy", value: { holdDays: 5 } });
    expect(harness.query).toHaveBeenCalledTimes(3);
    expect(staleServed).not.toHaveBeenCalled();
  });

  it("rejects every concurrent resolution of one failed first read", async () => {
    const harness = createHarness();
    const release = deferred<void>();
    harness.query.mockImplementationOnce(async () => {
      await release.promise;
      throw new Error("connection terminated");
    });

    const resolutions = [harness.resolve(), harness.resolve()];
    release.resolve();

    expect((await Promise.allSettled(resolutions)).map((settled) => settled.status)).toEqual(["rejected", "rejected"]);
    expect(harness.query).toHaveBeenCalledTimes(1);
  });

  it("rejects a key that was never loaded while another key's loaded set is served", async () => {
    const staleServed = spyOnStaleServed();
    const harness = createHarness([documentRow("pol_1", 5)]);
    await harness.resolve();
    harness.failReads(new Error("connection terminated"));
    harness.advance(POLICY_CACHE_MAX_AGE_MS);

    await expect(harness.resolver.resolvePolicy(neverLoadedPolicy, { at })).rejects.toThrow("connection terminated");
    expect(await harness.resolve()).toMatchObject({ value: { holdDays: 5 } });
    expect(staleServed.mock.calls.map(([signal]) => signal.policyKey)).toEqual(["settlement.clearance-window"]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
