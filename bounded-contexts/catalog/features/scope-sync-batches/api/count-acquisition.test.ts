import { describe, expect, it, vi } from "vitest";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createCountStore } from "../read-model/count-store";
import {
  countEvidenceSchema,
  countSourceIsCurrent,
  countResultSchema,
  countFingerprint,
} from "../domain/count-acquisition";

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
