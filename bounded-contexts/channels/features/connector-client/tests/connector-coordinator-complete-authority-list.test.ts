import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coordinatorFixture } from "./coordinator-test-support";
import { openConnectorDatabase } from "../integrations/connector-indexeddb";

afterEach(() => vi.restoreAllMocks());
describe("connector-coordinator-complete-authority-list", () => {
  it.each(["orphan-member", "orphan-reservation", "wrong-identity", "unsafe-revision"])(
    "%s retained authority prevents claims and provider calls",
    async (fault) => {
      const f = await coordinatorFixture();
      f.prepare.mockRejectedValue(new Error("synthetic-stop"));
      await f.coordinator().coordinate(f.input);
      const retained = await f.journal.read(f.input.connectionId);
      const db = await openConnectorDatabase(f.indexedDB);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(["operation-attempts", "reservations"], "readwrite");
        if (fault === "orphan-member")
          tx.objectStore("reservations").delete([f.input.connectionId, f.claim.reservationId]);
        if (fault === "orphan-reservation")
          tx.objectStore("operation-attempts").delete([f.input.connectionId, f.claim.operations[0].operationId]);
        if (fault === "wrong-identity")
          tx.objectStore("reservations").put({ ...retained.reservations[0], memberOperationIds: ["missing-member"] });
        if (fault === "unsafe-revision")
          tx.objectStore("operation-attempts").put({ ...retained.members[0], revision: Number.MAX_SAFE_INTEGER + 1 });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      f.request.mockClear();
      f.prepare.mockClear();
      expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "unknown" });
      expect(f.request).not.toHaveBeenCalled();
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.dispatchOnce).not.toHaveBeenCalled();
    },
  );
  it.each([1, 4097])("independent count %s cannot be substituted by an apparently empty cursor", async (count) => {
    const f = await coordinatorFixture();
    const original = IDBObjectStore.prototype.count;
    vi.spyOn(IDBObjectStore.prototype, "count").mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = original.apply(this, args);
      request.addEventListener("success", () => Object.defineProperty(request, "result", { value: count }));
      return request;
    });
    expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "unknown" });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.dispatchOnce).not.toHaveBeenCalled();
  });
  it("absent authority never claims", async () => {
    const f = await coordinatorFixture();
    f.setAuthority("absent");
    expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "unknown" });
    expect(f.request).not.toHaveBeenCalled();
  });
  it("a complete cap-plus-one retained corpus fails closed before claims", async () => {
    const f = await coordinatorFixture();
    f.prepare.mockRejectedValueOnce(new Error("synthetic-stop"));
    await f.coordinator().coordinate(f.input);
    const retained = await f.journal.read(f.input.connectionId);
    const db = await openConnectorDatabase(f.indexedDB);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["operation-attempts", "reservations"], "readwrite");
      for (let index = 1; index <= 4096; index++) {
        const operationId = `synthetic-extra-${index}`,
          reservationId = `synthetic-reservation-${index}`;
        tx.objectStore("operation-attempts").put({ ...retained.members[0], operationId, reservationId });
        tx.objectStore("reservations").put({
          ...retained.reservations[0],
          reservationId,
          memberOperationIds: [operationId],
        });
      }
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    f.request.mockClear();
    expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "unknown" });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.dispatchOnce).not.toHaveBeenCalled();
  });
  it("an unsafe non-increasing cursor is not complete authority", async () => {
    const f = await coordinatorFixture();
    f.claims[0] = {
      ...f.claim,
      operations: [f.claim.operations[0], { ...f.claim.operations[0], operationId: "operation-2" }],
    };
    f.prepare.mockRejectedValueOnce(new Error("synthetic-stop"));
    await f.coordinator().coordinate(f.input);
    vi.spyOn(f.indexedDB, "cmp").mockReturnValue(0);
    f.request.mockClear();
    expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "unknown" });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.dispatchOnce).not.toHaveBeenCalled();
  });
  it("valid unsupported operations are journaled and totally abandoned, not integrity refusals", async () => {
    const f = await coordinatorFixture();
    f.ports.executors.length = 0;
    expect(await f.coordinator().coordinate(f.input)).toEqual({ outcome: "unsupported-operation" });
    expect(f.dispatchOnce).not.toHaveBeenCalled();
    expect((await f.journal.read(f.input.connectionId)).reservations[0].reportEnvelope?.outcomes[0].outcome).toEqual({
      kind: "abandoned",
      reason: "claimant-cancelled",
    });
  });
});
