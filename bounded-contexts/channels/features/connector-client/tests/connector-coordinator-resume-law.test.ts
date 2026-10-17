import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coordinatorFixture } from "./coordinator-test-support";

afterEach(() => vi.restoreAllMocks());
describe("connector-coordinator-resume-law", () => {
  it("atomically splits a prepared predecessor and retires it only at zero references", async () => {
    const f = await coordinatorFixture();
    const second = { ...f.claim.operations[0], operationId: "operation-2" };
    f.claims[0] = { ...f.claim, operations: [f.claim.operations[0], second] };
    f.prepare.mockRejectedValueOnce(new Error("synthetic-prepare-crash"));
    await f.coordinator().coordinate(f.input);
    f.setNow(Date.parse(f.claim.leaseExpiresAt) + 1);
    const redeliver = (id: string, operations: typeof f.claim.operations) => ({
      ...f.claim,
      reservationId: id,
      reservedAt: new Date(f.now()).toISOString(),
      leaseExpiresAt: new Date(f.now() + 1800000).toISOString(),
      operations,
    });
    f.claims.push(redeliver("reservation-2", [f.claim.operations[0]]));
    await f.coordinator().coordinate(f.input);
    let state = await f.journal.read(f.input.connectionId);
    expect(state.reservations.find((row) => row.reservationId === f.claim.reservationId)?.memberOperationIds).toEqual([
      "operation-2",
    ]);
    expect(state.members.find((row) => row.operationId === "operation-1")?.reservationId).toBe("reservation-2");
    f.claims.push(redeliver("reservation-3", [second]));
    await f.coordinator().coordinate(f.input);
    state = await f.journal.read(f.input.connectionId);
    expect(state.reservations.some((row) => row.reservationId === f.claim.reservationId)).toBe(false);
    expect(f.dispatchOnce).toHaveBeenCalledTimes(2);
  });
  it("adopts captured proof on redelivery without a second dispatch", async () => {
    const f = await coordinatorFixture();
    const original = IDBObjectStore.prototype.put;
    const abort = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
      this: IDBObjectStore,
      value,
      key,
    ) {
      const request = original.call(this, value, key);
      if (value.phase === "reported") this.transaction.abort();
      return request;
    });
    await f.coordinator().coordinate(f.input);
    expect((await f.journal.read(f.input.connectionId)).members[0].state).toBe("receipt-captured");
    abort.mockRestore();
    f.setNow(Date.parse(f.claim.leaseExpiresAt) + 1);
    f.claims.push({
      ...f.claim,
      reservationId: "reservation-2",
      reservedAt: new Date(f.now()).toISOString(),
      leaseExpiresAt: new Date(f.now() + 1800000).toISOString(),
      operations: [{ ...f.claim.operations[0], attemptId: "attempt-2", claimGeneration: 2 }],
    });
    await f.coordinator().coordinate(f.input);
    expect(f.dispatchOnce).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.reports[0])).toMatchObject({
      reservationId: "reservation-2",
      outcomes: [{ attemptId: "attempt-2", claimGeneration: 2 }],
    });
    expect((await f.journal.read(f.input.connectionId)).reservations.map((row) => row.reservationId)).toEqual([
      "reservation-2",
    ]);
  });
  it("acked redelivery preserves the existing rows byte-for-byte", async () => {
    const f = await coordinatorFixture();
    await f.coordinator().coordinate(f.input);
    const before = await f.journal.read(f.input.connectionId);
    f.claims.push({ ...f.claim, reservationId: "reservation-2" });
    expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "protocol-violation" });
    expect(await f.journal.read(f.input.connectionId)).toEqual(before);
    expect(f.dispatchOnce).toHaveBeenCalledTimes(1);
    expect(f.reports).toHaveLength(1);
  });
  it.each([0, 1, 2, 3, 4, 5])(
    "merges two predecessors atomically, including interruption at write %s",
    async (abortAt) => {
      const f = await coordinatorFixture();
      f.prepare.mockRejectedValueOnce(new Error("synthetic-stop"));
      await f.coordinator().coordinate(f.input);
      const first = await f.journal.read(f.input.connectionId);
      const secondMember = { ...first.members[0], operationId: "operation-2", reservationId: "reservation-old-2" };
      const before = await f.journal.change(f.input.connectionId, first, {
        members: [...first.members, secondMember],
        reservations: [
          ...first.reservations,
          {
            ...first.reservations[0],
            reservationId: secondMember.reservationId,
            memberOperationIds: [secondMember.operationId],
          },
        ],
      });
      f.setNow(Date.parse(f.claim.leaseExpiresAt) + 1);
      f.claims.push({
        ...f.claim,
        reservationId: "reservation-new",
        reservedAt: new Date(f.now()).toISOString(),
        leaseExpiresAt: new Date(f.now() + 1800000).toISOString(),
        operations: [f.claim.operations[0], { ...f.claim.operations[0], operationId: "operation-2" }],
      });
      let mutations = 0;
      const put = IDBObjectStore.prototype.put,
        remove = IDBObjectStore.prototype.delete;
      vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, ...args) {
        const request = put.apply(this, args);
        if (++mutations === abortAt) this.transaction.abort();
        return request;
      });
      vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementation(function (this: IDBObjectStore, ...args) {
        const request = remove.apply(this, args);
        if (++mutations === abortAt) this.transaction.abort();
        return request;
      });
      await f.coordinator().coordinate(f.input);
      const after = await f.journal.read(f.input.connectionId);
      if (abortAt) {
        expect(after).toEqual(before);
        expect(f.dispatchOnce).not.toHaveBeenCalled();
      } else {
        expect(after.reservations.map((row) => row.reservationId)).toEqual(["reservation-new"]);
        expect(f.dispatchOnce).toHaveBeenCalledTimes(2);
      }
    },
  );
});
