import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { createOperationJournal, openConnectorDatabase } from "../integrations/connector-indexeddb";
import { parseOperationAttempt } from "../domain/operation-protocol";
import { coordinatorFixture } from "./coordinator-test-support";
import { pullFixture } from "./connector-order-pull-test-support";
import { openDatabase } from "./raw-retention-test-support";

async function seedV2() {
  const f = await coordinatorFixture();
  await f.coordinator().coordinate(f.input);
  const snapshot = await f.journal.read(f.input.connectionId);
  const indexedDB = new IDBFactory();
  const db = await openDatabase(indexedDB, 2, (db) => {
    db.createObjectStore("raw-exports", { keyPath: "rawExportId" }).createIndex("expiresAt", "expiresAt");
    const attempts = db.createObjectStore("operation-attempts", { keyPath: ["connectionId", "operationId"] });
    const reservations = db.createObjectStore("reservations", { keyPath: ["connectionId", "reservationId"] });
    snapshot.members.forEach((row) => attempts.add(row));
    snapshot.reservations.forEach((row) => reservations.add(row));
  });
  db.close();
  return { indexedDB, snapshot, connectionId: f.input.connectionId };
}

describe("connector-order-pull-journal-upgrade", () => {
  it("upgrades v2 twice without rewriting either existing journal store", async () => {
    const f = await seedV2();
    const journal = createOperationJournal(f.indexedDB, IDBKeyRange);
    for (let boot = 0; boot < 2; boot++) {
      expect(await journal.read(f.connectionId)).toEqual(f.snapshot);
      const db = await openConnectorDatabase(f.indexedDB);
      expect(db.version).toBe(3);
      expect([...db.objectStoreNames]).toEqual(["operation-attempts", "raw-exports", "reservations"]);
      db.close();
    }
  });
  it("aborting the v3 upgrade leaves v2 and every retained row byte-identical", async () => {
    const f = await seedV2();
    const open = f.indexedDB.open.bind(f.indexedDB);
    const spy = vi.spyOn(f.indexedDB, "open").mockImplementationOnce((...args) => {
      const request = open(...args);
      request.addEventListener("upgradeneeded", () => request.transaction!.abort());
      return request;
    });
    await expect(openConnectorDatabase(f.indexedDB)).rejects.toThrow("cleanup-failed");
    spy.mockRestore();
    const db = await openDatabase(f.indexedDB, 2);
    expect(db.version).toBe(2);
    db.close();
    expect(await createOperationJournal(f.indexedDB, IDBKeyRange).read(f.connectionId)).toEqual(f.snapshot);
  });
  it("refuses newer ownership without changing either store", async () => {
    const f = await seedV2();
    const db = await openDatabase(f.indexedDB, 4);
    db.close();
    await expect(createOperationJournal(f.indexedDB, IDBKeyRange).read(f.connectionId)).rejects.toThrow(
      "upgrade-required",
    );
    const owner = await openDatabase(f.indexedDB, 4);
    for (const [store, rows] of [
      ["operation-attempts", f.snapshot.members],
      ["reservations", f.snapshot.reservations],
    ] as const) {
      const values = await new Promise<unknown[]>((resolve, reject) => {
        const request = owner.transaction(store).objectStore(store).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      expect(values).toEqual(rows);
    }
    owner.close();
  });
  it.each(["sale-pii", "descriptor-pii", "progress-extra", "authority-extra", "date-only", "wrong-arm"])(
    "rejects %s before any stored effect",
    async (fault) => {
      const f = await pullFixture();
      f.dispatch.mockImplementation(async (_u, _s, pull) => {
        const handoff = structuredClone(f.handoff);
        if (fault === "sale-pii") {
          const post = handoff.bundles[0].posts![0];
          if (post.kind !== "sale") throw new Error("synthetic fixture drift");
          const value = JSON.parse(post.bytes);
          value.payload.records[0].shipTo = { name: "SYNTHETIC_PII_SENTINEL" };
          Object.assign(post, { bytes: JSON.stringify(value) });
        } else if (fault === "descriptor-pii")
          Object.assign(handoff.bundles[0].posts![0], { shipTo: "SYNTHETIC_PII_SENTINEL" });
        else if (fault === "progress-extra")
          Object.assign(handoff.progress.pages[0], { rawDetail: "SYNTHETIC_PII_SENTINEL" });
        else if (fault === "authority-extra")
          Object.assign(handoff.authority.selector, { session: "SYNTHETIC_PII_SENTINEL" });
        else if (fault === "date-only") Object.assign(handoff.usage, { providerNotBefore: "2026-10-09" });
        else Object.assign(handoff.bundles[0].posts![0], { kind: "raw-detail" });
        await expect(pull!.save(handoff)).rejects.toThrow();
        return pull!.result("completeness-unproven");
      });
      await f.coordinator().coordinate(f.input);
      expect(f.posts).toEqual([]);
      expect(JSON.stringify(await f.journal.read(f.input.connectionId))).not.toContain("SYNTHETIC_PII_SENTINEL");
      expect(f.reports.join()).not.toContain("SYNTHETIC_PII_SENTINEL");
    },
  );
  it("preserves the no-listing-sequence connection arm", async () => {
    const f = await pullFixture();
    await f.coordinator().coordinate(f.input);
    const member = (await f.journal.read(f.input.connectionId)).members[0];
    expect(member).not.toHaveProperty("desiredStateSequence");
    expect(() => parseOperationAttempt({ ...member, desiredStateSequence: 1 })).toThrow();
  });
});
