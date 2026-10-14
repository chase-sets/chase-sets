import { describe, expect, it, vi } from "vitest";
import { countFingerprint, type CountQuote } from "../domain/count-acquisition";
import { normalizeScopeSyncBatchBudget } from "../domain/batch";
import type { CountCaptureState, CountCaptureStore } from "../read-model/count-capture-store";
import { syntheticCountLifecycleReceipt } from "../tests/count-lifecycle-receipt-fixture";
import { countCaptureRequestIsBound } from "./count-capture-context";
import { createCountCaptureCountRuntime } from "./count-capture-counts";
import { countCaptureSessionOwner, type CountCaptureSession } from "./count-capture-session";
import type { createScopeSyncCountRuntime } from "./count-runtime";

function fixture() {
  const receipt = syntheticCountLifecycleReceipt();
  const now = () => receipt.frozenAt;
  const origin = "https://admin.staging.chasesets.com";
  const session: CountCaptureSession = {
    request: new Request(`${origin}/api/catalog/scope-sync-batches/counts/quote`, {
      method: "POST",
      headers: { origin },
    }),
    actor: {
      sessionId: "synthetic-session",
      tenantId: "tnt_synthetic",
      accountId: "acc_synthetic",
      userId: "usr_synthetic",
      membershipId: "synthetic-membership",
      roleKey: "platform-admin",
      permissions: ["catalog.view", "catalog.manage"],
    },
    context: {
      tenantId: "tnt_synthetic",
      audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" },
    },
  };
  const input = {
    selection: { mode: "ids" as const, scopeRecordIds: [receipt.selection.scopeRecordId] },
    budget: normalizeScopeSyncBatchBudget(),
  };
  const quote: CountQuote = {
    quoteId: receipt.notices.quoteId,
    fingerprint: receipt.notices.quoteFingerprint,
    membershipFingerprint: receipt.notices.membershipFingerprint,
    selection: input.selection,
    authority: { fingerprint: receipt.notices.authorityFingerprint, allowed: true, headroom: 20 },
    targets: receipt.acquisitions.map(({ evidence }) => ({
      scopeRecordId: receipt.selection.scopeRecordId,
      query: evidence.query,
      source: evidence,
      blocked: false,
    })),
    plannedCredits: 0,
    cap: 0,
    expiresAt: "2026-10-13T08:15:00.000Z",
    state: "quoted",
  };
  const state: CountCaptureState = {
    runId: "00000000-0000-4000-8000-000000000001",
    ownerHash: countCaptureSessionOwner(session, "staging"),
    authority: receipt.authority,
    admittedAt: receipt.startedAt,
    expiresAt: "2026-10-13T08:15:00.000Z",
    stage: "noticed",
    request: null,
    sends: [],
    plannerReads: [],
    countQueries: [],
    selectionHash: countFingerprint(input.selection),
    budgetHash: countFingerprint(input.budget),
    quoteId: quote.quoteId,
    quoteFingerprint: quote.fingerprint,
  };
  const store = {
    findOwner: vi.fn(async () => state as CountCaptureState | null),
    begin: vi.fn<CountCaptureStore["begin"]>(async (runId, phase) => ({
      runId,
      phase,
      requestId: "00000000-0000-4000-8000-000000000002",
    })),
    finish: vi.fn(async () => state),
    bindQuote: vi.fn<CountCaptureStore["bindQuote"]>(async () => {}),
    ledger: { debit: vi.fn(async () => 1), result: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
  } satisfies Pick<CountCaptureStore, "findOwner" | "begin" | "finish" | "bindQuote" | "ledger">;
  const counts = {
    quoteCounts: vi.fn<ReturnType<typeof createScopeSyncCountRuntime>["quoteCounts"]>(async () => {
      expect(countCaptureRequestIsBound()).toBe(true);
      return quote;
    }),
    acquireCounts: vi.fn<ReturnType<typeof createScopeSyncCountRuntime>["acquireCounts"]>(async () => {
      expect(countCaptureRequestIsBound()).toBe(true);
      return { ...quote, state: "complete" };
    }),
  };
  const runtime = createCountCaptureCountRuntime({ environment: "staging", store, counts, now });
  const acquisition = { ...input, quoteId: quote.quoteId, fingerprint: quote.fingerprint };
  return { session, input, acquisition, quote, state, store, counts, runtime };
}

describe("composes capture counts with the existing count authority", () => {
  it("quotes once with cap two, binds the lowered cap before finishing and returns only the projection", async () => {
    const f = fixture();
    expect(await f.runtime.quote(f.session, f.input)).toEqual({
      quoteId: f.quote.quoteId,
      fingerprint: f.quote.fingerprint,
      plannedCount: 0,
      serverCap: 0,
    });
    expect(f.counts.quoteCounts).toHaveBeenCalledExactlyOnceWith({
      selection: f.input.selection,
      cap: 2,
      context: f.session.context,
    });
    expect(f.store.bindQuote).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ phase: "quote" }), f.quote);
    expect(f.store.bindQuote.mock.invocationCallOrder[0]).toBeLessThan(f.store.finish.mock.invocationCallOrder[0]!);
    expect(f.counts.acquireCounts).not.toHaveBeenCalled();
  });
  it("acquires once through the normal count service inside the request-correlated guard", async () => {
    const f = fixture();
    expect(await f.runtime.acquire(f.session, f.acquisition)).toEqual({ retained: true });
    expect(f.counts.acquireCounts).toHaveBeenCalledExactlyOnceWith({
      quoteId: f.quote.quoteId,
      fingerprint: f.quote.fingerprint,
      context: f.session.context,
    });
    expect(f.store.begin).toHaveBeenCalledExactlyOnceWith(f.state.runId, "acquisition");
    expect(f.store.finish).toHaveBeenCalledOnce();
    expect(f.counts.quoteCounts).not.toHaveBeenCalled();
  });
  it.each(["anonymous", "missing", "expired", "budget", "fingerprint", "phase-replay"])(
    "refuses %s before count authority or provider work",
    async (mode) => {
      const f = fixture();
      if (mode === "missing") f.store.findOwner.mockResolvedValue(null);
      if (mode === "expired") f.state.expiresAt = "2026-10-13T07:59:00Z";
      if (mode === "budget") f.state.budgetHash = "e".repeat(64);
      if (mode === "fingerprint") f.state.quoteFingerprint = "e".repeat(64);
      if (mode === "phase-replay") f.store.begin.mockRejectedValue(new Error("capture-stopped"));
      await expect(
        f.runtime.acquire(mode === "anonymous" ? { ...f.session, actor: null } : f.session, f.acquisition),
      ).rejects.toThrow("capture-stopped");
      expect(f.counts.acquireCounts).not.toHaveBeenCalled();
      expect(f.counts.quoteCounts).not.toHaveBeenCalled();
    },
  );
  it.each(["failed", "uncertain", "acquiring"] as const)("does not acknowledge a %s count result", async (state) => {
    const f = fixture();
    f.counts.acquireCounts.mockResolvedValue({ ...f.quote, state });
    await expect(f.runtime.acquire(f.session, f.acquisition)).rejects.toThrow(/^capture-stopped$/);
    expect(f.counts.acquireCounts).toHaveBeenCalledOnce();
    expect(f.store.finish).not.toHaveBeenCalled();
    expect(f.store.ledger.stop).toHaveBeenCalledOnce();
  });
  it.each(["missing-source", "query-mismatch", "stale-source", "wrong-quote", "wrong-selection"])(
    "refuses complete-looking %s evidence",
    async (mode) => {
      const f = fixture();
      const result = structuredClone({ ...f.quote, state: "complete" as const });
      const targets = result.targets.map((target) => ({ ...target }));
      if (mode === "missing-source") targets[0]!.source = null;
      if (mode === "query-mismatch")
        targets[0]!.source = { ...targets[0]!.source!, query: { ...targets[0]!.query, parentValue: "OTHER" } };
      if (mode === "stale-source") targets[0]!.source = { ...targets[0]!.source!, observedAt: "2026-10-13T07:00:00Z" };
      f.counts.acquireCounts.mockResolvedValue({
        ...result,
        targets,
        ...(mode === "wrong-quote" ? { fingerprint: "e".repeat(64) } : {}),
        ...(mode === "wrong-selection" ? { selection: { mode: "ids", scopeRecordIds: ["other"] } } : {}),
      });
      await expect(f.runtime.acquire(f.session, f.acquisition)).rejects.toThrow("capture-stopped");
      expect(f.store.finish).not.toHaveBeenCalled();
    },
  );
  it.each(["quote-bind", "acquire-commit"])("preserves %s uncertainty with no retry", async (mode) => {
    const f = fixture();
    f.store.bindQuote.mockRejectedValue(new Error("synthetic-private-marker"));
    f.store.finish.mockRejectedValue(new Error("synthetic-private-marker"));
    const work =
      mode === "quote-bind" ? f.runtime.quote(f.session, f.input) : f.runtime.acquire(f.session, f.acquisition);
    await expect(work).rejects.toThrow(/^capture-stopped$/);
    expect(f.store.ledger.stop).toHaveBeenCalledOnce();
    expect(f.counts.quoteCounts.mock.calls.length + f.counts.acquireCounts.mock.calls.length).toBe(1);
  });
});
