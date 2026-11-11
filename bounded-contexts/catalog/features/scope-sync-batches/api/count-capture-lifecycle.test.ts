import { randomUUID } from "node:crypto";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import * as transport from "../../source-observations/api/providers/count-capture-transport";
import { CountCaptureStopped } from "../../source-observations/api/providers/count-capture-transport";
import {
  SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "../../source-observations/api/providers/scrydex/adapter";
import * as acquisition from "../domain/count-acquisition";
import * as plan from "../domain/count-capture-plan";
import * as receipt from "../domain/count-lifecycle-receipt";
import * as period from "../domain/scrydex-billing-period";
import { syntheticPeriod, periodGateForTest } from "../tests/scrydex-period-fixture";
import { captureLifecycleMutant } from "../tests/count-capture-counts-mutants";
import { createCountCaptureStore, type CountCaptureRun } from "../read-model/count-capture-store";
import { guardDisabledMutant } from "../tests/count-capture-mutants";
import {
  captureActor,
  captureAt,
  captureAuthority,
  captureBaseline,
  captureHost,
  captureScope,
  captureSession,
  beginCapturePhase,
  recordSyntheticCapturePeriodDecision,
  createCaptureLifecycleFixture,
} from "../tests/count-capture-session-fixture";
import { createCountCaptureLifecycle } from "./count-capture-lifecycle";

const input = () => ({ scopeRecordId: captureScope, authority: captureAuthority() });
const durable = (f: ReturnType<typeof createCaptureLifecycleFixture>) => {
  const last = f.memory.history.at(-1);
  return (last?.payload ?? null) as CountCaptureRun | null;
};
const other = () => captureSession({ actor: captureActor({ sessionId: "synthetic-other-session" }) });

describe("producer-owned billing-period gate", () => {
  it("seeds synthetic phase admission at the run clock rather than the fixed fixture instant", async () => {
    const clock = { now: "2026-11-11T08:02:00.000Z" };
    const f = createCaptureLifecycleFixture({ clock });
    const run = await f.store.admit({ ownerHash: "a".repeat(64), scopeRecordId: captureScope, host: captureHost() });
    const binding = await beginCapturePhase(f.store, run.runId, "acquisition");
    await expect(
      f.store.ledger.debit(binding, { category: "cards", requestFingerprint: "d".repeat(64) }),
    ).resolves.toBe(1);
    expect((await f.store.read(run.runId)).periodLedger?.decision).toMatchObject({
      observedAt: clock.now,
      plannedCredits: 10,
    });
    expect(f.usage.fetch).not.toHaveBeenCalled();
  });
  it("seeds a synthetic cold preflight in P exactly once before later phase sends", async () => {
    const f = createCaptureLifecycleFixture({ clock: { now: "2026-11-11T08:02:00.000Z" } });
    const run = await f.store.admit({ ownerHash: "a".repeat(64), scopeRecordId: captureScope, host: captureHost() });
    const bootstrap = await beginCapturePhase(f.store, run.runId, "bootstrap");
    await f.store.ledger.result(
      bootstrap,
      await f.store.ledger.debit(bootstrap, {
        category: "usage",
        usage: { purpose: "bootstrap" },
        requestFingerprint: "d".repeat(64),
      }),
      200,
    );
    await recordSyntheticCapturePeriodDecision(f.store, bootstrap);
    await f.store.recordUsage(bootstrap, {
      state: "persisted",
      required: 11,
      authority: captureBaseline().countAuthority,
    });
    await f.store.finish(bootstrap);
    const binding = await f.store.begin(run.runId, "acquisition");
    await expect(
      f.store.ledger.debit(binding, { category: "cards", requestFingerprint: "d".repeat(64) }),
    ).resolves.toBe(2);
    expect((await f.store.read(run.runId)).periodLedger?.decision).toMatchObject({
      admitted: true,
      plannedCredits: 11,
      unreflectedCredits: 0,
    });
    expect(f.usage.fetch).not.toHaveBeenCalled();
  });
  async function noticed() {
    const f = createCaptureLifecycleFixture();
    await f.lifecycle.baseline(captureSession(), input());
    await f.lifecycle.initialNotice(captureSession());
    return f;
  }
  const factory =
    process.env.SCRYDEX_PERIOD_MUTANT === "bypass-period-cap"
      ? captureLifecycleMutant([["const decision = evaluateScrydexBillingPeriod({", "const decision = periodGate({"]], {
          periodGate: periodGateForTest(),
        })
      : createCountCaptureLifecycle;
  it("period-cap boundary refuses provider consumed plus actual plan above 50,000 despite host withinAllowance", async () => {
    const f = await noticed();
    f.usage.fetch.mockImplementation(async () =>
      Response.json({
        data: {
          credits_remaining: 50_010,
          total_credits_consumed: 49_990,
          overage_credits_consumed: 0,
          period_start: syntheticPeriod.startsAt,
          period_end: syntheticPeriod.endsAt,
        },
      }),
    );
    const lifecycle = factory(f.deps);
    await expect(lifecycle.usage(captureSession())).rejects.toThrow(CountCaptureStopped);
    expect(durable(f)).toMatchObject({
      status: "stopped",
      periodLedger: {
        decision: { admitted: false, reason: "usage-period-cap", plannedCredits: 11, consumedCredits: 49_990 },
        terminal: { outcome: "uncertain" },
      },
    });
    expect(f.usage.getUsageSnapshot).toHaveBeenCalledOnce();
    expect(durable(f)?.sends.map((send) => send.category)).toEqual(["usage"]);
  });
  it.each(["stale", "missing", "unknown-u"])(
    "refuses %s producer evidence before quote or acquisition",
    async (name) => {
      const f = await noticed();
      const periodLedger = async () => ({
        snapshot: {
          allowance: 100_000,
          balance: 100_000,
          observedAt: name === "stale" ? "2026-10-13T07:46:59.000Z" : captureAt,
          period: name === "missing" ? undefined : syntheticPeriod,
        },
        durableCredits: name === "unknown-u" ? null : 0,
      });
      await expect(createCountCaptureLifecycle({ ...f.deps, periodLedger }).usage(captureSession())).rejects.toThrow(
        CountCaptureStopped,
      );
      expect(durable(f)?.periodLedger?.decision).toMatchObject({ admitted: false, reason: "usage-period-cap" });
      await expect(f.lifecycle.usage(captureSession())).rejects.toThrow(CountCaptureStopped);
      expect(f.usage.getUsageSnapshot).toHaveBeenCalledOnce();
    },
  );
  it("does not accept host withinAllowance or a raw producer result without retained matching evidence", async () => {
    const f = await noticed();
    await expect(
      createCountCaptureLifecycle({ ...f.deps, observeUsage: async () => ({ withinAllowance: true }) }).usage(
        captureSession(),
      ),
    ).rejects.toThrow(CountCaptureStopped);
    expect(f.usage.fetch).not.toHaveBeenCalled();
    expect(durable(f)?.periodLedger?.decision).toMatchObject({ admitted: false, reason: "usage-period-cap" });
  });
  it("records the preflight once in P, not U, and retains one terminal result on replay", async () => {
    const f = await noticed();
    await f.lifecycle.usage(captureSession());
    const run = durable(f)!;
    expect(run.periodLedger?.decision).toMatchObject({ admitted: true, plannedCredits: 11, unreflectedCredits: 0 });
    expect(run.sends).toHaveLength(1);
    const binding = await f.store.begin(run.runId, "quote");
    await f.store.ledger.stop(binding);
    const stopped = durable(f)!;
    const count = f.memory.history.length;
    await f.store.ledger.stop(binding);
    expect(f.memory.history).toHaveLength(count);
    expect(durable(f)?.periodLedger).toEqual(stopped.periodLedger);
  });
  it("refuses a legacy retained run without period admission even when host authority is absent", async () => {
    const f = await noticed();
    await f.lifecycle.usage(captureSession());
    const retained = durable(f)!;
    retained.authority = null;
    retained.periodLedger = null;
    const binding = await f.store.begin(retained.runId, "preview");
    await expect(
      f.store.ledger.debit(binding, {
        category: "usage",
        usage: { purpose: "readiness" },
        requestFingerprint: "e".repeat(64),
      }),
    ).rejects.toThrow(CountCaptureStopped);
    expect(durable(f)?.sends).toHaveLength(1);
    expect(durable(f)?.status).toBe("stopped");
  });
});

// Every step a capture driver can take before spend, from each reachable stage.
type Step = "baseline" | "notice" | "usage" | "quote";
async function step(f: ReturnType<typeof createCaptureLifecycleFixture>, name: Step) {
  if (name === "baseline") return f.lifecycle.baseline(captureSession(), input());
  if (name === "notice") return f.lifecycle.initialNotice(captureSession());
  if (name === "usage") return f.lifecycle.usage(captureSession());
  // The quote handler belongs to a later slice; its phase is gated by the same store.
  return f.store.begin((await f.store.activeRun(durable(f)!.ownerHash)).runId, "quote");
}

describe("pre-spend stage machine", () => {
  it("records the initial notice durably and reads it back before any send", async () => {
    const f = createCaptureLifecycleFixture();
    const baseline = await f.lifecycle.baseline(captureSession(), input());
    const { notice } = await f.lifecycle.initialNotice(captureSession());
    // The returned notice is the durable record, read back after the commit.
    expect(notice).toEqual(durable(f)!.notice);
    expect(notice.recordedAt).toBe(captureAt);
    expect(notice.fingerprint).toBe(acquisition.countFingerprint(notice.body));
    expect(notice.body).toEqual({
      kind: "initial",
      environment: "staging",
      selection: baseline.baseline.selection,
      host: baseline.host,
      caps: { count: 2, usage: 9, total: 11, bootstrap: 1, preview: 4, preConfirm: 4, otherProviders: 0 },
      overage: "refused",
      countDebits: "separate-from-batch-reservation",
      baselineFingerprint: acquisition.countFingerprint(baseline.baseline),
    });
    expect(durable(f)).toMatchObject({ status: "open", phases: ["baseline"], sends: [], usage: null });
    expect(f.usage.fetch).not.toHaveBeenCalled();
  });

  // [stage reached, next step, outcome]. A refusal after admission stops the run.
  const matrix: readonly (readonly [readonly Step[], Step, "accepted" | "refused"])[] = [
    [[], "notice", "refused"],
    [[], "usage", "refused"],
    [["baseline"], "usage", "refused"],
    [["baseline"], "quote", "refused"],
    [["baseline"], "notice", "accepted"],
    [["baseline", "notice"], "notice", "refused"],
    [["baseline", "notice"], "quote", "refused"],
    [["baseline", "notice"], "baseline", "refused"],
    [["baseline", "notice"], "usage", "accepted"],
    [["baseline", "notice", "usage"], "usage", "refused"],
    [["baseline", "notice", "usage"], "notice", "refused"],
    [["baseline", "notice", "usage"], "quote", "accepted"],
  ];
  it.each(matrix)("from %j, %s is %s", async (stage, next, outcome) => {
    const f = createCaptureLifecycleFixture();
    for (const reached of stage) await step(f, reached);
    const before = durable(f);
    const attempt = step(f, next);
    if (outcome === "accepted") {
      await expect(attempt).resolves.toBeDefined();
      expect(durable(f)?.status).toBe("open");
    } else {
      await expect(attempt).rejects.toThrow(CountCaptureStopped);
      // An unadmitted step writes nothing; an admitted run that refuses is stopped for good.
      if (!before) expect(f.memory.history).toEqual([]);
      else if (next !== "baseline") expect(durable(f)).toMatchObject({ status: "stopped" });
    }
    expect(f.usage.fetch).toHaveBeenCalledTimes(
      stage.includes("usage") || (next === "usage" && outcome === "accepted") ? 1 : 0,
    );
  });

  it("never re-arms a stopped run by replay or refresh", async () => {
    const f = createCaptureLifecycleFixture();
    await step(f, "baseline");
    await expect(step(f, "usage")).rejects.toThrow(CountCaptureStopped);
    for (const next of ["notice", "usage", "baseline"] as const)
      await expect(step(f, next)).rejects.toThrow(CountCaptureStopped);
    expect(durable(f)).toMatchObject({ status: "stopped", notice: null, usage: null, phases: ["baseline"] });
    expect(new Set(f.memory.history.map((entry) => entry.run_id)).size).toBe(1);
    expect(f.usage.fetch).not.toHaveBeenCalled();
  });

  it("refuses another session's notice or usage without touching the owner's run", async () => {
    const f = createCaptureLifecycleFixture();
    await step(f, "baseline");
    const written = f.memory.history.length;
    await expect(f.lifecycle.initialNotice(other())).rejects.toThrow(CountCaptureStopped);
    await step(f, "notice");
    await expect(f.lifecycle.usage(other())).rejects.toThrow(CountCaptureStopped);
    expect(f.memory.history.length).toBe(written + 1);
    expect(durable(f)).toMatchObject({ status: "open", usage: null });
    expect(f.usage.fetch).not.toHaveBeenCalled();
  });

  it("records each stage once per bound request", async () => {
    const f = createCaptureLifecycleFixture();
    const run = await f.store.admit({ ownerHash: "a".repeat(64), scopeRecordId: captureScope, host: captureHost() });
    const baseline = await f.store.begin(run.runId, "baseline");
    await f.store.recordBaseline(baseline, captureBaseline());
    await expect(f.store.recordBaseline(baseline, captureBaseline())).rejects.toThrow(CountCaptureStopped);
    expect(durable(f)).toMatchObject({ status: "stopped" });
  });
});

// Original #9520 AC6 floor: each owned store guard, disabled alone at every point
// that enforces it, admits its hostile case.
describe("guard-disabled bypass mutants", () => {
  const bindings = {
    randomUUID,
    z,
    withPgTransaction,
    ...transport,
    ...acquisition,
    ...plan,
    ...period,
    countCaptureAuthoritySchema: receipt.countCaptureAuthoritySchema,
    countLifecycleReceiptSchema: receipt.countLifecycleReceiptSchema,
    countLifecycleStopReceiptSchema: receipt.countLifecycleStopReceiptSchema,
    SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
    SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  };
  const next = (dispatchId: string) => ({
    ...input(),
    authority: {
      ...captureAuthority(),
      dispatchId,
      dispatchedAt: "2026-10-13T08:10:00.000Z",
      budget: { ...captureAuthority().budget, observedAt: "2026-10-13T08:10:00.000Z" },
      pods: { ...captureAuthority().pods, observedAt: "2026-10-13T08:11:00.000Z" },
      collection: { ...captureAuthority().collection, collectedAt: "2026-10-13T08:12:00.000Z" },
    },
  });
  type Hostile = (f: ReturnType<typeof createCaptureLifecycleFixture>) => Promise<unknown>;
  const guards: Record<string, readonly [readonly (readonly [string, string])[], Hostile]> = {
    "active-run": [
      [["if (retained.some((run) => active(run, admittedAt))) throw new CountCaptureStopped();", ""]],
      async (f) => {
        await step(f, "baseline");
        return f.lifecycle.baseline(other(), { ...input(), authority: { ...captureAuthority(), dispatchId: "d2" } });
      },
    ],
    replay: [
      [
        [
          "if (retained.some((run) => run.host.dispatchId === input.host.dispatchId)) throw new CountCaptureStopped();",
          "",
        ],
      ],
      async (f) => {
        await step(f, "baseline");
        f.clock.now = "2026-10-13T08:17:00.000Z";
        return f.lifecycle.baseline(captureSession(), next("synthetic-dispatch"));
      },
    ],
    "initial-notice": [
      [['if (phase !== "baseline" && !run.notice) throw new CountCaptureStopped();', ""]],
      async (f) => {
        await step(f, "baseline");
        return step(f, "usage");
      },
    ],
    "notice replay": [
      [["run.request || run.notice || run.phases", "run.request || run.phases"]],
      async (f) => {
        await step(f, "baseline");
        await step(f, "notice");
        return step(f, "notice");
      },
    ],
    "usage outcome": [
      [['if (phaseOrder(phase) > phaseOrder("bootstrap") && !run.usage) throw new CountCaptureStopped();', ""]],
      async (f) => {
        await step(f, "baseline");
        await step(f, "notice");
        return step(f, "quote");
      },
    ],
    // Phase order is enforced on begin and again by the closed run schema.
    "phase order": [
      [
        ["(last !== undefined && phaseOrder(phase) <= phaseOrder(last))", "false"],
        ["index === 0 || phaseOrder(run.phases[index - 1]!) < phaseOrder(phase)", "true"],
      ],
      async (f) => {
        await step(f, "baseline");
        await step(f, "notice");
        return f.store.begin((await f.store.activeRun(durable(f)!.ownerHash)).runId, "baseline");
      },
    ],
  };
  it.each(Object.keys(guards))("the %s guard", async (name) => {
    const [replacements, hostile] = guards[name]!;
    await expect(hostile(createCaptureLifecycleFixture())).rejects.toThrow(CountCaptureStopped);
    const f = createCaptureLifecycleFixture();
    const createStore = guardDisabledMutant<typeof createCountCaptureStore>(
      "../read-model/count-capture-store.ts",
      replacements,
      "createCountCaptureStore",
      bindings,
    );
    const store = createStore(f.memory.pool, () => f.clock.now);
    const mutant = { ...f, store, lifecycle: createCountCaptureLifecycle({ ...f.deps, store }) };
    await expect(hostile(mutant)).resolves.toBeDefined();
  });
});
