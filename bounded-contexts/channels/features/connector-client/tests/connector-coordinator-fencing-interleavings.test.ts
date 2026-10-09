import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coordinatorFixture } from "./coordinator-test-support";

afterEach(() => vi.restoreAllMocks());
describe("connector-coordinator-fencing-interleavings", () => {
  it.each(["pause", "unpair", "deadline"] as const)(
    "preserves captured success when a prepared sibling is cancelled by %s",
    async (cause) => {
      const f = await coordinatorFixture();
      f.claims[0] = {
        ...f.claim,
        operations: [f.claim.operations[0], { ...f.claim.operations[0], operationId: "operation-2" }],
      };
      f.dispatchOnce.mockImplementation(async (work) => {
        if (cause === "deadline") f.setNow(Date.parse(f.claim.leaseExpiresAt) - 30000);
        else f.setAuthority("report-only");
        return f.result(work);
      });
      await f.coordinator().coordinate(f.input);
      const interrupted = await f.journal.read(f.input.connectionId);
      expect(interrupted.members.map((member) => member.state)).toEqual(["receipt-captured", "prepared"]);
      expect(f.dispatchOnce).toHaveBeenCalledTimes(1);
      // Exercise unpair independently of the report-only authority control.
      if (cause === "unpair") f.setAuthority("paired-idle");
      await f.coordinator().coordinate(cause === "unpair" ? { ...f.input, reason: "unpair" } : f.input);
      const retained = await f.journal.read(f.input.connectionId);
      const expected = [
        interrupted.members[0].receipt!.outcomes[0],
        {
          operationId: "operation-2",
          attemptId: "attempt-1",
          claimGeneration: 1,
          desiredStateSequence: 1,
          outcome: { kind: "abandoned", reason: "claimant-cancelled" },
        },
      ];
      expect(JSON.parse(f.reports[0]).outcomes).toEqual(expected);
      expect(retained.reservations[0].reportEnvelope!.outcomes).toEqual(expected);
      expect(retained.reservations[0].phase).toBe("acked");
      expect(retained.members.map((member) => member.state)).toEqual(["acked", "acked"]);
      expect(f.dispatchOnce).toHaveBeenCalledTimes(1);
    },
  );
  it("two workers reading the same prepared revision have one dispatch winner", async () => {
    const f = await coordinatorFixture();
    f.prepare.mockRejectedValueOnce(new Error("synthetic-pre-dispatch-crash"));
    await f.coordinator().coordinate(f.input);
    expect((await f.journal.read(f.input.connectionId)).members[0].state).toBe("prepared");
    let waiting = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.prepare.mockImplementation(async () => {
      if (++waiting === 2) release();
      await barrier;
      return { ready: true };
    });
    await Promise.all([f.coordinator().coordinate(f.input), f.coordinator().coordinate(f.input)]);
    expect(f.dispatchOnce).toHaveBeenCalledTimes(1);
    expect((await f.journal.read(f.input.connectionId)).members[0].state).toBe("acked");
  });
  it.each(["response", 1, 2, 3] as const)(
    "mixed cancellation with settlement retries identical bytes after report/ack loss at %s",
    async (fault) => {
      const f = await coordinatorFixture();
      f.claims[0] = {
        ...f.claim,
        operations: [f.claim.operations[0], { ...f.claim.operations[0], operationId: "operation-2" }],
      };
      f.dispatchOnce.mockImplementation(async (work) => {
        f.setAuthority("report-only");
        return { ...f.result(work), runSettlement: f.settlement };
      });
      await f.coordinator().coordinate(f.input);
      expect((await f.journal.read(f.input.connectionId)).members.map((member) => member.state)).toEqual([
        "receipt-captured",
        "prepared",
      ]);
      let writes = 0;
      const original = IDBObjectStore.prototype.put;
      const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
        this: IDBObjectStore,
        value,
        key,
      ) {
        const request = original.call(this, value, key);
        if ((value.state === "acked" || value.phase === "acked") && ++writes === fault) this.transaction.abort();
        return request;
      });
      if (fault === "response")
        f.request.mockImplementationOnce(async (request) => {
          f.reports.push(await request.text());
          throw new Error("synthetic-report-response-loss");
        });
      try {
        expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "unknown" });
        const retained = await f.journal.read(f.input.connectionId);
        expect(retained.members.map((member) => member.state)).toEqual(["reported", "reported"]);
        expect(retained.reservations[0].reportEnvelope!.runSettlement).toEqual(f.settlement);
        expect(retained.reservations[0].reportEnvelope!.outcomes.map((item) => item.outcome.kind)).toEqual([
          "applied",
          "abandoned",
        ]);
      } finally {
        spy.mockRestore();
      }
      await f.coordinator().coordinate(f.input);
      expect(f.dispatchOnce).toHaveBeenCalledTimes(1);
      expect(f.reports).toHaveLength(2);
      expect(f.reports[0]).toBe(f.reports[1]);
      expect((await f.journal.read(f.input.connectionId)).members.map((member) => member.state)).toEqual([
        "acked",
        "acked",
      ]);
    },
  );
  it("mixed cancellation with conflicting retained settlements stays unknown without changing evidence", async () => {
    const f = await coordinatorFixture();
    f.claims[0] = {
      ...f.claim,
      operations: [1, 2, 3].map((id) => ({ ...f.claim.operations[0], operationId: `operation-${id}` })),
    };
    f.dispatchOnce.mockImplementation(async (work) => {
      if (work.members[0].operationId === "operation-2") f.setAuthority("report-only");
      return {
        ...f.result(work),
        runSettlement: { ...f.settlement, runId: `synthetic-${work.members[0].operationId}` },
      };
    });
    await f.coordinator().coordinate(f.input);
    const interrupted = await f.journal.read(f.input.connectionId);
    expect(interrupted.members.map((member) => member.state)).toEqual([
      "receipt-captured",
      "receipt-captured",
      "prepared",
    ]);
    expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "unknown" });
    expect(await f.journal.read(f.input.connectionId)).toEqual(interrupted);
    expect(f.reports).toEqual([]);
    expect(f.dispatchOnce).toHaveBeenCalledTimes(2);
  });
  it("a stale receipt cannot overwrite a newer journal revision", async () => {
    const f = await coordinatorFixture();
    f.dispatchOnce.mockImplementation(async (work) => {
      const retained = await f.journal.read(f.input.connectionId);
      await f.journal.change(f.input.connectionId, retained, {
        ...retained,
        reservations: retained.reservations.map((row) => ({
          ...row,
          revision: row.revision + 1,
          lastRefusal: "transport",
        })),
      });
      return f.result(work);
    });
    expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "unknown" });
    const retained = await f.journal.read(f.input.connectionId);
    expect(retained.members[0].state).toBe("dispatched");
    expect(retained.reservations[0].lastRefusal).toBe("transport");
    expect(f.reports).toEqual([]);
  });
  it.each([1, 2, 3])("aborting intent write %s rolls both stores back and calls no executor", async (abortAt) => {
    const f = await coordinatorFixture("reservation");
    f.claims[0] = {
      ...f.claim,
      operations: [f.claim.operations[0], { ...f.claim.operations[0], operationId: "operation-2" }],
    };
    let puts = 0;
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = original.call(this, value, key);
      if ((value.state === "dispatched" || value.phase === "dispatched") && ++puts === abortAt)
        this.transaction.abort();
      return request;
    });
    expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "unknown" });
    const retained = await f.journal.read(f.input.connectionId);
    expect(retained.members.map((row) => row.state)).toEqual(["prepared", "prepared"]);
    expect(retained.reservations[0].phase).toBe("prepared");
    expect(f.dispatchOnce).not.toHaveBeenCalled();
  });
  it.each(["lease", "pause", "revoke"])("%s after prepare prevents dispatch", async (fault) => {
    const f = await coordinatorFixture();
    f.prepare.mockImplementation(async () => {
      if (fault === "lease") f.setNow(Date.parse(f.claim.leaseExpiresAt));
      else f.setAuthority(fault === "pause" ? "report-only" : "absent");
      return { ready: true };
    });
    await f.coordinator().coordinate(f.input);
    expect(f.dispatchOnce).not.toHaveBeenCalled();
    expect((await f.journal.read(f.input.connectionId)).members[0].state).toBe("prepared");
  });
  it.each([1, 2, 3])(
    "capture abort at member/reservation write %s retains the entire unit as dispatched",
    async (abortAt) => {
      const f = await coordinatorFixture("reservation");
      f.claims[0] = {
        ...f.claim,
        operations: [f.claim.operations[0], { ...f.claim.operations[0], operationId: "operation-2" }],
      };
      let captured = 0;
      const put = IDBObjectStore.prototype.put;
      vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
        const request = put.apply(this, args);
        if ((args[0].phase === "receipt-captured" || args[0].state === "receipt-captured") && ++captured === abortAt)
          this.transaction.abort();
        return request;
      });
      await f.coordinator().coordinate(f.input);
      const retained = await f.journal.read(f.input.connectionId);
      expect(retained.members.map((member) => member.state)).toEqual(["dispatched", "dispatched"]);
      expect(retained.reservations[0].phase).toBe("dispatched");
      expect(f.dispatchOnce).toHaveBeenCalledTimes(1);
      expect(f.reports).toEqual([]);
    },
  );
});
