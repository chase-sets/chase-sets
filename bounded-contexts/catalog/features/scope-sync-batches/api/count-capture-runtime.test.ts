import { describe, expect, it, vi } from "vitest";
import { countFingerprint } from "../domain/count-acquisition";
import { defaultScopeSyncBatchBudget } from "../domain/batch";
import { syntheticCountCaptureAuthority } from "../tests/count-capture-fixture";
import type { CountCaptureState, CountCaptureStore } from "../read-model/count-capture-store";
import { createScopeSyncBatchPlanner } from "./planner";
import { createScopeSyncBatchPlannerReads } from "./count-capture-planner";
import { countCaptureSessionOwner, type CountCaptureSession } from "./count-capture-session";
import { createCountCapturePlannerRuntime } from "./count-capture-runtime";

function fixture() {
  const now = "2026-10-13T08:04:00.000Z";
  const session: CountCaptureSession = {
    request: new Request("https://admin.staging.chasesets.com/api/catalog/scope-sync-batches/preview", {
      method: "POST",
      headers: { origin: "https://admin.staging.chasesets.com" },
    }),
    actor: {
      sessionId: "synthetic",
      tenantId: "tnt_synthetic",
      accountId: "acc_synthetic",
      userId: "usr_synthetic",
      membershipId: "synthetic",
      roleKey: "platform-admin",
      permissions: ["catalog.view", "catalog.manage"],
    },
    context: {
      tenantId: "tnt_synthetic",
      audit: { performedByUserId: "usr_synthetic", forAccountId: "acc_synthetic" },
    },
  };
  const selection = { mode: "ids" as const, scopeRecordIds: [] };
  const budget = defaultScopeSyncBatchBudget;
  const state: CountCaptureState = {
    runId: "00000000-0000-4000-8000-000000000001",
    ownerHash: countCaptureSessionOwner(session, "staging"),
    authority: syntheticCountCaptureAuthority(),
    admittedAt: now,
    expiresAt: "2026-10-13T08:17:00.000Z",
    stage: "acquired",
    request: null,
    sends: [],
    plannerReads: [],
    selectionHash: countFingerprint(selection),
    budgetHash: countFingerprint(budget),
    countQueries: [],
    quoteId: null,
    quoteFingerprint: null,
  };
  const binding: Awaited<ReturnType<CountCaptureStore["begin"]>> = {
    runId: state.runId,
    requestId: "00000000-0000-4000-8000-000000000002",
    phase: "preview",
  };
  const store = {
    findOwner: vi.fn(async () => state),
    begin: vi.fn<CountCaptureStore["begin"]>(async (_runId, phase) => ({ ...binding, phase })),
    finish: vi.fn(async () => state),
    retainPlannerRead: vi.fn<CountCaptureStore["retainPlannerRead"]>(async (_binding, read) => {
      state.plannerReads.push(read);
    }),
    ledger: { debit: vi.fn(async () => 1), result: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
  } satisfies Pick<CountCaptureStore, "findOwner" | "begin" | "finish" | "retainPlannerRead" | "ledger">;
  const query = vi.fn(async () => {
    throw new Error("empty selection must not query");
  });
  const planner = createScopeSyncBatchPlanner({ db: { query }, previewCatalogSyncScope: vi.fn(), now: () => now });
  const reads = createScopeSyncBatchPlannerReads(planner);
  const preview = vi.fn(async (input: Parameters<typeof planner.resolve>[0]) => (await planner.resolve(input)).preview);
  const preConfirm = vi.fn(reads.preConfirmPlannerRead);
  const runtime = createCountCapturePlannerRuntime({
    environment: "staging",
    store,
    preview,
    preConfirmPlannerRead: preConfirm,
    now: () => now,
  });
  return { session, selection, budget, state, store, runtime, query, preview, preConfirm, binding };
}

describe("captures actual winners through the authenticated runtime", () => {
  it("persists the actual blocked preview before finishing, without a second resolver call", async () => {
    const f = fixture();
    const value = await f.runtime.preview(f.session, { selection: f.selection, budget: f.budget });
    expect(value.confirmAllowed).toBe(false);
    expect(f.preview).toHaveBeenCalledExactlyOnceWith({
      selection: f.selection,
      budget: f.budget,
      context: f.session.context,
    });
    expect(f.store.retainPlannerRead).toHaveBeenCalledWith(
      f.binding,
      expect.objectContaining({ planFingerprint: value.planFingerprint, winners: [], phase: "preview" }),
    );
    expect(f.store.retainPlannerRead.mock.invocationCallOrder[0]).toBeLessThan(
      f.store.finish.mock.invocationCallOrder[0]!,
    );
    expect(f.query).not.toHaveBeenCalled();
  });
  it("pre-confirm uses the shared check and returns no internal plan or effect capability", async () => {
    const f = fixture();
    const preview = await f.runtime.preview(f.session, { selection: f.selection, budget: f.budget });
    f.state.stage = "previewed";
    const result = await f.runtime.preConfirm(f.session, {
      selection: f.selection,
      budget: f.budget,
      planFingerprint: preview.planFingerprint,
    });
    expect(f.preConfirm).toHaveBeenCalledOnce();
    expect(result).toEqual({
      comparedFingerprint: preview.planFingerprint,
      currentFingerprint: preview.planFingerprint,
      eligible: false,
      refusal: "scope_sync_batch_blocked",
      effectsCapability: false,
    });
    expect(result).not.toHaveProperty("current");
    expect(f.store.retainPlannerRead).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "pre-confirm" }),
      expect.objectContaining({ phase: "pre-confirm", eligible: false }),
    );
  });
  it.each(["anonymous", "wrong-owner", "budget"])("refuses %s before planner work", async (mode) => {
    const f = fixture();
    if (mode === "wrong-owner") f.state.ownerHash = "b".repeat(64);
    if (mode === "budget") f.state.budgetHash = "b".repeat(64);
    await expect(
      f.runtime.preview(mode === "anonymous" ? { ...f.session, actor: null } : f.session, {
        selection: f.selection,
        budget: f.budget,
      }),
    ).rejects.toThrow("capture-stopped");
    expect(f.preview).not.toHaveBeenCalled();
    expect(f.store.retainPlannerRead).not.toHaveBeenCalled();
  });
  it("retention failure stops instead of returning an unretained observation", async () => {
    const f = fixture();
    f.store.retainPlannerRead.mockRejectedValue(new Error("synthetic-secret"));
    await expect(f.runtime.preview(f.session, { selection: f.selection, budget: f.budget })).rejects.toThrow(
      /^capture-stopped$/,
    );
    expect(f.store.finish).not.toHaveBeenCalled();
    expect(f.store.ledger.stop).toHaveBeenCalledWith(f.binding);
  });
  it("a mismatched pre-confirm fingerprint cannot spend on the resolver before refusal", async () => {
    const f = fixture();
    await f.runtime.preview(f.session, { selection: f.selection, budget: f.budget });
    f.state.stage = "previewed";
    await expect(
      f.runtime.preConfirm(f.session, { selection: f.selection, budget: f.budget, planFingerprint: "b".repeat(64) }),
    ).rejects.toThrow("capture-stopped");
    expect(f.preConfirm).not.toHaveBeenCalled();
  });
});
