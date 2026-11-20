import { describe, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createCountStore } from "../read-model/count-store";
import {
  CountAcquisitionRefused,
  CountPeriodCapRefused,
  countEvidenceSchema,
  countSourceIsCurrent,
  countResultSchema,
  countFingerprint,
  type CountAdmission,
  type CountTarget,
} from "../domain/count-acquisition";
import { createCountAcquisition } from "./count-acquisition";
import { createScopeSyncCountRuntime } from "./count-runtime";
import { runCountCaptureRequest } from "../../source-observations/api/providers/count-capture-transport";
import { periodAt, periodReserve, syntheticPeriod } from "../tests/scrydex-period-fixture";
import { periodHistoryPool, periodStoreForTest, periodUsage } from "../tests/count-period-store-fixture";

describe("AC4/AC6 retained count evidence", () => {
  it("canonical fingerprints survive PostgreSQL JSON field order without admitting unknown result fields", () => {
    expect(countFingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(countFingerprint({ b: { d: 3, c: 2 }, a: 1 }));
    expect(countResultSchema.safeParse({ outcome: "failed", evidence: null, rawBody: {} }).success).toBe(false);
    expect(countResultSchema.safeParse({ outcome: "complete", evidence: null }).success).toBe(false);
  });
  const query = {
    environment: "test",
    accountRevision: "runtime",
    providerKey: "scrydex",
    productDomain: "one-piece",
    profileKey: "synthetic",
    profileVersion: "1",
    unitKey: "scrydex:one-piece:single-card:source-observation-import",
    kind: "cards",
    languageCode: "en",
    parentValue: "OP01",
    requestFingerprint: "a".repeat(64),
  } as const;
  const evidence = {
    query,
    validationKind: "page-1-count",
    sourceId: "synthetic-debit",
    totalCount: 121,
    pageSize: 100,
    returnedPage: 1,
    returnedItemCount: 100,
    observedAt: "2026-10-12T12:00:00.000Z",
    expiresAt: "2026-10-12T12:15:00.000Z",
  } as const;
  it("preserves count-only evidence at the 900-second boundary", () => {
    expect(countEvidenceSchema.parse(evidence)).toEqual(evidence);
    expect(countSourceIsCurrent(evidence, query, "2026-10-12T12:15:00.000Z")).toBe(true);
    expect(countSourceIsCurrent(evidence, query, "2026-10-12T12:15:00.001Z")).toBe(false);
  });
  it.each([
    { observedAt: "2026-10-12" },
    { observedAt: "2026-10-12T12:01:00Z" },
    { pageSize: 0 },
    { totalCount: -1 },
    { rawBody: {} },
    { returnedItemCount: 1 },
  ])("refuses malformed/future/unknown retained fields", (patch) => {
    expect(countSourceIsCurrent({ ...evidence, ...patch }, query, "2026-10-12T12:00:00Z")).toBe(false);
  });
  it("rejects wrong query identity", () => {
    expect(countSourceIsCurrent(evidence, { ...query, accountRevision: "changed" }, "2026-10-12T12:00:00Z")).toBe(
      false,
    );
  });
  it.each([-60_000, 60_000])("debit history uses the store clock despite database skew of %s ms", async (skew) => {
    const now = evidence.observedAt;
    const snapshot = { remainingCredits: 1, totalCredits: 1, observedAt: now, attemptState: "checked" };
    const value = {
      quoteId: crypto.randomUUID(),
      membershipFingerprint: "synthetic",
      selection: {},
      authority: { fingerprint: countFingerprint(snapshot), headroom: 1, allowed: true },
      targets: [{ scopeRecordId: "synthetic", query, source: null, blocked: false }],
      plannedCredits: 1,
      cap: 1,
      expiresAt: evidence.expiresAt,
      state: "quoted" as const,
    };
    const quote = { ...value, fingerprint: countFingerprint(value) };
    let debit: { event_id: string; recorded_at: string } | null = null;
    const queryDb = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes("INSERT INTO catalog_scope_sync_count_history")) {
        debit = {
          event_id: String(values[0]),
          recorded_at: sql.includes("payload, recorded_at")
            ? String(values[9])
            : new Date(Date.parse(now) + skew).toISOString(),
        };
        return { rows: [] };
      }
      if (sql.includes("SELECT d.event_id,d.quote_id"))
        return { rows: debit ? [{ ...debit, quote_id: quote.quoteId, count_kind: "cards", result: null }] : [] };
      if (sql.includes("event_kind='quoted'")) return { rows: [{ payload: { quote, owner: "synthetic" } }] };
      if (sql.includes("event_kind='approved'")) return { rows: [{ event_id: "synthetic-approval" }] };
      if (sql.includes("event_kind='usage'")) return { rows: [{ payload: snapshot }] };
      if (sql.includes("AS reserved")) return { rows: [{ debits: "0", reserved: "0" }] };
      if (sql.includes("AS aggregate")) return { rows: [{ aggregate: "0", per_set: "0", per_kind: "0" }] };
      return { rows: [] };
    });
    const pool = {
      query: queryDb,
      connect: async () => ({ query: queryDb, release: () => undefined }),
    } as unknown as PgTransactionalPool;
    const store = createCountStore(pool, "synthetic", () => now);
    const debitId = await store.claim(pool, quote, quote.targets[0]!, "synthetic", quote.authority);
    expect(await store.history()).toMatchObject([{ debitId, debitedAt: now, outcome: "uncertain" }]);
  });
  it("retained quotes preserve successful reuse from another quote without inventing debits", async () => {
    const value = {
      quoteId: crypto.randomUUID(),
      membershipFingerprint: "synthetic",
      selection: {},
      authority: { fingerprint: "synthetic", headroom: 1, allowed: true },
      targets: [{ scopeRecordId: "synthetic", query, source: null, blocked: false }],
      plannedCredits: 1,
      cap: 1,
      expiresAt: evidence.expiresAt,
      state: "quoted" as const,
    };
    const quote = { ...value, fingerprint: countFingerprint(value) };
    const queryDb = vi.fn(async (sql: string) => ({
      rows: sql.includes("AS outcomes")
        ? [{ debits: "0", approvals: "1", outcomes: null }]
        : sql.includes("SELECT d.event_id")
          ? [{ event_id: evidence.sourceId, result: { outcome: "complete", evidence } }]
          : [],
    }));
    const store = createCountStore(
      { query: queryDb } as unknown as PgTransactionalPool,
      "synthetic",
      () => evidence.observedAt,
    );
    const retained = await store.retainedQuote(quote);
    expect(retained.state).toBe("complete");
    expect(retained.targets[0]?.source).toEqual(evidence);
    expect(queryDb.mock.calls.some(([sql]) => sql.includes("INSERT"))).toBe(false);
  });
  it.each(["unknown-wrapper", "changed-fingerprint"])("refuses %s retained quote payload", async (mutation) => {
    const value = {
      quoteId: crypto.randomUUID(),
      membershipFingerprint: "synthetic",
      selection: {},
      authority: { fingerprint: "synthetic", headroom: 1, allowed: true },
      targets: [],
      plannedCredits: 0,
      cap: 0,
      expiresAt: evidence.expiresAt,
      state: "quoted" as const,
    };
    const quote = { ...value, fingerprint: countFingerprint(value) };
    const payload =
      mutation === "unknown-wrapper"
        ? { quote, owner: "synthetic", rawBody: {} }
        : { quote: { ...quote, cap: 1 }, owner: "synthetic" };
    const store = createCountStore(
      { query: async () => ({ rows: [{ payload }] }) } as unknown as PgTransactionalPool,
      "synthetic",
    );
    await expect(store.loadQuote(quote.quoteId, "synthetic")).rejects.toThrow();
  });
});

// The real count store over an in-memory history table, driven by the real engine:
// every period decision is the landed gate's, evaluated under the headroom lock.
function periodHarness(consumed: number, options: { cap?: number } = {}) {
  const history = periodHistoryPool(periodUsage(consumed));
  const clock = { now: periodAt };
  const createStore = periodStoreForTest();
  const store = createStore(history.pool, "synthetic-slot", () => clock.now);
  const query = (kind: "cards" | "sealed") => ({
    environment: "staging",
    accountRevision: "runtime",
    providerKey: "scrydex" as const,
    productDomain: "one-piece" as const,
    profileKey: "synthetic",
    profileVersion: "1",
    unitKey: `scrydex:one-piece:${kind === "cards" ? "single-card" : "sealed-product"}:source-observation-import`,
    kind,
    languageCode: "en",
    parentValue: "OP01",
    requestFingerprint: (kind === "cards" ? "a" : "b").repeat(64),
  });
  const targets: CountTarget[] = (["cards", "sealed"] as const).map((kind) => ({
    scopeRecordId: "scope-op01",
    query: query(kind),
    source: null,
    blocked: false,
  }));
  const send = vi.fn(async () => ({
    totalCount: 121,
    pageSize: 100,
    returnedPage: 1 as const,
    returnedItemCount: 100,
    observedAt: periodAt,
  }));
  const engine = createCountAcquisition({
    ledger: {
      ...store,
      admit: (quote, owner, authority, gate) => store.admit(history.pool, quote, owner, authority, gate),
      admitPeriod: (quote, owner, gate) => store.admitPeriod(history.pool, quote, owner, gate),
      approve: (quoteId, fingerprint, owner) => store.approve(history.pool, quoteId, fingerprint, owner),
      claim: (quote, target, owner, authority, executionId, gate) =>
        store.claim(history.pool, quote, target, owner, authority, executionId, gate),
      end: (quoteId, executionId, owner, state) => store.end(history.pool, quoteId, executionId, owner, state),
    },
    resolve: async () => ({ membershipFingerprint: "synthetic", targets }),
    send,
    allowed: () => true,
    now: () => clock.now,
  });
  async function acquire(
    admission?: CountAdmission,
    period: { reserve: unknown; runId: string } | null = { reserve: periodReserve(), runId: "synthetic-dispatch" },
  ) {
    const quote = await engine.quote({ selection: {}, cap: options.cap, owner: "owner" });
    const debitsBefore = history.events.filter((event) => event.event_kind === "debit").length;
    const outcome = await engine
      .acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "owner", admission, period })
      .catch((error: unknown) => error);
    const debits = history.events.filter((event) => event.event_kind === "debit").length - debitsBefore;
    return { quote, outcome, debits };
  }
  return { history, clock, store, send, engine, acquire };
}

describe("AC1/AC2 staging non-capture period-cap boundary", () => {
  it("period-cap boundary: whole-quote 49,998 P=2 sends 2; 49,999 P=2 sends 0", async () => {
    const admitted = periodHarness(49_998);
    const complete = await admitted.acquire("whole-quote");
    expect(complete.outcome).toMatchObject({
      state: "complete",
      periodDecision: { admitted: true, consumedCredits: 49_998, unreflectedCredits: 0, plannedCredits: 2 },
    });
    expect(admitted.send).toHaveBeenCalledTimes(2);

    const refused = periodHarness(49_999);
    const stopped = await refused.acquire("whole-quote");
    expect(stopped.outcome).toBeInstanceOf(CountPeriodCapRefused);
    expect((stopped.outcome as CountPeriodCapRefused).code).toBe("usage-period-cap");
    expect((stopped.outcome as CountPeriodCapRefused).decision).toMatchObject({
      admitted: false,
      reason: "usage-period-cap",
      runId: "synthetic-dispatch",
      consumedCredits: 49_999,
      unreflectedCredits: 0,
      plannedCredits: 2,
    });
    expect(refused.send).not.toHaveBeenCalled();
    expect(refused.history.events.map((event) => event.event_kind)).toEqual(["quoted"]);
  });

  it("period-cap boundary: plain 49,998 cap 2 sends 2; 49,999 cap 2 sends 0; 49,999 cap 1 sends 1", async () => {
    const both = periodHarness(49_998);
    expect((await both.acquire()).outcome).toMatchObject({ state: "complete", periodDecision: { plannedCredits: 2 } });
    expect(both.send).toHaveBeenCalledTimes(2);

    const none = periodHarness(49_999);
    const refused = await none.acquire();
    expect(refused.outcome).toBeInstanceOf(CountPeriodCapRefused);
    expect((refused.outcome as CountPeriodCapRefused).decision).toMatchObject({ plannedCredits: 2 });
    expect(none.send).not.toHaveBeenCalled();
    expect(none.history.events.map((event) => event.event_kind)).toEqual(["quoted"]);

    // The second target then meets the unchanged quote cap, so the capped acquisition stops after one send.
    const one = periodHarness(49_999, { cap: 1 });
    expect((await one.acquire()).outcome).toMatchObject({
      state: "failed",
      periodDecision: { admitted: true, consumedCredits: 49_999, plannedCredits: 1 },
    });
    expect(one.send).toHaveBeenCalledTimes(1);
  });

  it("each plain claim is gated at P=1 against debits already made; partial semantics are unchanged", async () => {
    // The up-front check admits P=2, then a concurrent sender's uncertain debit lands before the second claim.
    const f = periodHarness(49_998);
    f.send.mockImplementationOnce(async () => {
      f.history.events.push({
        event_id: crypto.randomUUID(),
        event_kind: "debit",
        quote_id: crypto.randomUUID(),
        query_key: "c".repeat(64),
        debit_id: null,
        scope_record_id: "scope-other",
        count_kind: "cards",
        payload: {},
        recorded_at: periodAt,
      });
      return { totalCount: 121, pageSize: 100, returnedPage: 1, returnedItemCount: 100, observedAt: periodAt };
    });
    const { outcome, debits } = await f.acquire();
    expect(outcome).toMatchObject({ state: "failed", periodDecision: { admitted: true, plannedCredits: 2 } });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(debits).toBe(2);
  });
});

describe("AC2 staging non-capture reserve and snapshot refusals", () => {
  const reserve = periodReserve();
  it.each([
    ["absent", undefined],
    ["malformed", { ...reserve, credits: "0" }],
    ["extra-field", { ...reserve, rawBody: {} }],
    ["unknown credits", { ...reserve, credits: null }],
    ["run-mismatched", periodReserve("another-dispatch")],
    ["period-mismatched", { ...reserve, startsAt: "2026-02-01T00:00:00.000Z" }],
    ["stale", { ...reserve, observedAt: "2026-10-13T07:46:59.999Z" }],
  ])("refuses a %s reserve with zero sends", async (_name, value) => {
    for (const admission of [undefined, "whole-quote"] as const) {
      const f = periodHarness(0);
      const { outcome, debits } = await f.acquire(admission, { reserve: value, runId: "synthetic-dispatch" });
      expect(outcome, admission).toBeInstanceOf(CountPeriodCapRefused);
      expect((outcome as CountPeriodCapRefused).decision, admission).toMatchObject({ admitted: false });
      expect(f.send, admission).not.toHaveBeenCalled();
      expect(debits, admission).toBe(0);
    }
  });

  // Every acquisition below follows a quote made against fresh, checked usage, with
  // an owned, unexpired quote and a fresh reserve, so only the snapshot can refuse.
  const quotedAt = "2026-10-13T08:03:00.000Z";
  type Harness = ReturnType<typeof periodHarness>;
  async function acquireAfter(
    admission: CountAdmission | undefined,
    change: (f: Harness) => void,
    options: { underLock?: boolean; fingerprint?: string; period?: { reserve: unknown; runId: string } | null } = {},
  ) {
    const f = periodHarness(0);
    f.clock.now = quotedAt;
    const quote = await f.engine.quote({ selection: {}, owner: "owner" });
    if (options.underLock) {
      // The engine's read sees the fresh usage; the change lands before the locked admission reads it.
      const connect = f.history.pool.connect.bind(f.history.pool);
      vi.spyOn(f.history.pool, "connect").mockImplementationOnce(async () => {
        change(f);
        return connect();
      });
    } else change(f);
    const outcome = await f.engine
      .acquire({
        quoteId: quote.quoteId,
        fingerprint: options.fingerprint ?? quote.fingerprint,
        owner: "owner",
        admission,
        period:
          options.period === undefined
            ? { reserve: { ...reserve, observedAt: quotedAt }, runId: "synthetic-dispatch" }
            : options.period,
      })
      .catch((error: unknown) => error);
    return { f, quote, outcome };
  }
  const snapshots: [string, (f: Harness) => void][] = [
    ["missing", (f) => f.history.setUsage(null)],
    ["over-900 s", (f) => f.history.setUsage(periodUsage(0, { observedAt: "2026-10-13T07:46:59.999Z" }))],
    ["aged past 900 s", (f) => void (f.clock.now = "2026-10-13T08:17:00.001Z")],
    [
      "out-of-period",
      (f) => f.history.setUsage(periodUsage(0, { billingPeriod: { ...syntheticPeriod, endsAt: periodAt } })),
    ],
    [
      "overage",
      (f) => f.history.setUsage(periodUsage(0, { billingPeriod: { ...syntheticPeriod, overageCreditsConsumed: 1 } })),
    ],
  ];
  for (const underLock of [false, true])
    it.each(snapshots)(
      `refuses a %s snapshot usage-period-cap through the acquisition${underLock ? " when it changes under the lock" : ""}`,
      async (_name, change) => {
        for (const admission of [undefined, "whole-quote"] as const) {
          const { f, quote, outcome } = await acquireAfter(admission, change, { underLock });
          expect(outcome, admission).toBeInstanceOf(CountPeriodCapRefused);
          expect((outcome as CountPeriodCapRefused).decision, admission).toMatchObject({
            admitted: false,
            reason: "usage-period-cap",
            consumedCredits: null,
            plannedCredits: 2,
          });
          expect(f.send, admission).not.toHaveBeenCalled();
          expect(
            f.history.events.map((event) => event.event_kind),
            admission,
          ).toEqual(["quoted"]);
          expect(Date.parse(quote.expiresAt), admission).toBeGreaterThan(Date.parse(f.clock.now));
        }
      },
    );

  it("an invalid quote, a changed in-cap snapshot or an ungated acquisition still refuses generically", async () => {
    const missing = (f: Harness) => f.history.setUsage(null);
    for (const admission of [undefined, "whole-quote"] as const) {
      const refusals = [
        // A newer, fresh, in-cap snapshot admits the period gate; the quote's usage binding then refuses.
        await acquireAfter(admission, (f) => f.history.setUsage(periodUsage(1, { observedAt: quotedAt }))),
        // Quote expiry and identity, and an ungated acquisition, refuse before missing usage is classified.
        await acquireAfter(admission, (f) => {
          missing(f);
          f.clock.now = "2026-10-13T08:18:00.001Z";
        }),
        await acquireAfter(admission, missing, { fingerprint: "f".repeat(64) }),
        await acquireAfter(admission, missing, { period: null }),
      ];
      for (const [index, { f, outcome }] of refusals.entries()) {
        expect(outcome, `${admission} ${index}`).toBeInstanceOf(CountAcquisitionRefused);
        expect(f.send, `${admission} ${index}`).not.toHaveBeenCalled();
        expect(
          f.history.events.map((event) => event.event_kind),
          `${admission} ${index}`,
        ).toEqual(["quoted"]);
      }
    }
    // A whole-quote replay is refused as executed before its missing usage is classified.
    const replay = periodHarness(0);
    const first = await replay.acquire("whole-quote");
    expect(first.outcome).toMatchObject({ state: "complete" });
    replay.history.setUsage(null);
    await expect(
      replay.engine.acquire({
        quoteId: first.quote.quoteId,
        fingerprint: first.quote.fingerprint,
        owner: "owner",
        admission: "whole-quote",
        period: { reserve, runId: "synthetic-dispatch" },
      }),
    ).rejects.toBeInstanceOf(CountAcquisitionRefused);
    expect(replay.send).toHaveBeenCalledTimes(2);
  });
});

describe("AC3 acquireCounts period authority", () => {
  const context: EventStoreContext = {
    tenantId: "tnt_test",
    audit: { performedByUserId: "usr_test", forAccountId: "acc_test" },
  };
  const request = { quoteId: "00000000-0000-4000-8000-000000000001", fingerprint: "a".repeat(64), context };
  function runtime(environment: string) {
    // The store refuses every read: reaching it proves the period authority let the request through.
    const store = { loadQuote: vi.fn(async () => Promise.reject(new CountAcquisitionRefused())) };
    const counts = createScopeSyncCountRuntime({
      pool: {} as never,
      store: store as never,
      environment,
      accountRevision: "runtime",
      profiles: {} as never,
      adapterOptions: {},
    });
    return { store, counts };
  }
  async function inCapture<T>(runId: string, phase: "acquisition" | "quote", work: () => Promise<T>) {
    let outcome: unknown;
    await runCountCaptureRequest(
      {
        binding: { runId, requestId: "synthetic-request", phase },
        ledger: { debit: async () => 1, result: async () => undefined, stop: async () => undefined },
      },
      async () => {
        outcome = await work().catch((error: unknown) => error);
        return null;
      },
    );
    return outcome;
  }

  it("staging refuses a missing or unbound authority before reading the quote or sending", async () => {
    const f = runtime("staging");
    const captureRun = { kind: "capture-run" as const, runId: "capture-run-1" };
    const refusals = [
      await f.counts.acquireCounts(request).catch((error: unknown) => error),
      await f.counts.acquireCounts({ ...request, periodAuthority: captureRun }).catch((error: unknown) => error),
      await inCapture("capture-run-2", "acquisition", () =>
        f.counts.acquireCounts({ ...request, periodAuthority: captureRun }),
      ),
      await inCapture("capture-run-1", "quote", () =>
        f.counts.acquireCounts({ ...request, periodAuthority: captureRun }),
      ),
      await f.counts
        .acquireCounts({ ...request, periodAuthority: { kind: "reserve", reserve: { ...periodReserve(), extra: 1 } } })
        .catch((error: unknown) => error),
    ];
    for (const refusal of refusals) expect(refusal).toBeInstanceOf(CountPeriodCapRefused);
    expect(f.store.loadQuote).not.toHaveBeenCalled();
  });

  it("only the capture run's own bound acquisition request, or a well-formed reserve, reaches the quote", async () => {
    const f = runtime("staging");
    const captureRun = { kind: "capture-run" as const, runId: "capture-run-1" };
    expect(
      await inCapture("capture-run-1", "acquisition", () =>
        f.counts.acquireCounts({ ...request, periodAuthority: captureRun }),
      ),
    ).toBeInstanceOf(CountAcquisitionRefused);
    await expect(
      f.counts.acquireCounts({ ...request, periodAuthority: { kind: "reserve", reserve: periodReserve() } }),
    ).rejects.toBeInstanceOf(CountAcquisitionRefused);
    expect(f.store.loadQuote).toHaveBeenCalledTimes(2);
  });

  it("outside staging nothing is gated and a period reserve refuses", async () => {
    for (const environment of ["production", "test", "Staging"]) {
      const f = runtime(environment);
      await expect(
        f.counts.acquireCounts({ ...request, periodAuthority: { kind: "reserve", reserve: periodReserve() } }),
      ).rejects.toBeInstanceOf(CountAcquisitionRefused);
      expect(f.store.loadQuote, environment).not.toHaveBeenCalled();
      await expect(f.counts.acquireCounts(request)).rejects.toBeInstanceOf(CountAcquisitionRefused);
      expect(f.store.loadQuote, environment).toHaveBeenCalledOnce();
    }
  });
});
