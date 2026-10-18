import { describe, expect, it, vi } from "vitest";
import { IDBObjectStore } from "fake-indexeddb";
import { createConnectorOperationCoordinator } from "../domain/operation-coordinator";
import { mutatedStagedImport } from "./coordinator-mutation-support";
import { floorFixture, validationRejectedResult } from "./staged-import-floor-test-support";

// File-serial: every case runs the real coordinate() and journal; run this file whole, never focused.
const refuseCall = "await stagedImport.refuseBeforeMutation();";
const finishInsteadOfRefuse = [refuseCall, "await stagedImport.finish();"] as const;
const trustResult = [refuseCall, ";"] as const;
const hop = () => new Request("https://synthetic-provider.invalid/hop", { redirect: "error" });

/** Two members (one composed, one already satisfied) whose executor returns the run law's validation refusal. */
async function refusal(sends: number, beforeReturn?: () => void) {
  const f = await floorFixture([1000, 1000], ["read", "mutation"]);
  const satisfied = { ...f.claim.operations[0]!, operationId: "operation-2", attemptId: "attempt-2" };
  f.claims[0] = { ...f.claim, operations: [...f.claim.operations, satisfied] };
  f.ports.executors = [
    {
      ...f.executor,
      dispatchOnce: async (unit, _signal, _pull, stagedImport) => {
        for (let index = 0; index < sends; index++) await stagedImport!.send(`synthetic-hop-${index}`, hop());
        beforeReturn?.();
        return validationRejectedResult(unit, f.settlement, new Set(["operation-2"]));
      },
    },
  ];
  return f;
}
async function phasesOf<T>(work: () => Promise<T>, fail?: (row: { phase?: string }) => boolean) {
  const phases: string[] = [];
  const put = IDBObjectStore.prototype.put;
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
    const row = args[0] as { phase?: string; executorKey?: string };
    if (row?.executorKey) {
      phases.push(String(row.phase));
      if (fail?.(row)) throw new Error("synthetic-kill-before-capture");
    }
    return put.apply(this, args);
  });
  try {
    return { result: await work(), phases };
  } finally {
    spy.mockRestore();
  }
}

describe("staged-import-pre-mutation-coordinator (file-serial, synthetic, no provider authority)", () => {
  it.each([false, true])(
    "a reads-only validation refusal reaches acked with its receipt; finish-instead-of-refuse=%s",
    async (bypass) => {
      const f = await refusal(1);
      const create = bypass
        ? mutatedStagedImport({ coordinator: [finishInsteadOfRefuse] }).createConnectorOperationCoordinator
        : createConnectorOperationCoordinator;
      const { result, phases } = await phasesOf(() => create(f.ports).coordinate(f.input));
      const journal = await f.journal.read(f.input.connectionId);
      expect(f.starts).toEqual([60000]);
      if (bypass) {
        expect(result).toEqual({ outcome: "unknown" });
        expect(journal.reservations[0]?.phase).toBe("outcome-unknown");
        expect(f.reports).toEqual([]);
        return;
      }
      expect(result).toEqual({ outcome: "ok", pollWindowSeconds: 60 });
      expect(phases).not.toContain("outcome-unknown");
      expect(phases.slice(-3)).toEqual(["receipt-captured", "reported", "acked"]);
      expect(journal.reservations[0]).toMatchObject({
        phase: "acked",
        stagedImport: { state: "released", requestIndex: 1, lastStart: 60000, lastCompletion: 61000 },
      });
      const expected = validationRejectedResult(
        { reservation: journal.reservations[0]!, members: journal.members },
        f.settlement,
        new Set(["operation-2"]),
      );
      expect(expected.outcomes.map((row) => row.outcome)).toEqual([
        { kind: "rejected", code: "validation" },
        { kind: "applied", result: { kind: "succeeded", externalListingId: "tcgplayer:11:synthetic-1:0:" } },
      ]);
      for (const member of journal.members)
        expect(member).toMatchObject({
          state: "acked",
          receipt: {
            outcomes: expected.outcomes.filter((row) => row.operationId === member.operationId),
            runSettlement: expected.runSettlement,
          },
        });
      expect(f.reports.map((body) => JSON.parse(body))).toEqual([
        { reservationId: "reservation-1", outcomes: expected.outcomes, runSettlement: expected.runSettlement },
      ]);
      for (const reason of ["boot", "update", "work", "unpair"] as const)
        await createConnectorOperationCoordinator(f.ports).coordinate({ ...f.input, reason });
      expect(f.starts).toEqual([60000]);
      expect(f.reports).toHaveLength(1);
    },
  );
  it.each([false, true])(
    "the same refusal after a mutation send is paused outcome-unknown; trust-result=%s",
    async (bypass) => {
      const f = await refusal(2);
      const create = bypass
        ? mutatedStagedImport({ coordinator: [trustResult] }).createConnectorOperationCoordinator
        : createConnectorOperationCoordinator;
      const { result } = await phasesOf(() => create(f.ports).coordinate(f.input));
      const journal = await f.journal.read(f.input.connectionId);
      expect(f.starts).toEqual([60000, 120000]);
      expect(journal.reservations[0]?.phase).toBe(bypass ? "acked" : "outcome-unknown");
      expect(f.reports).toHaveLength(bypass ? 1 : 0);
      if (bypass) return;
      expect(result).toEqual({ outcome: "unknown" });
      expect(journal.reservations[0]?.stagedImport).toMatchObject({ state: "completed", requestIndex: 2 });
      for (const member of journal.members)
        expect(member).toMatchObject({ state: "outcome-unknown", unknownReason: "unprovable-response" });
    },
  );
  it("a refused refuseBeforeMutation() (failed fence) is paused outcome-unknown", async () => {
    const f = await refusal(1, () => f.setAuthority("report-only"));
    expect(await createConnectorOperationCoordinator(f.ports).coordinate(f.input)).toEqual({ outcome: "unknown" });
    const journal = await f.journal.read(f.input.connectionId);
    expect(journal.reservations[0]).toMatchObject({
      phase: "outcome-unknown",
      stagedImport: { state: "completed", requestIndex: 1 },
    });
    expect(f.reports).toEqual([]);
    expect(f.starts).toEqual([60000]);
  });
  it("a kill before receipt capture stays dispatched and paused; nothing is inferred from released timing", async () => {
    const f = await refusal(1);
    const { result } = await phasesOf(
      () => createConnectorOperationCoordinator(f.ports).coordinate(f.input),
      (row) => row.phase === "receipt-captured",
    );
    expect(result).toEqual({ outcome: "unknown" });
    const killed = await f.journal.read(f.input.connectionId);
    expect(killed.reservations[0]).toMatchObject({
      phase: "dispatched",
      stagedImport: { state: "released", requestIndex: 1 },
    });
    expect(killed.members.map((member) => member.state)).toEqual(["dispatched", "dispatched"]);
    const reads = f.policyReads.length;
    for (const reason of ["boot", "update", "work", "unpair"] as const)
      await createConnectorOperationCoordinator(f.ports).coordinate({ ...f.input, reason });
    f.claims.push({
      ...f.claim,
      reservationId: "reservation-2",
      operations: f.claim.operations.map((row) => ({ ...row, operationId: "operation-3", attemptId: "attempt-3" })),
    });
    expect(await createConnectorOperationCoordinator(f.ports).coordinate(f.input)).toEqual({
      outcome: "unknown",
      refusal: "staged-import-outcome-unknown",
    });
    expect(await f.journal.read(f.input.connectionId)).toEqual(killed);
    expect(f.policyReads).toHaveLength(reads);
    expect(f.starts).toEqual([60000]);
    expect(f.reports).toEqual([]);
  });
});
