import { describe, expect, it, vi } from "vitest";
import { openDatabase, retainedRows, retentionFixture } from "./raw-retention-test-support";

describe("extension-raw-store-mixed-version", () => {
  it("preserves the newer raw record and pending effect through every entry; only its owner reconciles once", async () => {
    const f = retentionFixture();
    await f.store.write(f.input());
    const newer = await openDatabase(f.indexedDB, 2, (db, tx) => {
      db.createObjectStore("pending-operations", { keyPath: "id" }).add({
        id: "pending",
        effect: "SYNTHETIC_FIXED_EXTERNAL_EFFECT",
        reconciled: false,
      });
      const request = tx.objectStore("raw-exports").get("raw_A");
      request.onsuccess = () =>
        tx.objectStore("raw-exports").put({ ...request.result, schemaVersion: 2, ownerField: "v2" });
    });
    newer.close();
    const before = await retainedRows(f.indexedDB, 2);
    const keys = structuredClone(f.rows);
    const deleteDatabase = vi.spyOn(f.indexedDB, "deleteDatabase");
    for (const reason of ["boot", "work", "retention", "unpair"] as const) {
      expect(await f.store.inspect()).toBe("upgrade-required");
      expect(await f.store.run({ reason, deleteAll: true })).toMatchObject({ ok: false, error: "upgrade-required" });
      await expect(f.store.write(f.input("new"))).rejects.toThrow("upgrade-required");
      await expect(f.store.accept("raw_A")).rejects.toThrow("upgrade-required");
      expect(await retainedRows(f.indexedDB, 2)).toEqual(before);
      expect(f.rows).toEqual(keys);
    }
    expect(deleteDatabase).not.toHaveBeenCalled();
    const owner = await openDatabase(f.indexedDB, 3);
    let effects = 0;
    async function reconcile() {
      await new Promise<void>((resolve, reject) => {
        const tx = owner.transaction(["pending-operations", "raw-exports"], "readwrite");
        const pending = tx.objectStore("pending-operations");
        const request = pending.get("pending");
        request.onsuccess = () => {
          expect(request.result.effect).toBe("SYNTHETIC_FIXED_EXTERNAL_EFFECT");
          if (!request.result.reconciled) {
            effects++;
            pending.put({ ...request.result, reconciled: true });
          }
          tx.objectStore("raw-exports").delete("raw_A");
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    }
    await reconcile();
    await reconcile();
    owner.close();
    expect(effects).toBe(1);
    expect(await retainedRows(f.indexedDB, 3)).toEqual([]);
  });
});
