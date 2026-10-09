import { IDBDatabase, IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, retainedRows, retentionFixture } from "./raw-retention-test-support";
import { openConnectorDatabase } from "../integrations/connector-indexeddb";
import { createOperationJournal } from "../integrations/operation-indexeddb";
import { coordinatorFixture } from "./coordinator-test-support";
import { backgroundFixture } from "./connector-background-test-support";

afterEach(() => vi.restoreAllMocks());
describe("connector-coordinator-migration-and-day-after", () => {
  it("upgrades v1 additively once and retains its raw-export marker", async () => {
    const seed = retentionFixture();
    await seed.store.write(seed.input());
    const [raw] = await retainedRows(seed.indexedDB);
    const indexedDB = new IDBFactory();
    const old = await openDatabase(indexedDB, 1, (db) => {
      const store = db.createObjectStore("raw-exports", { keyPath: "rawExportId" });
      store.createIndex("expiresAt", "expiresAt");
      store.add(raw);
    });
    old.close();
    for (let boot = 0; boot < 2; boot++) {
      const db = await openConnectorDatabase(indexedDB);
      expect(db.version).toBe(2);
      expect([...db.objectStoreNames]).toEqual(["operation-attempts", "raw-exports", "reservations"]);
      db.close();
      expect(await createOperationJournal(indexedDB, IDBKeyRange).read("connection-1")).toEqual({
        members: [],
        reservations: [],
      });
      expect(await retainedRows(indexedDB)).toEqual([raw]);
    }
  });
  it("aborted additive migration preserves the original version and store", async () => {
    const indexedDB = new IDBFactory();
    const old = await openDatabase(indexedDB, 1, (db) => {
      db.createObjectStore("raw-exports", { keyPath: "rawExportId" }).createIndex("expiresAt", "expiresAt");
    });
    old.close();
    const create = IDBDatabase.prototype.createObjectStore;
    const spy = vi.spyOn(IDBDatabase.prototype, "createObjectStore").mockImplementation(function (
      this: IDBDatabase,
      ...args
    ) {
      const store = create.apply(this, args);
      if (args[0] === "reservations") store.transaction.abort();
      return store;
    });
    await expect(openConnectorDatabase(indexedDB)).rejects.toThrow("cleanup-failed");
    spy.mockRestore();
    const retained = await openDatabase(indexedDB, 1);
    expect([...retained.objectStoreNames]).toEqual(["raw-exports"]);
    retained.close();
  });
  it("compacts an acknowledged reservation only after 24 hours and never replays it", async () => {
    const f = await coordinatorFixture();
    await f.coordinator().coordinate(f.input);
    f.setNow(f.now() + 86399999);
    await f.coordinator().coordinate(f.input);
    expect((await f.journal.read(f.input.connectionId)).members).toHaveLength(1);
    f.setNow(f.now() + 1);
    await f.coordinator().coordinate(f.input);
    expect(await f.journal.read(f.input.connectionId)).toEqual({ members: [], reservations: [] });
    expect(f.dispatchOnce).toHaveBeenCalledTimes(1);
  });
  it("protocol pause survives boot, cleanup failure and operator resume until update", async () => {
    const f = backgroundFixture("paired-idle", {
      coordinate: vi.fn(async () => ({ outcome: "protocol-violation" as const })),
    });
    await f.background.boot();
    expect(await f.background.status()).toMatchObject({ state: "paused", pauseReason: "protocol-violation" });
    await f.command("resume");
    await f.startup();
    expect(await f.background.status()).toMatchObject({ state: "paused", pauseReason: "protocol-violation" });
    vi.mocked(f.ports.sweep.run).mockResolvedValueOnce({ ok: false, nextDeadline: null });
    await f.alarm("connector-retention-deadline");
    expect(await f.background.status()).toMatchObject({ state: "paused", pauseReason: "protocol-violation" });
    vi.mocked(f.ports.transport.coordinate!).mockResolvedValue({ outcome: "ok" });
    await f.installed("update");
    expect(await f.background.status()).toMatchObject({ state: "paired-idle", pauseReason: null });
  });
  it("unpair and re-pair cannot clear a protocol pause", async () => {
    const f = backgroundFixture("paired-idle", {
      coordinate: vi.fn(async () => ({ outcome: "protocol-violation" as const })),
    });
    await f.background.boot();
    vi.mocked(f.ports.transport.coordinate!).mockResolvedValue({ outcome: "ok" });
    await f.command("unpair");
    expect(await f.background.status()).toMatchObject({ state: "unpaired", pauseReason: "protocol-violation" });
    await f.command("start-pairing");
    expect(await f.background.status()).toMatchObject({ state: "paused", pauseReason: "protocol-violation" });
    await f.installed("update");
    expect(await f.background.status()).toMatchObject({ state: "paired-idle", pauseReason: null });
  });
});
