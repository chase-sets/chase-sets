import { describe, expect, it, vi } from "vitest";
import { runCountCaptureJourney } from "./count-capture-runner";
import { syntheticCountLifecycleReceipt } from "../tests/count-lifecycle-receipt-fixture";
import { normalizeScopeSyncBatchBudget } from "../domain/batch";

const identity = { sha: "a".repeat(40), dispatchId: "synthetic-dispatch", scopeRecordId: "synthetic-scope" };
const now = () => "2026-10-13T08:06:00.000Z";

describe("isolates the count capture runner", () => {
  it("stops before any action when immutable identity is absent", async () => {
    const action = vi.fn();
    const result = await runCountCaptureJourney({ ...identity, sha: "main" }, action, now);
    expect(action).not.toHaveBeenCalled();
    expect(result).toMatchObject({ phase: "baseline", reason: "authority-unbound", evidence: {} });
  });

  it("does not turn a missing deployed baseline into a preview or count acquisition", async () => {
    const action = vi.fn().mockRejectedValue(new Error("synthetic-private-session-marker"));
    const result = await runCountCaptureJourney(identity, action, now);
    expect(action.mock.calls).toEqual([["capture-baseline", identity]]);
    expect(result).toMatchObject({ phase: "baseline", reason: "capture-stopped", evidence: {} });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-session-marker");
  });

  it("rejects a forged or stale baseline before any spend", async () => {
    const receipt = syntheticCountLifecycleReceipt();
    const action = vi.fn().mockResolvedValue({ authority: receipt.authority });
    expect(await runCountCaptureJourney(identity, action, now)).toMatchObject({ phase: "baseline" });
    expect(action).toHaveBeenCalledTimes(1);
  });

  function journey(bootstrapRequired = false) {
    const receipt = syntheticCountLifecycleReceipt();
    const baseline = {
      authority: receipt.authority,
      selection: receipt.selection,
      units: receipt.units,
      effects: receipt.effects,
      plannerInput: {
        selection: { mode: "ids", scopeRecordIds: [identity.scopeRecordId] },
        budget: normalizeScopeSyncBatchBudget(),
      },
      bootstrapRequired,
      providerEgressDenied: true,
    };
    const quote = {
      quoteId: receipt.notices.quoteId,
      fingerprint: receipt.notices.quoteFingerprint,
      plannedCount: 2,
      serverCap: 2,
    };
    const action = vi.fn(async (intent: string) => {
      if (intent === "capture-baseline") return baseline;
      if (intent === "count-quote" || intent === "capture-quote-readback") return quote;
      if (intent === "preview") return { planFingerprint: receipt.preConfirm.currentFingerprint };
      if (intent === "pre-confirm-planner-read") {
        const { blockers: _blockers, ...observation } = receipt.preConfirm;
        return { ...observation, refusal: null };
      }
      if (intent === "capture-freeze") return receipt;
      return { retained: true };
    });
    const collect = vi.fn(async () => receipt.freezeCollection);
    return { receipt, baseline, quote, action, collect };
  }

  it.each([false, true])(
    "uses one ordered journey, with optional bootstrap %s, and never confirms",
    async (bootstrap) => {
      const { receipt, action, collect } = journey(bootstrap);
      expect(await runCountCaptureJourney(identity, action, now, collect)).toEqual(receipt);
      expect(action.mock.calls.map(([intent]) => intent)).toEqual([
        "capture-baseline",
        "capture-initial-notice",
        ...(bootstrap ? ["capture-usage"] : []),
        "count-quote",
        "capture-quote-readback",
        "capture-final-notice",
        "count-acquire",
        "preview",
        "pre-confirm-planner-read",
        "capture-freeze",
      ]);
      expect(collect).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    "capture-baseline",
    "capture-initial-notice",
    "capture-usage",
    "count-quote",
    "capture-quote-readback",
    "capture-final-notice",
    "count-acquire",
    "preview",
    "pre-confirm-planner-read",
    "capture-freeze",
  ])("never retries or performs a subsequent action after uncertain %s", async (failed) => {
    const { action: original, collect } = journey(true);
    const action = vi.fn(async (intent: string) => {
      if (intent === failed) throw new Error("synthetic-uncertainty");
      return original(intent);
    });
    const receipt = await runCountCaptureJourney(identity, action, now, collect);
    expect(receipt).toMatchObject({ schemaVersion: "scope-sync-count-lifecycle-stop/v1", reason: "capture-stopped" });
    expect(action.mock.calls.at(-1)).toEqual([failed, expect.any(Object)]);
    expect(action.mock.calls.filter(([intent]) => intent === failed)).toHaveLength(1);
  });

  it("requires independently collected deployment before the initial notice", async () => {
    const { action, collect, receipt } = journey();
    collect.mockResolvedValue({ ...receipt.freezeCollection, complete: false });
    expect(await runCountCaptureJourney(identity, action, now, collect)).toMatchObject({
      reason: "deployment-unknown",
    });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("does not spend when a duplicate unit hides the third roster member", async () => {
    const { action, collect, baseline } = journey();
    baseline.units[2] = baseline.units[1]!;
    expect(await runCountCaptureJourney(identity, action, now, collect)).toMatchObject({ reason: "authority-unbound" });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("stops on changed quote read-back rather than re-quoting", async () => {
    const { action: original, collect, quote } = journey();
    const action = vi.fn(async (intent: string) =>
      intent === "capture-quote-readback" ? { ...quote, fingerprint: "e".repeat(64) } : original(intent),
    );
    expect(await runCountCaptureJourney(identity, action, now, collect)).toMatchObject({ phase: "quote" });
    expect(action.mock.calls.at(-1)?.[0]).toBe("capture-quote-readback");
  });

  it.each(["absent", "wrong-scope", "missing-budget", "extra-provider"])(
    "refuses %s planner input before notice or spend",
    async (mode) => {
      const { action: original, collect, baseline } = journey();
      const changed = structuredClone(baseline) as Record<string, unknown>;
      if (mode === "absent") delete changed.plannerInput;
      else {
        const input = structuredClone(baseline.plannerInput) as Record<string, unknown>;
        if (mode === "wrong-scope") input.selection = { mode: "ids", scopeRecordIds: ["synthetic-other"] };
        if (mode === "missing-budget") delete input.budget;
        if (mode === "extra-provider")
          input.budget = { ...baseline.plannerInput.budget, providerConcurrency: { unrelated: 1 } };
        changed.plannerInput = input;
      }
      const action = vi.fn(async (intent: string) => (intent === "capture-baseline" ? changed : original(intent)));
      expect(await runCountCaptureJourney(identity, action, now, collect)).toMatchObject({ phase: "baseline" });
      expect(action).toHaveBeenCalledTimes(1);
      expect(collect).not.toHaveBeenCalled();
    },
  );

  it.each([
    { retained: true },
    { comparedFingerprint: "e".repeat(64) },
    { currentFingerprint: "e".repeat(64) },
    { effectsCapability: true },
    { eligible: false, refusal: null },
    { nested: { secret: "synthetic-private-marker" } },
  ])("refuses an unbound or malformed pre-confirm result without freeze", async (change) => {
    const { action: original, collect } = journey();
    const action = vi.fn(async (intent: string) => {
      const value = await original(intent);
      return intent === "pre-confirm-planner-read" ? { ...value, ...change } : value;
    });
    const result = await runCountCaptureJourney(identity, action, now, collect);
    expect(result).toMatchObject({ schemaVersion: "scope-sync-count-lifecycle-stop/v1", phase: "pre-confirm" });
    expect(action.mock.calls.at(-1)?.[0]).toBe("pre-confirm-planner-read");
    expect(JSON.stringify(result)).not.toContain("synthetic-private-marker");
  });

  it("does not substitute a different final receipt for the observed planner fingerprint", async () => {
    const { action: original, collect, receipt } = journey();
    const action = vi.fn(async (intent: string) => {
      if (intent === "preview") return { planFingerprint: "e".repeat(64) };
      if (intent === "pre-confirm-planner-read")
        return {
          comparedFingerprint: "e".repeat(64),
          currentFingerprint: "e".repeat(64),
          eligible: true,
          refusal: null,
          effectsCapability: false,
        };
      return original(intent);
    });
    expect(await runCountCaptureJourney(identity, action, now, collect)).toMatchObject({
      phase: "freeze",
      reason: "missing-observation",
    });
    expect(receipt.preConfirm.currentFingerprint).not.toBe("e".repeat(64));
  });
});
