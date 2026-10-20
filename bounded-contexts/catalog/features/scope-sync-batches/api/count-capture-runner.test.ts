import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  countCaptureBoundaryWaitMs,
  runCountCaptureJourney,
  type CountCaptureDeploymentCollection,
} from "./count-capture-runner";
import {
  syntheticCountCaptureCollection,
  syntheticCountLifecycleReceipt,
} from "../tests/count-lifecycle-receipt-fixture";
import * as receiptModule from "../domain/count-lifecycle-receipt";
import {
  classifyCountLifecycleReceipt,
  countCaptureCollectionSchema,
  validateCountLifecycleReceipt,
} from "../domain/count-lifecycle-receipt";
import * as acquisition from "../domain/count-acquisition";
import * as plan from "../domain/count-capture-plan";
import { decodedReceiptText } from "../domain/preview-probe-receipt";
import { guardDisabledMutant } from "../tests/count-capture-mutants";

const identity = { sha: "a".repeat(40), dispatchId: "synthetic-dispatch", scopeRecordId: "synthetic-scope" };
const now = () => "2026-10-13T08:06:00.000Z";
const runId = "00000000-0000-4000-8000-0000000000aa";
const sealAck = { runId, frozenAt: "2026-10-13T08:06:00.000Z" };

// Moves every instant of a synthetic control by whole seconds, so the collector's
// floored search lower bound keeps its relation to the deploy start.
function shifted<T>(value: T, offsetMs: number): T {
  if (typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value))
    return new Date(Date.parse(value) + offsetMs).toISOString() as T;
  if (Array.isArray(value)) return value.map((entry) => shifted(entry, offsetMs)) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shifted(entry, offsetMs)])) as T;
  return value;
}

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

  function journey(offsetMs = 0) {
    const receipt = shifted(syntheticCountLifecycleReceipt(), offsetMs);
    const baseline = {
      authority: receipt.authority,
      baseline: {
        selection: { ...receipt.selection, scopeRecordVersion: shifted("2026-10-13T07:00:00.000Z", offsetMs) },
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
      expiresAt: receipt.quote.expiresAt,
      state: "quoted",
    };
    const action = vi.fn(async (intent: string, _fields?: Readonly<Record<string, string>>) => {
      if (intent === "capture-baseline") return baseline;
      if (intent === "count-quote") return quote;
      if (intent === "capture-quote-readback") return { quote };
      if (intent === "preview") return { planFingerprint: receipt.preConfirm.currentFingerprint };
      if (intent === "capture-freeze") return sealAck;
      if (intent === "capture-complete") return { receipt };
      return { retained: true };
    });
    const collect = vi.fn<CountCaptureDeploymentCollection>(
      async () => structuredClone(receipt.freezeCollection) as Awaited<ReturnType<CountCaptureDeploymentCollection>>,
    );
    return { receipt, baseline, quote, action, collect };
  }

  it("uses one ordered journey that seals before its final collection and never confirms", async () => {
    const { receipt, action, collect } = journey();
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
      "capture-complete",
    ]);
    // The seal carries no collection; the completion names the acknowledged run.
    expect(action.mock.calls.at(-2)).toEqual(["capture-freeze", { dispatchId: identity.dispatchId }]);
    expect(action.mock.calls.at(-1)).toEqual([
      "capture-complete",
      { runId, dispatchId: identity.dispatchId, collection: JSON.stringify(receipt.freezeCollection) },
    ]);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(collect.mock.invocationCallOrder[1]).toBeGreaterThan(action.mock.invocationCallOrder[9]!);
  });

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
    "capture-complete",
  ])("never retries or performs a subsequent action after uncertain %s", async (failed) => {
    const { action: original, collect } = journey();
    const action = vi.fn(async (intent: string) => {
      if (intent === failed) throw new Error("synthetic-uncertainty");
      return original(intent);
    });
    const receipt = await runCountCaptureJourney(identity, action, now, collect);
    expect(receipt).toMatchObject({ schemaVersion: "scope-sync-count-lifecycle-stop/v1", reason: "capture-stopped" });
    expect(action.mock.calls.at(-1)).toEqual([failed, expect.any(Object)]);
    expect(action.mock.calls.filter(([intent]) => intent === failed)).toHaveLength(1);
  });

  it.each([
    ["a seal that names no run", { frozenAt: sealAck.frozenAt }],
    ["a seal without its boundary", { runId }],
    ["a seal that also assembles a receipt", { ...sealAck, receipt: syntheticCountLifecycleReceipt() }],
  ])("stops without completing or collecting after %s", async (_name, ack) => {
    const { action: original, collect } = journey();
    const action = vi.fn(async (intent: string) => (intent === "capture-freeze" ? ack : original(intent)));
    expect(await runCountCaptureJourney(identity, action, now, collect)).toMatchObject({
      phase: "freeze",
      reason: "capture-stopped",
    });
    expect(action.mock.calls.at(-1)?.[0]).toBe("capture-freeze");
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it("stops as deployment-unknown, without completing, when the final collector fails", async () => {
    const { action, collect, receipt } = journey();
    collect
      .mockResolvedValueOnce(structuredClone(receipt.freezeCollection) as never)
      .mockRejectedValueOnce(new Error("synthetic-collector-failure"));
    expect(await runCountCaptureJourney(identity, action, now, collect)).toMatchObject({
      phase: "freeze",
      reason: "deployment-unknown",
    });
    expect(action.mock.calls.at(-1)?.[0]).toBe("capture-freeze");
  });

  it("requires independently collected deployment before the initial notice", async () => {
    const { action, collect, receipt } = journey();
    collect.mockResolvedValue({
      ...receipt.freezeCollection,
      outcome: "unknown",
      reason: "authority-invalid",
      binding: null,
    } as never);
    expect(await runCountCaptureJourney(identity, action, now, collect)).toMatchObject({
      reason: "deployment-unknown",
    });
    expect(action).toHaveBeenCalledTimes(1);
  });

  const serverStop = (receipt: ReturnType<typeof syntheticCountLifecycleReceipt>) => ({
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
  });

  it("returns a valid server stop receipt from completion unchanged", async () => {
    const { action: original, collect, receipt } = journey();
    const stopReceipt = serverStop(receipt);
    const action = vi.fn(async (intent: string) =>
      intent === "capture-complete" ? { receipt: stopReceipt } : original(intent),
    );
    expect(await runCountCaptureJourney(identity, action, now, collect)).toEqual(stopReceipt);
  });

  it("forwards an unknown post-seal collector result and preserves the server stop", async () => {
    const { action: original, collect, receipt } = journey();
    const beforeFreeze = countCaptureCollectionSchema.parse(receipt.freezeCollection);
    const unknown = countCaptureCollectionSchema.parse({
      ...beforeFreeze,
      outcome: "unknown",
      reason: "authority-invalid",
      binding: null,
    });
    collect.mockResolvedValueOnce(beforeFreeze).mockResolvedValueOnce(unknown);
    const stopReceipt = serverStop(receipt);
    const action = vi.fn(async (intent: string, fields?: Readonly<Record<string, string>>) => {
      if (intent === "capture-complete") {
        expect(JSON.parse(fields!.collection!)).toEqual(unknown);
        return { receipt: stopReceipt };
      }
      return original(intent);
    });
    await expect(runCountCaptureJourney(identity, action, now, collect)).resolves.toEqual(stopReceipt);
  });

  it("refuses a completed receipt that names another boundary than the acknowledged seal", async () => {
    const { action: original, collect, receipt } = journey();
    const action = vi.fn(async (intent: string) =>
      intent === "capture-freeze" ? { runId, frozenAt: "2026-10-13T08:05:59.000Z" } : original(intent),
    );
    expect(await runCountCaptureJourney(identity, action, now, collect)).toMatchObject({
      reason: "missing-observation",
      evidence: { frozenAt: receipt.frozenAt },
    });
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

  // RUN-G1: the server seals at its own, later clock read. A double of both closing
  // protocols assembles the receipt from whatever collection it is handed, exactly
  // as the lifecycle does: a seal-and-assemble freeze (the superseded protocol) or a
  // seal acknowledgement followed by one exact-run completion.
  function boundaryServer(base: ReturnType<typeof journey>, serverNow: () => string) {
    const record: { frozenAt: string | null; collection: z.infer<typeof countCaptureCollectionSchema> | null } = {
      frozenAt: null,
      collection: null,
    };
    const assemble = (collection: z.infer<typeof countCaptureCollectionSchema>) => {
      const receipt = structuredClone(base.receipt);
      receipt.frozenAt = record.frozenAt!;
      receipt.effects.final.at = record.frozenAt!;
      receipt.attribution.phases.at(-1)!.endedAt = record.frozenAt!;
      record.collection = collection;
      const assembled = { ...receipt, freezeCollection: collection };
      return { receipt: { ...assembled, classification: classifyCountLifecycleReceipt(assembled) } };
    };
    const action = vi.fn(async (intent: string, fields: Readonly<Record<string, string>> = {}) => {
      if (intent === "capture-freeze") {
        if (record.frozenAt) throw new Error("synthetic-second-seal");
        record.frozenAt = serverNow();
        if (fields.collection) return assemble(countCaptureCollectionSchema.parse(JSON.parse(fields.collection)));
        return { runId, frozenAt: record.frozenAt };
      }
      if (intent === "capture-complete") {
        if (!record.frozenAt || record.collection || fields.runId !== runId) throw new Error("synthetic-refusal");
        return assemble(countCaptureCollectionSchema.parse(JSON.parse(fields.collection!)));
      }
      return base.action(intent);
    });
    return { action, record };
  }

  // The collector's own contract: collectedAt is exactly the supplied instant and its
  // run search ends there. The bound inventory itself is a labeled synthetic fixture.
  const fixtureCollector = vi.fn<CountCaptureDeploymentCollection>(async (_deployment, suppliedAt) =>
    countCaptureCollectionSchema.parse(syntheticCountCaptureCollection(suppliedAt)),
  );
  const shiftedCollector = (offsetMs: number) =>
    vi.fn<CountCaptureDeploymentCollection>(async (_deployment, suppliedAt) =>
      countCaptureCollectionSchema.parse({
        ...shifted(syntheticCountCaptureCollection("2026-10-13T08:06:00.000Z"), offsetMs),
        collectedAt: suppliedAt,
      }),
    );

  function expectBoundaryConforming(
    result: unknown,
    record: ReturnType<typeof boundaryServer>["record"],
    intents: readonly string[],
  ) {
    // The success assertion comes first: on the superseded protocol it is the one
    // that fails, and solely for freeze-unknown-or-drift.
    const validation = validateCountLifecycleReceipt(result);
    expect(validation.classification).toEqual({
      verdict: "CONFORMING",
      reasons: [],
      acceptance: {
        "9431-ac7": { verdict: "CONFORMING", reasons: [] },
        "9424-ac5": { verdict: "CONFORMING", reasons: [] },
      },
    });
    expect(validation.valid).toBe(true);
    expect(intents.slice(-2)).toEqual(["capture-freeze", "capture-complete"]);
    expect(Date.parse(record.collection!.collectedAt)).toBeGreaterThanOrEqual(Date.parse(record.frozenAt!));
  }

  describe("RUN-G1 advancing-clock freeze boundary", () => {
    it("qualifies a genuine post-seal collection under an advancing injected clock", async () => {
      // One clock shared by runner and server; every read advances it, never equal.
      let at = Date.parse("2026-10-13T08:05:59.900Z");
      const advancing = () => new Date((at += 7)).toISOString();
      const base = journey();
      const server = boundaryServer(base, advancing);
      fixtureCollector.mockClear();
      const result = await runCountCaptureJourney(identity, server.action, advancing, fixtureCollector);
      expectBoundaryConforming(
        result,
        server.record,
        server.action.mock.calls.map(([intent]) => intent),
      );
      expect(fixtureCollector.mock.calls[1]![1]).toBe(server.record.collection!.collectedAt);
      expect(Date.parse(server.record.collection!.collectedAt)).toBeGreaterThan(Date.parse(server.record.frozenAt!));
    });

    it("qualifies a credential-free wall-clock control after an awaited seal", async () => {
      const offset = Math.floor(Date.now() / 1000) * 1000 - Date.parse("2026-10-13T08:06:00.000Z");
      const base = journey(offset);
      const wall = () => new Date().toISOString();
      const server = boundaryServer(base, wall);
      const sealing = server.action.getMockImplementation()!;
      server.action.mockImplementation(async (intent, fields) => {
        if (intent === "capture-freeze") await new Promise((resolve) => setTimeout(resolve, 20));
        return sealing(intent, fields);
      });
      const result = await runCountCaptureJourney(identity, server.action, wall, shiftedCollector(offset));
      expectBoundaryConforming(
        result,
        server.record,
        server.action.mock.calls.map(([intent]) => intent),
      );
    });

    it("waits without I/O for a wall clock that trails the seal, then collects", async () => {
      const offset = Math.floor(Date.now() / 1000) * 1000 - Date.parse("2026-10-13T08:06:00.000Z");
      const base = journey(offset);
      const server = boundaryServer(base, () => new Date().toISOString());
      const trailing = () => new Date(Date.now() - 50).toISOString();
      const collect = shiftedCollector(offset);
      const result = await runCountCaptureJourney(identity, server.action, trailing, collect);
      expectBoundaryConforming(
        result,
        server.record,
        server.action.mock.calls.map(([intent]) => intent),
      );
      expect(collect).toHaveBeenCalledTimes(2);
    });

    function lagging(lagMs: number) {
      let at = Date.parse("2026-10-13T08:05:59.900Z");
      const slept: number[] = [];
      return {
        serverNow: () => new Date((at += 3)).toISOString(),
        runnerNow: () => new Date((at += 3) - lagMs).toISOString(),
        sleep: async (ms: number) => {
          slept.push(ms);
          at += ms;
        },
        slept,
      };
    }

    it("qualifies a runner clock trailing the seal within the bound only after its no-I/O wait", async () => {
      const clock = lagging(countCaptureBoundaryWaitMs - 1_000);
      const base = journey();
      const server = boundaryServer(base, clock.serverNow);
      const calls = () => server.action.mock.calls.length;
      let atSeal = 0;
      const sleep = async (ms: number) => {
        atSeal ||= calls();
        await clock.sleep(ms);
      };
      const result = await runCountCaptureJourney(identity, server.action, clock.runnerNow, fixtureCollector, sleep);
      expectBoundaryConforming(
        result,
        server.record,
        server.action.mock.calls.map(([intent]) => intent),
      );
      expect(clock.slept.length).toBeGreaterThan(0);
      expect(clock.slept.reduce((total, ms) => total + ms, 0)).toBeLessThanOrEqual(countCaptureBoundaryWaitMs);
      // No action was sent while the runner waited for its clock to reach the seal.
      expect(atSeal).toBe(10);
    });

    it("stops as deployment-unknown, with no completion or send, when the runner trails beyond the bound", async () => {
      const clock = lagging(countCaptureBoundaryWaitMs + 1_000);
      const base = journey();
      const server = boundaryServer(base, clock.serverNow);
      fixtureCollector.mockClear();
      const result = await runCountCaptureJourney(
        identity,
        server.action,
        clock.runnerNow,
        fixtureCollector,
        clock.sleep,
      );
      expect(result).toMatchObject({ phase: "freeze", reason: "deployment-unknown" });
      expect(server.action.mock.calls.at(-1)?.[0]).toBe("capture-freeze");
      expect(server.record.collection).toBeNull();
      expect(fixtureCollector).toHaveBeenCalledTimes(1);
      expect(clock.slept).toEqual([]);
    });

    // Candidate GREEN / mutant RED: only the boundary wait differs between halves.
    const bypassedRunner = () =>
      guardDisabledMutant<typeof runCountCaptureJourney>(
        "../api/count-capture-runner.ts",
        ["while (Date.parse(collectedAt) < boundary) {", "while (false) {"],
        "runCountCaptureJourney",
        { z, ...receiptModule, countQuoteSchema: acquisition.countQuoteSchema },
      );

    it("boundary-check-bypassed mutant retains a pre-boundary collection as INCOMPLETE", async () => {
      const clock = lagging(5_000);
      const base = journey();
      const candidate = boundaryServer(base, clock.serverNow);
      expectBoundaryConforming(
        await runCountCaptureJourney(identity, candidate.action, clock.runnerNow, fixtureCollector, clock.sleep),
        candidate.record,
        candidate.action.mock.calls.map(([intent]) => intent),
      );
      const mutantClock = lagging(5_000);
      const mutant = boundaryServer(journey(), mutantClock.serverNow);
      const result = await bypassedRunner()(
        identity,
        mutant.action,
        mutantClock.runnerNow,
        fixtureCollector,
        mutantClock.sleep,
      );
      expect(Date.parse(mutant.record.collection!.collectedAt)).toBeLessThan(Date.parse(mutant.record.frozenAt!));
      expect(validateCountLifecycleReceipt(result)).toMatchObject({
        valid: true,
        classification: {
          verdict: "INCOMPLETE",
          reasons: ["freeze-unknown-or-drift"],
          acceptance: {
            "9431-ac7": { verdict: "INCOMPLETE", reasons: ["freeze-unknown-or-drift"] },
            "9424-ac5": { verdict: "INCOMPLETE", reasons: ["freeze-unknown-or-drift"] },
          },
        },
      });
    });

    it("keeps the unchanged validator's boundary predicate load-bearing", async () => {
      const clock = lagging(5_000);
      const server = boundaryServer(journey(), clock.serverNow);
      const result = await bypassedRunner()(identity, server.action, clock.runnerNow, fixtureCollector, clock.sleep);
      const withoutBoundary = guardDisabledMutant<Pick<typeof receiptModule, "classifyCountLifecycleReceipt">>(
        "../domain/count-lifecycle-receipt.ts",
        [
          '||\n    at(receipt.freezeCollection.collectedAt) < at(receipt.frozenAt)\n  )\n    miss("freeze-unknown-or-drift");',
          ')\n    miss("freeze-unknown-or-drift");',
        ],
        "({ classifyCountLifecycleReceipt })",
        { z, ...acquisition, ...plan, decodedReceiptText },
      );
      expect(classifyCountLifecycleReceipt(result).verdict).toBe("INCOMPLETE");
      expect(withoutBoundary.classifyCountLifecycleReceipt(result).verdict).toBe("CONFORMING");
    });

    it.each([
      ["drift", { binding: { runId: "100", attempt: 1, jobId: "201", stepNumber: 35 } }],
      ["unknown", { outcome: "unknown", reason: "inventory-truncated", binding: null }],
    ] as const)("never qualifies a post-seal %s collection", async (_name, change) => {
      let at = Date.parse("2026-10-13T08:05:59.900Z");
      const advancing = () => new Date((at += 7)).toISOString();
      const server = boundaryServer(journey(), advancing);
      const collect = vi.fn<CountCaptureDeploymentCollection>(async (_deployment, suppliedAt) => {
        const value = syntheticCountCaptureCollection(suppliedAt);
        return countCaptureCollectionSchema.parse({
          ...value,
          ...change,
          binding: change.binding && { ...value.binding, ...change.binding },
        });
      });
      collect.mockResolvedValueOnce(
        countCaptureCollectionSchema.parse(syntheticCountCaptureCollection("2026-10-13T08:01:30.000Z")),
      );
      const result = await runCountCaptureJourney(identity, server.action, advancing, collect);
      expect(Date.parse(server.record.collection!.collectedAt)).toBeGreaterThanOrEqual(
        Date.parse(server.record.frozenAt!),
      );
      expect(validateCountLifecycleReceipt(result).classification).toMatchObject({
        verdict: "INCOMPLETE",
        reasons: ["freeze-unknown-or-drift"],
      });
    });
  });
});
