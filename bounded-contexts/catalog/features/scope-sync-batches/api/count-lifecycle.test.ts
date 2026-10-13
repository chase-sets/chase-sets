import { describe, expect, it, vi } from "vitest";
import { createCountAcquisition, type CountAcquisitionLedger } from "./count-acquisition";
import { scrydexCountQuery } from "../../source-observations/api/providers/scrydex/adapter";
import { CountAcquisitionRefused, type CountQuote, type CountTarget } from "../domain/count-acquisition";

const now = "2026-10-12T12:00:00Z";
const query = scrydexCountQuery({
  environment: "test",
  accountRevision: "runtime",
  productDomain: "one-piece",
  profileKey: "synthetic",
  profileVersion: "1",
  unitKey: "scrydex:one-piece:single-card:source-observation-import",
  kind: "cards",
  languageCode: "en",
  parentValue: "OP01",
});
const targets: CountTarget[] = [
  query,
  scrydexCountQuery({
    ...query,
    kind: "sealed",
    unitKey: "scrydex:one-piece:sealed-product:source-observation-import",
  }),
].map((query) => ({ query, scopeRecordId: "scope-1", source: null, blocked: false }));
function fixture(cap = 2) {
  let quote: CountQuote;
  let debits = 0;
  const claimed = new Set<string>();
  const evidence = new Map<string, NonNullable<CountTarget["source"]>>();
  const ledger: CountAcquisitionLedger = {
    authority: vi.fn(async () => ({ fingerprint: "authority", allowed: true, headroom: 10 - debits })),
    saveQuote: vi.fn(async (value) => {
      quote = value;
    }),
    loadQuote: vi.fn(async () => quote),
    approve: vi.fn(async () => quote),
    claim: vi.fn(async (_quote, target) => {
      if (evidence.has(target.query.kind)) return null;
      if (debits >= cap || claimed.has(target.query.kind)) throw new CountAcquisitionRefused();
      debits++;
      claimed.add(target.query.kind);
      return `debit-${debits}`;
    }),
    result: vi.fn(async (_debit, _quote, q, outcome, source) => {
      if (outcome === "complete" && source) evidence.set(q.kind, source);
    }),
  };
  const resolve = vi.fn(async () => ({
    membershipFingerprint: "membership",
    targets: targets.map((target) => ({ ...target, source: evidence.get(target.query.kind) ?? null })),
  }));
  const send = vi.fn(async () => ({
    totalCount: 121,
    pageSize: 100,
    returnedPage: 1 as const,
    returnedItemCount: 100,
    observedAt: now,
  }));
  const runtime = createCountAcquisition({ ledger, resolve, send, now: () => now, allowed: () => true });
  return { runtime, ledger, resolve, send, evidence };
}
describe("Count quote and acquisition lifecycle", () => {
  it("AC1 cold quote is I/O-free, exact per-kind cost is visible; cap zero sends none", async () => {
    const f = fixture(0);
    const quote = await f.runtime.quote({
      selection: { mode: "ids", scopeRecordIds: ["scope-1"] },
      cap: 0,
      owner: "owner",
    });
    expect(quote).toMatchObject({ plannedCredits: 2, cap: 0, state: "quoted" });
    expect(f.send).not.toHaveBeenCalled();
    const result = await f.runtime.acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "owner" });
    expect(result.state).toBe("failed");
    expect(f.send).not.toHaveBeenCalled();
  });
  it("AC2 cap one sends one then retains the refused second kind", async () => {
    const f = fixture(1);
    const quote = await f.runtime.quote({ selection: {}, cap: 1, owner: "owner" });
    const result = await f.runtime.acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "owner" });
    expect(result.state).toBe("failed");
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.ledger.claim).toHaveBeenCalledTimes(2);
  });
  it("AC4 reload/replica reuse preserves observation time and spends zero", async () => {
    const f = fixture();
    const quote = await f.runtime.quote({ selection: {}, owner: "owner" });
    expect(
      (await f.runtime.acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "owner" })).state,
    ).toBe("complete");
    const next = await f.runtime.quote({ selection: {}, owner: "owner" });
    expect(next.plannedCredits).toBe(0);
    expect(next.targets[0]?.source?.observedAt).toBe(now);
    await f.runtime.acquire({ quoteId: next.quoteId, fingerprint: next.fingerprint, owner: "owner" });
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it("AC2 concurrent fill between resolve and claim returns reused evidence, not an empty success", async () => {
    const f = fixture();
    const quote = await f.runtime.quote({ selection: {}, owner: "owner" });
    vi.mocked(f.ledger.claim).mockImplementationOnce(async (_quote, target) => {
      f.evidence.set(target.query.kind, {
        query: target.query,
        validationKind: "page-1-count",
        sourceId: "replica-debit",
        totalCount: 121,
        pageSize: 100,
        observedAt: now,
        expiresAt: "2026-10-12T12:15:00Z",
      });
      return null;
    });
    const result = await f.runtime.acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "owner" });
    expect(result.state).toBe("complete");
    expect(result.targets[0]?.source?.sourceId).toBe("replica-debit");
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("AC1/AC5 forged approval or changed membership/authority refuses without sending", async () => {
    const f = fixture();
    const quote = await f.runtime.quote({ selection: {}, owner: "owner" });
    await expect(
      f.runtime.acquire({ quoteId: quote.quoteId, fingerprint: "forged", owner: "owner" }),
    ).rejects.toThrow();
    f.resolve.mockResolvedValue({ membershipFingerprint: "changed", targets });
    await expect(
      f.runtime.acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "owner" }),
    ).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
  });
  it("AC1/AC4 expiry, changed usage authority and result write failure refuse replay", async () => {
    const f = fixture();
    const quote = await f.runtime.quote({ selection: {}, owner: "owner" });
    vi.mocked(f.ledger.loadQuote).mockResolvedValueOnce({ ...quote, expiresAt: "2026-10-12T11:59:59Z" });
    await expect(
      f.runtime.acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "owner" }),
    ).rejects.toThrow();
    vi.mocked(f.ledger.authority).mockResolvedValueOnce({ fingerprint: "changed", allowed: true, headroom: 10 });
    await expect(
      f.runtime.acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "owner" }),
    ).rejects.toThrow();
    expect(f.send).not.toHaveBeenCalled();
    vi.mocked(f.ledger.result).mockRejectedValueOnce(new Error("synthetic write failure"));
    expect(
      (await f.runtime.acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "owner" })).state,
    ).toBe("uncertain");
    expect(f.send).toHaveBeenCalledOnce();
    expect(
      (await f.runtime.acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "owner" })).state,
    ).toBe("failed");
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("AC4/AC6 partial-kind timeout/write failure remains uncertain and debited", async () => {
    const f = fixture();
    const quote = await f.runtime.quote({ selection: {}, owner: "owner" });
    f.send.mockRejectedValueOnce(new TypeError("synthetic transport failure"));
    const result = await f.runtime.acquire({ quoteId: quote.quoteId, fingerprint: quote.fingerprint, owner: "owner" });
    expect(result.state).toBe("uncertain");
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.ledger.result).toHaveBeenCalledWith("debit-1", quote.quoteId, query, "uncertain", null);
  });
});
