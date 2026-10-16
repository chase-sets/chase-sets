import { describe, expect, it, vi } from "vitest";
import { runCountCaptureJourney, type CountCaptureDeploymentCollection } from "./count-capture-runner";
import { syntheticCountLifecycleReceipt } from "../tests/count-lifecycle-receipt-fixture";

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
      baseline: {
        selection: { ...receipt.selection, scopeRecordVersion: "2026-10-13T07:00:00.000Z" },
        units: receipt.units,
        countAuthority: { fingerprint: "a".repeat(64), headroom: 30, allowed: true },
        effects: { ...receipt.effects.baseline, batches: 0, reservations: 0, jobs: 0, enqueues: 0, imports: 0 },
      },
      providerSends: 0,
    };
    const quote = {
      quoteId: receipt.quote.quoteId,
      fingerprint: receipt.quote.fingerprint,
      membershipFingerprint: "6".repeat(64),
      selection: receipt.selection,
      authority: { fingerprint: "5".repeat(64), headroom: 30, allowed: true },
      targets: receipt.quote.queries.map((query) => ({
        scopeRecordId: receipt.selection.scopeRecordId,
        query,
        source: null,
        blocked: false,
      })),
      plannedCredits: 2,
      cap: 2,
      expiresAt: "2026-10-13T08:12:10.000Z",
      state: "quoted",
    };
    const action = vi.fn(async (intent: string) => {
      if (intent === "capture-baseline") return baseline;
      if (intent === "count-quote") return quote;
      if (intent === "capture-quote-readback") return { quote };
      if (intent === "preview") return { planFingerprint: receipt.preConfirm.currentFingerprint };
      if (intent === "capture-freeze") return { receipt };
      return { retained: true };
    });
    const collect = vi.fn<CountCaptureDeploymentCollection>(
      async () => structuredClone(receipt.freezeCollection) as Awaited<ReturnType<CountCaptureDeploymentCollection>>,
    );
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
        "capture-usage",
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
    collect.mockResolvedValue({
      ...receipt.freezeCollection,
      outcome: "unknown",
      reason: "authority-invalid",
      binding: null,
    });
    expect(await runCountCaptureJourney(identity, action, now, collect)).toMatchObject({
      reason: "deployment-unknown",
    });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("returns a valid server stop receipt from freeze unchanged", async () => {
    const { action: original, collect, receipt } = journey();
    const stopReceipt = {
      schemaVersion: "scope-sync-count-lifecycle-stop/v1",
      attribution: receipt.attribution,
      stoppedAt: receipt.frozenAt,
      phase: "freeze",
      reason: "missing-observation",
      evidence: {
        startedAt: receipt.startedAt,
        frozenAt: receipt.frozenAt,
        sends: receipt.sends,
        effects: receipt.effects,
      },
      classification: {
        verdict: "INCOMPLETE",
        reasons: ["missing-observation"],
        acceptance: {
          "9431-ac7": { verdict: "INCOMPLETE", reasons: ["missing-observation"] },
          "9424-ac5": { verdict: "INCOMPLETE", reasons: ["missing-observation"] },
        },
      },
    };
    const action = vi.fn(async (intent: string, fields: Readonly<Record<string, string>>) =>
      intent === "capture-freeze" ? { receipt: stopReceipt } : original(intent),
    );
    expect(await runCountCaptureJourney(identity, action, now, collect)).toEqual(stopReceipt);
  });

  it("preserves a freeze-time drift as the server's incomplete stop", async () => {
    const { action: original, collect, receipt } = journey();
    const drifted = { ...receipt.freezeCollection, collectedAt: "2026-10-13T08:05:00.000Z" };
    collect.mockResolvedValueOnce(receipt.freezeCollection).mockResolvedValueOnce(drifted);
    const stopReceipt = {
      schemaVersion: "scope-sync-count-lifecycle-stop/v1",
      attribution: receipt.attribution,
      stoppedAt: receipt.frozenAt,
      phase: "freeze",
      reason: "missing-observation",
      evidence: {
        startedAt: receipt.startedAt,
        frozenAt: receipt.frozenAt,
        sends: receipt.sends,
        effects: receipt.effects,
      },
      classification: {
        verdict: "INCOMPLETE",
        reasons: ["missing-observation"],
        acceptance: {
          "9431-ac7": { verdict: "INCOMPLETE", reasons: ["missing-observation"] },
          "9424-ac5": { verdict: "INCOMPLETE", reasons: ["missing-observation"] },
        },
      },
    };
    const action = vi.fn(async (intent: string, fields: Readonly<Record<string, string>>) =>
      intent === "capture-freeze" ? { receipt: stopReceipt } : original(intent),
    );
    const result = await runCountCaptureJourney(identity, action, now, collect);
    expect(result).toMatchObject({ reason: "missing-observation", classification: { verdict: "INCOMPLETE" } });
  });

  it("stops after no action when the deployment collector is absent", async () => {
    const { action } = journey();
    expect(await runCountCaptureJourney(identity, action, now)).toMatchObject({ reason: "deployment-unknown" });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("does not spend when a duplicate unit hides the third roster member", async () => {
    const { action, collect, baseline } = journey();
    baseline.baseline.units[2] = baseline.baseline.units[1]!;
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
});
