import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coordinatorFixture } from "./coordinator-test-support";

afterEach(() => vi.restoreAllMocks());
describe("connector-coordinator-fencing-interleavings", () => {
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
});
