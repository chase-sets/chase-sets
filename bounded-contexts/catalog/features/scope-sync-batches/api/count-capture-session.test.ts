import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { defaultScopeSyncBatchBudget } from "../domain/batch";
import { countFingerprint } from "../domain/count-acquisition";
import type { CountCaptureState, CountCaptureStore } from "../read-model/count-capture-store";
import { syntheticCountCaptureAuthority } from "../tests/count-capture-fixture";
import { countCaptureRequestIsBound } from "./count-capture-context";
import {
  countCaptureSessionOwner,
  createCountCaptureSessionBoundary,
  type CountCaptureSession,
} from "./count-capture-session";

const now = "2026-10-13T08:02:00.000Z";
const origin = "https://admin.staging.chasesets.com";
const actor: ResolvedActor = {
  sessionId: "synthetic-session",
  tenantId: "synthetic-tenant",
  accountId: "synthetic-account",
  userId: "synthetic-user",
  membershipId: "synthetic-membership",
  roleKey: "platform-admin",
  permissions: ["catalog.view", "catalog.manage"],
};
function fixture() {
  const session: CountCaptureSession = {
    request: new Request(`${origin}/api/catalog/scope-sync-batches/preview`, { method: "POST", headers: { origin } }),
    actor,
    context: { tenantId: actor.tenantId, audit: { performedByUserId: actor.userId, forAccountId: actor.accountId } },
  };
  const selection = { mode: "ids" as const, scopeRecordIds: ["synthetic-op01"] };
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
    selectionHash: countFingerprint(selection),
    budgetHash: countFingerprint(budget),
    countQueries: [],
    quoteId: "00000000-0000-4000-8000-000000000002",
    quoteFingerprint: "a".repeat(64),
  };
  const binding = { runId: state.runId, requestId: "00000000-0000-4000-8000-000000000003", phase: "preview" as const };
  const store = {
    findOwner: vi.fn(async () => state as CountCaptureState | null),
    begin: vi.fn(async () => binding),
    finish: vi.fn(async () => state),
    ledger: { debit: vi.fn(async () => 1), result: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
  } satisfies Pick<CountCaptureStore, "findOwner" | "begin" | "finish" | "ledger">;
  const boundary = createCountCaptureSessionBoundary({ environment: "staging", store, now: () => now });
  const input = { phase: "preview" as const, selection, budget };
  const work = vi.fn(async () => ({ bound: countCaptureRequestIsBound() }));
  return { session, state, store, boundary, input, work, binding };
}

describe("captures actual winners session boundary", () => {
  it("uses the server's run/request, binds transport, and awaits persistence before returning", async () => {
    const f = fixture();
    expect(await f.boundary.run(f.session, f.input, f.work)).toEqual({ bound: true });
    expect(f.store.findOwner).toHaveBeenCalledWith(f.state.ownerHash);
    expect(f.store.begin).toHaveBeenCalledWith(f.state.runId, "preview");
    expect(f.work).toHaveBeenCalledExactlyOnceWith(f.binding);
    expect(f.store.finish).toHaveBeenCalledExactlyOnceWith(f.binding);
    expect(countCaptureRequestIsBound()).toBe(false);
  });
  it.each([
    "anonymous",
    "role",
    "view",
    "manage",
    "session",
    "tenant",
    "user",
    "account",
    "origin",
    "cross-site",
    "method",
    "host",
  ])("refuses %s with zero database or operation I/O", async (mode) => {
    const f = fixture();
    let changedActor: ResolvedActor | null = { ...actor };
    if (mode === "anonymous") changedActor = null;
    if (mode === "role") changedActor = { ...actor, roleKey: "account-admin" };
    if (mode === "view") changedActor = { ...actor, permissions: ["catalog.manage"] };
    if (mode === "manage") changedActor = { ...actor, permissions: ["catalog.view"] };
    if (mode === "session") changedActor = { ...actor, sessionId: "" };
    if (mode === "tenant") changedActor = { ...actor, tenantId: "other" };
    if (mode === "user") changedActor = { ...actor, userId: "other" };
    if (mode === "account") changedActor = { ...actor, accountId: "other" };
    const request = new Request(`${mode === "host" ? "https://admin.chasesets.com" : origin}/api/catalog`, {
      method: mode === "method" ? "GET" : "POST",
      headers: {
        origin: mode === "origin" ? "https://elsewhere.invalid" : origin,
        "sec-fetch-site": mode === "cross-site" ? "cross-site" : "same-origin",
      },
    });
    await expect(f.boundary.run({ ...f.session, actor: changedActor, request }, f.input, f.work)).rejects.toThrow(
      "capture-stopped",
    );
    expect(f.store.findOwner).not.toHaveBeenCalled();
    expect(f.store.begin).not.toHaveBeenCalled();
    expect(f.work).not.toHaveBeenCalled();
  });
  it("cannot rebind another session, even for the same authenticated account and user", async () => {
    const f = fixture();
    const session = { ...f.session, actor: { ...actor, sessionId: "another-session" } };
    expect(countCaptureSessionOwner(session, "staging")).not.toBe(f.state.ownerHash);
    await expect(f.boundary.run(session, f.input, f.work)).rejects.toThrow("capture-stopped");
    expect(f.store.begin).not.toHaveBeenCalled();
    expect(f.work).not.toHaveBeenCalled();
  });
  it.each(["missing", "expired", "future", "failed", "frozen", "selection", "budget", "quote"])(
    "refuses %s without phase work or a new binding",
    async (mode) => {
      const f = fixture();
      if (mode === "missing") f.store.findOwner.mockResolvedValue(null);
      if (mode === "expired") f.state.expiresAt = "2026-10-13T08:01:00.000Z";
      if (mode === "future") f.state.admittedAt = "2026-10-13T08:03:00.000Z";
      if (mode === "failed" || mode === "frozen") f.state.stage = mode;
      if (mode === "selection") f.state.selectionHash = "b".repeat(64);
      if (mode === "budget") f.state.budgetHash = "b".repeat(64);
      const input =
        mode === "quote"
          ? {
              ...f.input,
              phase: "acquisition" as const,
              quote: { quoteId: f.state.quoteId!, fingerprint: "b".repeat(64) },
            }
          : f.input;
      await expect(f.boundary.run(f.session, input, f.work)).rejects.toThrow("capture-stopped");
      expect(f.store.begin).not.toHaveBeenCalled();
      expect(f.work).not.toHaveBeenCalled();
    },
  );
  it("refuses phase replay at the durable boundary, not just in a browser", async () => {
    const f = fixture();
    f.store.begin.mockRejectedValue(new Error("capture-stopped"));
    await expect(f.boundary.run(f.session, f.input, f.work)).rejects.toThrow("capture-stopped");
    expect(f.work).not.toHaveBeenCalled();
  });
  it.each(["operation", "commit"])("retains a closed phase after %s uncertainty", async (mode) => {
    const f = fixture();
    if (mode === "operation") f.work.mockRejectedValue(new Error("synthetic-secret-must-not-escape"));
    else f.store.finish.mockRejectedValue(new Error("synthetic-secret-must-not-escape"));
    await expect(f.boundary.run(f.session, f.input, f.work)).rejects.toThrow(/^capture-stopped$/);
    expect(f.store.ledger.stop).toHaveBeenCalledExactlyOnceWith(f.binding);
    expect(countCaptureRequestIsBound()).toBe(false);
  });
  it("refuses non-staging before loading durable state", async () => {
    const f = fixture();
    const boundary = createCountCaptureSessionBoundary({ environment: "production", store: f.store });
    await expect(boundary.run(f.session, f.input, f.work)).rejects.toThrow("capture-stopped");
    expect(f.store.findOwner).not.toHaveBeenCalled();
  });
});
