import { describe, expect, it, vi } from "vitest";
import { parseRawExport } from "../domain/raw-export-record";
import { openDatabase, retainedRows, retentionFixture } from "./raw-retention-test-support";

describe("extension-raw-store-mixed-version", () => {
  it("preserves the newer raw record and pending effect through every entry; only its owner reconciles once", async () => {
    const f = retentionFixture();
    await f.store.write(f.input());
    const original = parseRawExport((await retainedRows(f.indexedDB))[0]);
    const { ciphertext: _ciphertext, ...metadata } = original;
    const newerMetadata = {
      ...metadata,
      schemaVersion: 2,
      ownerField: "SYNTHETIC_V2_OWNER",
      keyId: "connector-raw-key:SYNTHETIC_V2_OWNER",
      nonce: crypto.getRandomValues(new Uint8Array(12)),
    };
    const additionalData = new TextEncoder().encode(JSON.stringify(newerMetadata));
    const ownerMaterial = crypto.getRandomValues(new Uint8Array(32));
    f.rows[newerMetadata.keyId] = Array.from(ownerMaterial);
    const ownerKey = await crypto.subtle.importKey("raw", ownerMaterial, "AES-GCM", false, ["encrypt", "decrypt"]);
    const newerRecord = {
      ...newerMetadata,
      ciphertext: await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: newerMetadata.nonce, additionalData },
        ownerKey,
        new Uint8Array(f.input().bytes),
      ),
    };
    const newer = await openDatabase(f.indexedDB, 2, (db, tx) => {
      db.createObjectStore("pending-operations", { keyPath: "id" }).add({
        id: "pending",
        effect: "SYNTHETIC_FIXED_EXTERNAL_EFFECT",
        reconciled: false,
      });
      tx.objectStore("raw-exports").put(newerRecord);
    });
    newer.close();
    delete f.rows[original.keyId];
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
    const preserved = (await retainedRows(f.indexedDB, 2))[0] as typeof newerRecord;
    expect(preserved).toEqual(newerRecord);
    expect(
      new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: preserved.nonce, additionalData },
          ownerKey,
          preserved.ciphertext,
        ),
      ),
    ).toEqual(f.input().bytes);
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
    await f.session.remove([newerMetadata.keyId]);
    expect(effects).toBe(1);
    expect(await retainedRows(f.indexedDB, 3)).toEqual([]);
    expect(f.rows).toEqual({});
  });
});
