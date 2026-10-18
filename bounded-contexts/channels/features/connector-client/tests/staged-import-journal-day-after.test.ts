import { describe, expect, it, vi } from "vitest";
import { IDBObjectStore } from "fake-indexeddb";
import { createConnectorOperationCoordinator } from "../domain/operation-coordinator";
import type { ConnectorExecutor, OperationUnit } from "../domain/operation-protocol";
import { mutatedStagedImport } from "./coordinator-mutation-support";
import { floorFixture, validationRejectedResult } from "./staged-import-floor-test-support";

// File-serial: every row runs the real coordinate() and journal; run this file whole, never focused.
const rows = ["acked", "reported", "outcome-unknown", "intent", "dispatched", "prepared"] as const;
const reasons = ["boot", "update", "work", "unpair"] as const;
type Row = (typeof rows)[number];
const paused = (row: Row) => row === "outcome-unknown" || row === "intent" || row === "dispatched";
const sweepFilter = 'row.phase === "acked" && ports.clock.now() >= Date.parse(row.ackedAt!) + 86400000';
const sweepPausedUnit = [
  sweepFilter,
  "ports.clock.now() >= Date.parse(row.ackedAt ?? row.reservedAt) + 86400000",
] as const;
const journalDeleteGuard = ['(row.phase !== "acked" || row.stagedImport.state !== "released")', "false"] as const;
const reconcileUnrouted = [
  "if (!reservation.stagedImport || !executors.get(reservation.executorKey)?.reconcileAmbiguous) return undefined;",
  "return undefined;",
] as const;
const reconcileUnreleasable = ["assertStagedImportTimingTransition(reservation.stagedImport, released);", ""] as const;
const hop = () => new Request("https://synthetic-provider.invalid/hop", { redirect: "error" });

async function fixture(durations = [1000, 1000]) {
  const f = await floorFixture(durations, (["read", "mutation"] as const).slice(0, durations.length));
  const reports: string[] = [];
  const failures = { report: false, overrun: false };
  const request = f.ports.request;
  f.ports.request = async (req) => {
    if (req.url.endsWith("/report")) {
      reports.push(await req.clone().text());
      if (failures.report) return new Response(null, { status: 500 });
    }
    const response = await request(req);
    if (failures.overrun && req.url.startsWith("https://synthetic-provider.invalid")) f.advance(1);
    return response;
  };
  const claim = (id: string) => ({
    ...f.claim,
    reservationId: `reservation-${id}`,
    reservedAt: new Date(f.now()).toISOString(),
    leaseExpiresAt: new Date(f.now() + 1800000).toISOString(),
    operations: f.claim.operations.map((row) => ({
      ...row,
      operationId: `operation-${id}`,
      attemptId: `attempt-${id}`,
    })),
  });
  return { ...f, reports, failures, claim, base: f.executor };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function withExecutor(f: Fixture, patch: Partial<ConnectorExecutor>) {
  f.ports.executors = [{ ...f.base, ...patch }];
}
function noCommitProof(f: Fixture) {
  return vi.fn(async (unit: OperationUnit) => ({
    outcomes: unit.members.map((member) => {
      if (!("desiredStateSequence" in member)) throw new Error("synthetic-listing-only");
      return {
        operationId: member.operationId,
        attemptId: member.attemptId,
        claimGeneration: member.claimGeneration,
        desiredStateSequence: member.desiredStateSequence,
        outcome: { kind: "abandoned" as const, reason: "released" as const },
      };
    }),
    runSettlement: { ...f.settlement, toState: "abandoned" as const },
  }));
}

/** Drives one real reservation into the named #7939 row, then restores the plain executor for the wakes. */
async function at(row: Row) {
  const f = await fixture();
  if (row === "reported") f.failures.report = true;
  if (row === "intent") f.failures.overrun = true;
  if (row === "prepared") withExecutor(f, { prepare: async () => ({ ready: true }) });
  if (row === "outcome-unknown")
    withExecutor(f, {
      dispatchOnce: async (_unit, _signal, _pull, stagedImport) => {
        await stagedImport!.send("synthetic-hop-0", hop());
        await stagedImport!.send("synthetic-hop-1", hop());
        throw new Error("synthetic-loss-after-mutation");
      },
    });
  if (row === "dispatched")
    withExecutor(f, {
      dispatchOnce: async (unit, _signal, _pull, stagedImport) => {
        await stagedImport!.send("synthetic-hop-0", hop());
        return validationRejectedResult(unit, f.settlement);
      },
    });
  const put = IDBObjectStore.prototype.put;
  const kill = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    const value = args[0] as { executorKey?: string; phase?: string };
    if (row === "dispatched" && value?.executorKey && value.phase === "receipt-captured")
      throw new Error("synthetic-kill-before-capture");
    return put.apply(this, args);
  });
  try {
    await createConnectorOperationCoordinator(f.ports).coordinate(f.input);
  } finally {
    kill.mockRestore();
  }
  f.failures.overrun = false;
  withExecutor(f, {});
  const journal = await f.journal.read(f.input.connectionId);
  const timing = {
    acked: { phase: "acked", state: "released", requestIndex: 2 },
    reported: { phase: "reported", state: "released", requestIndex: 2 },
    "outcome-unknown": { phase: "outcome-unknown", state: "completed", requestIndex: 2 },
    intent: { phase: "outcome-unknown", state: "intent", requestIndex: 0 },
    dispatched: { phase: "dispatched", state: "released", requestIndex: 1 },
    prepared: { phase: "prepared" },
  }[row];
  expect(journal.reservations).toHaveLength(1);
  expect({ phase: journal.reservations[0]!.phase, ...journal.reservations[0]!.stagedImport }).toMatchObject(timing);
  if (row === "prepared") expect(journal.reservations[0]!.stagedImport).toBeUndefined();
  return f;
}
async function wake(
  f: Fixture,
  reason: (typeof reasons)[number] = "work",
  create = createConnectorOperationCoordinator,
) {
  const before = { reads: f.policyReads.length, starts: f.starts.length, reports: f.reports.length };
  const result = await create(f.ports).coordinate({ ...f.input, reason });
  return {
    result,
    reads: f.policyReads.length - before.reads,
    starts: f.starts.length - before.starts,
    reports: f.reports.slice(before.reports),
    journal: await f.journal.read(f.input.connectionId),
  };
}

describe("staged-import-journal-day-after (file-serial, synthetic, no provider authority)", () => {
  it.each(rows.flatMap((row) => reasons.map((reason) => [row, reason] as const)))(
    "%s: the next %s wake does only that row's action",
    async (row, reason) => {
      const f = await at(row);
      const before = await f.journal.read(f.input.connectionId);
      const first = f.reports[0];
      const prepare = vi.spyOn(f.base, "prepare");
      withExecutor(f, {});
      if (paused(row)) f.claims.push(f.claim("newer"));
      const next = await wake(f, reason);
      if (row === "acked") {
        expect(next.result).toEqual(reason === "unpair" ? { outcome: "ok" } : { outcome: "ok", pollWindowSeconds: 60 });
        expect(next.journal).toEqual(before);
        expect(next.reports).toEqual([]);
      } else if (row === "reported") {
        // Unpair reports first; every wake resends the byte-identical envelope and nothing else.
        expect(next.result.outcome).toBe("unknown");
        expect(next.reports).toEqual([first]);
        expect(next.journal.reservations[0]).toMatchObject({
          phase: "reported",
          reportEnvelope: before.reservations[0]!.reportEnvelope,
          stagedImport: before.reservations[0]!.stagedImport,
        });
      } else if (paused(row)) {
        expect(next.result).toEqual(
          reason === "unpair"
            ? { outcome: "unknown" }
            : { outcome: "unknown", refusal: "staged-import-outcome-unknown" },
        );
        expect(next.journal).toEqual(before);
        expect(next.reports).toEqual([]);
      } else if (reason === "unpair") {
        expect(next.result).toEqual({ outcome: "unknown" });
        expect(next.journal).toEqual(before);
        expect(prepare).not.toHaveBeenCalled();
      } else {
        // `prepared` resumes at prepare with nothing sent before it.
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(next.result).toEqual({ outcome: "ok", pollWindowSeconds: 60 });
        expect(next.journal.reservations[0]).toMatchObject({ phase: "acked", stagedImport: { state: "released" } });
        expect(next.starts).toBe(2);
      }
      if (row !== "prepared" || reason === "unpair") expect([next.reads, next.starts]).toEqual([0, 0]);
    },
  );
  it("acked is inert until 24 h after ack, then swept at most 32 per wake", async () => {
    const f = await fixture([1000]);
    f.claims.length = 0;
    const coordinator = createConnectorOperationCoordinator(f.ports);
    for (let batch = 0; batch < 5; batch++) {
      for (let index = 0; index < Math.min(8, 33 - batch * 8); index++) f.claims.push(f.claim(`${batch}-${index}`));
      await coordinator.coordinate(f.input);
    }
    const acked = await f.journal.read(f.input.connectionId);
    expect(acked.reservations).toHaveLength(33);
    expect(acked.reservations.every((row) => row.phase === "acked" && row.stagedImport?.state === "released")).toBe(
      true,
    );
    const times = acked.reservations.map((row) => Date.parse(row.ackedAt!));
    f.advance(Math.min(...times) + 86400000 - 1 - f.now());
    const early = await wake(f);
    expect(early.journal).toEqual(acked);
    f.advance(Math.max(...times) + 86400000 - f.now());
    expect((await wake(f)).journal.reservations).toHaveLength(1);
    const last = await wake(f);
    expect(last.journal).toEqual({ members: [], reservations: [] });
    expect([early.reads, early.starts, last.reads, last.starts]).toEqual([0, 0, 0, 0]);
  });
  it.each(["none", "coordinator", "coordinator+journal"] as const)(
    "a paused unit is never swept, even a day later; sweep-paused-unit bypass=%s",
    async (bypass) => {
      const f = await at("outcome-unknown");
      const before = await f.journal.read(f.input.connectionId);
      f.advance(86400000 * 2);
      f.claims.push(f.claim("newer"));
      const create =
        bypass === "none"
          ? createConnectorOperationCoordinator
          : mutatedStagedImport({
              coordinator: [sweepPausedUnit],
              journal: bypass === "coordinator+journal" ? [journalDeleteGuard] : [],
            }).createConnectorOperationCoordinator;
      const next = await wake(f, "work", create);
      if (bypass === "none") {
        expect(next.result).toEqual({ outcome: "unknown", refusal: "staged-import-outcome-unknown" });
        expect(next.journal).toEqual(before);
        expect([next.reads, next.starts]).toEqual([0, 0]);
      } else if (bypass === "coordinator") {
        // The journal's delete guard still holds, but the wedged sweep loses the paused refusal.
        expect(next.result).toEqual({ outcome: "unknown" });
        expect(next.journal).toEqual(before);
      } else {
        // With both layers bypassed the paused unit is erased and a newer reservation replays the provider.
        expect(next.journal.reservations.map((row) => row.reservationId)).toEqual(["reservation-newer"]);
        expect(next.starts).toBe(2);
      }
    },
  );
  it.each(["outcome-unknown", "dispatched"] as const)(
    "a paused %s unit reaches a defined reconcileAmbiguous, and its exact proof acks with released timing",
    async (row) => {
      for (const bypass of [false, true]) {
        const f = await at(row);
        const reconcile = noCommitProof(f);
        withExecutor(f, { reconcileAmbiguous: reconcile });
        const create = bypass
          ? mutatedStagedImport({ coordinator: [reconcileUnrouted] }).createConnectorOperationCoordinator
          : createConnectorOperationCoordinator;
        const next = await wake(f, "work", create);
        expect(reconcile).toHaveBeenCalledTimes(bypass ? 0 : 1);
        expect([next.reads, next.starts]).toEqual([0, 0]);
        if (bypass) {
          expect(next.journal.reservations[0]?.phase).toBe(row);
          continue;
        }
        const stagedImport = next.journal.reservations[0]!.stagedImport;
        expect(next.journal.reservations[0]).toMatchObject({ phase: "acked", stagedImport: { state: "released" } });
        expect(stagedImport?.requestIndex).toBe(row === "dispatched" ? 1 : 2);
        expect(JSON.parse(next.reports[0]!)).toMatchObject({ runSettlement: { toState: "abandoned" } });
        f.advance(86400000);
        expect((await wake(f)).journal).toEqual({ members: [], reservations: [] });
      }
    },
  );
  it("without reconcileAmbiguous, or when it finds no proof, a paused unit stays paused and sends nothing", async () => {
    const f = await at("outcome-unknown");
    const before = await f.journal.read(f.input.connectionId);
    const undefinedRoute = await wake(f);
    expect(undefinedRoute.journal).toEqual(before);
    const reconcile = vi.fn(async () => null);
    withExecutor(f, { reconcileAmbiguous: reconcile });
    f.claims.push(f.claim("newer"));
    const noProof = await wake(f);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(noProof.result).toEqual({ outcome: "unknown", refusal: "staged-import-outcome-unknown" });
    expect(noProof.journal.reservations[0]).toMatchObject({
      phase: "outcome-unknown",
      stagedImport: { state: "completed" },
    });
    expect([undefinedRoute.reads, undefinedRoute.starts, noProof.reads, noProof.starts]).toEqual([0, 0, 0, 0]);
    expect(noProof.reports).toEqual([]);
  });
  it.each([false, true])(
    "an unreleasable intent timing never reaches reconcileAmbiguous; reconcile-unreleasable bypass=%s",
    async (bypass) => {
      const f = await at("intent");
      const before = await f.journal.read(f.input.connectionId);
      const reconcile = noCommitProof(f);
      withExecutor(f, { reconcileAmbiguous: reconcile });
      const create = bypass
        ? mutatedStagedImport({ coordinator: [reconcileUnreleasable] }).createConnectorOperationCoordinator
        : createConnectorOperationCoordinator;
      const next = await wake(f, "work", create);
      expect(reconcile).toHaveBeenCalledTimes(bypass ? 1 : 0);
      expect(next.journal.reservations[0]?.stagedImport?.state).toBe("intent");
      expect(next.reports).toEqual([]);
      expect([next.reads, next.starts]).toEqual([0, 0]);
      if (!bypass) expect(next.journal).toEqual(before);
    },
  );
});
