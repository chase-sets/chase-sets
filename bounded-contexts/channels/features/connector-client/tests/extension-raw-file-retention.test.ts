import { IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectorRetentionStore } from "../domain/connector-retention-store";
import { parseRawExport, rawExportLifetime } from "../domain/raw-export-record";
import { createRawExportDatabase } from "../integrations/raw-export-indexeddb";
import { openDatabase, retainedRows, retentionFixture } from "./raw-retention-test-support";

afterEach(() => vi.restoreAllMocks());

describe("extension-raw-file-retention", () => {
  it("stores only ciphertext, distinct session-only keys/nonces and authenticated metadata", async () => {
    const f = retentionFixture();
    await f.store.write(f.input());
    await f.store.write(f.input("raw_B"));
    const rows = (await retainedRows(f.indexedDB)).map((row) => parseRawExport(row));
    expect(await f.store.read("raw_A")).toEqual(f.input().bytes);
    expect(rows[0]!.keyId).not.toBe(rows[1]!.keyId);
    expect(rows[0]!.nonce).not.toEqual(rows[1]!.nonce);
    expect(new TextDecoder().decode(rows[0]!.ciphertext)).not.toContain("SYNTHETIC_RAW_CANARY_7922");
    expect(Object.keys(f.rows)).toHaveLength(2);
    expect(f.ports.scheduleDeadline).toHaveBeenLastCalledWith(f.now() + rawExportLifetime);
    const db = createRawExportDatabase(f.indexedDB, f.ports.keyRange);
    await db.change(rows[0]!, { ...rows[0]!, connectionId: "tampered" });
    await expect(f.store.read("raw_A")).rejects.toThrow();
  });

  it("recursively refuses unknown fields, malformed instants, sizes, versions and revisions", async () => {
    const f = retentionFixture();
    await f.store.write(f.input());
    const row = parseRawExport((await retainedRows(f.indexedDB))[0]);
    for (const patch of [
      { extra: true },
      { nonce: { bytes: row.nonce, extra: true } },
      { digest: { sha256: row.digest, extra: true } },
      { downloadedAt: "2026-10-08" },
      { downloadedAt: "2026-10-08T00:00:00+00:00" },
      { expiresAt: "2026-10-09" },
      { acceptedSnapshotAt: "2026-10-08" },
      { byteLength: 0 },
      { byteLength: 1025 },
      { revision: -1 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { schemaVersion: -1 },
      { schemaVersion: Number.MAX_SAFE_INTEGER + 1 },
    ])
      expect(() => parseRawExport({ ...row, ...patch }, 1024)).toThrow();
    await expect(f.store.write({ ...f.input("large"), maxBytes: 1 })).rejects.toThrow("write-refused");
    expect(await retainedRows(f.indexedDB)).toHaveLength(1);
  });

  it.each(["QuotaExceededError", "AbortError"])("%s leaves no partial record or orphan key", async (name) => {
    const f = retentionFixture();
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementationOnce(() => {
      throw new DOMException("synthetic", name);
    });
    await expect(f.store.write(f.input())).rejects.toThrow();
    expect(await retainedRows(f.indexedDB)).toEqual([]);
    expect(f.rows).toEqual({});
  });

  it("duplicate retries preserve the original key, downloadedAt and ciphertext", async () => {
    const f = retentionFixture();
    await f.store.write(f.input());
    const before = await retainedRows(f.indexedDB);
    const keys = structuredClone(f.rows);
    f.setNow(f.now() + 1000);
    await expect(f.store.write(f.input())).rejects.toThrow();
    expect(await retainedRows(f.indexedDB)).toEqual(before);
    expect(f.rows).toEqual(keys);
  });

  it("refuses at the deadline and a decrypt that crosses it, even before an alarm", async () => {
    const f = retentionFixture();
    await f.store.write(f.input());
    const deadline = f.now() + rawExportLifetime;
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "decrypt").mockImplementationOnce(async (...args) => {
      const bytes = await decrypt(...args);
      f.setNow(deadline);
      return bytes;
    });
    await expect(f.store.read("raw_A")).rejects.toThrow("read-refused");
    await expect(f.store.read("raw_A")).rejects.toThrow("read-refused");
    expect(await retainedRows(f.indexedDB)).toHaveLength(1);
    expect(Object.keys(f.rows)).toHaveLength(1);
    expect(await f.store.run({ reason: "retention", deleteAll: false })).toEqual({ ok: true, nextDeadline: null });
    expect(await retainedRows(f.indexedDB)).toEqual([]);
    expect(f.rows).toEqual({});
  });

  it("rechecks expiry after asynchronous key lookup before starting decryption", async () => {
    const f = retentionFixture();
    await f.store.write(f.input());
    const deadline = f.now() + rawExportLifetime;
    const decrypt = vi.spyOn(crypto.subtle, "decrypt");
    const get = f.session.get.getMockImplementation()!;
    f.session.get.mockImplementationOnce(async (keys) => {
      const values = await get(keys);
      f.setNow(deadline);
      return values;
    });
    await expect(f.store.read("raw_A")).rejects.toThrow("read-refused");
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("acceptance fences in-flight reads from another store instance", async () => {
    const f = retentionFixture();
    const second = createConnectorRetentionStore(f.ports);
    await f.store.write(f.input());
    const pending = second.read("raw_A");
    const acceptance = f.store.accept("raw_A");
    await expect(pending).rejects.toThrow("read-refused");
    await acceptance;
  });

  it("failed unpair key removal leaves no usable key across store recreation", async () => {
    const f = retentionFixture();
    await f.store.write(f.input());
    f.session.remove.mockRejectedValueOnce(new Error("synthetic-remove-failure"));
    expect(await f.store.run({ reason: "unpair", deleteAll: true })).toMatchObject({
      ok: false,
      error: "cleanup-failed",
    });
    expect(Object.values(f.rows)).toEqual([null]);
    await expect(createConnectorRetentionStore(f.ports).read("raw_A")).rejects.toThrow("read-refused");
    expect((await f.store.run({ reason: "boot", deleteAll: true })).ok).toBe(true);
    expect(f.rows).toEqual({});
  });

  it("acceptance and unpair delete immediately; missing session keys are swept after restart", async () => {
    for (const kind of ["accept", "unpair", "restart"] as const) {
      const f = retentionFixture();
      await f.store.write(f.input());
      if (kind === "accept") await f.store.accept("raw_A");
      else {
        if (kind === "restart") for (const key of Object.keys(f.rows)) delete f.rows[key];
        const restarted = createConnectorRetentionStore(f.ports);
        expect(
          (await restarted.run({ reason: kind === "unpair" ? "unpair" : "boot", deleteAll: kind === "unpair" })).ok,
        ).toBe(true);
      }
      expect(await retainedRows(f.indexedDB)).toEqual([]);
      expect(f.rows).toEqual({});
      await expect(f.store.read("raw_A")).rejects.toThrow();
    }
  });

  it("failed key cleanup retains an accepted terminal record and refuses reads the next day", async () => {
    const f = retentionFixture();
    await f.store.write(f.input());
    f.session.remove.mockRejectedValueOnce(new Error("synthetic-key-delete-failure"));
    await expect(f.store.accept("raw_A")).rejects.toThrow();
    const restarted = createConnectorRetentionStore(f.ports);
    await expect(restarted.read("raw_A")).rejects.toThrow("read-refused");
    f.session.remove.mockRejectedValueOnce(new Error("synthetic-key-delete-failure"));
    expect(await restarted.run({ reason: "boot", deleteAll: false })).toMatchObject({
      ok: false,
      error: "cleanup-failed",
    });
    f.setNow(f.now() + rawExportLifetime);
    expect((await restarted.run({ reason: "retention", deleteAll: false })).ok).toBe(true);
    expect(f.rows).toEqual({});
  });

  it("uses bounded pages and the deadline index and preserves a concurrent revision on delete", async () => {
    const f = retentionFixture();
    for (let i = 0; i < 65; i++) await f.store.write(f.input(`raw_${String(i).padStart(3, "0")}`));
    const database = createRawExportDatabase(f.indexedDB, f.ports.keyRange);
    const page = await database.page();
    expect(page).toHaveLength(32);
    const row = page[0]!;
    const replacement = { ...row, revision: 1, keyId: "connector-raw-key:replacement" };
    expect(await database.change(row, replacement)).toBe(true);
    expect(await database.change(row)).toBe(false);
    expect(await database.get(row.rawExportId)).toEqual(replacement);
    const index = vi.spyOn(IDBObjectStore.prototype, "index");
    f.setNow(f.now() + rawExportLifetime);
    expect((await f.store.run({ reason: "retention", deleteAll: false })).ok).toBe(true);
    expect(index).toHaveBeenCalledWith("expiresAt");
    expect(await retainedRows(f.indexedDB)).toEqual([]);
  });

  it("interleaved reads/write/unpair/alarm cannot return bytes after unpair", async () => {
    const f = retentionFixture();
    await f.store.write(f.input());
    const read = f.store.read("raw_A");
    const write = f.store.write(f.input("raw_B"));
    const unpair = f.store.run({ reason: "unpair", deleteAll: true });
    const alarm = f.store.run({ reason: "retention", deleteAll: false });
    await expect(read).rejects.toThrow("read-refused");
    await expect(write).rejects.toThrow("read-refused");
    expect((await unpair).ok).toBe(true);
    expect((await alarm).ok).toBe(true);
    expect(await retainedRows(f.indexedDB)).toEqual([]);
  });

  it("preserves a database whose owned raw store is missing", async () => {
    const f = retentionFixture();
    const blocker = await openDatabase(f.indexedDB, 1);
    // A missing store is unknown ownership, not permission to rebuild it.
    expect(await f.store.inspect()).toBe("upgrade-required");
    blocker.close();
  });
});
