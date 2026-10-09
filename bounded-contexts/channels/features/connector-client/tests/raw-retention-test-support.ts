import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { vi } from "vitest";
import { createConnectorRetentionStore } from "../domain/connector-retention-store";

export function retentionFixture() {
  const indexedDB = new IDBFactory();
  const rows: Record<string, unknown> = {};
  let now = Date.parse("2026-10-08T00:00:00.000Z");
  const session = {
    setAccessLevel: vi.fn(async () => {}),
    get: vi.fn(async (keys: readonly string[]) =>
      Object.fromEntries(keys.filter((key) => key in rows).map((key) => [key, rows[key]])),
    ),
    set: vi.fn(async (values: Readonly<Record<string, unknown>>) => {
      Object.assign(rows, structuredClone(values));
    }),
    remove: vi.fn(async (keys: readonly string[]) => {
      for (const key of keys) delete rows[key];
    }),
  };
  const ports = {
    indexedDB,
    keyRange: IDBKeyRange,
    session,
    clock: { now: () => now },
    scheduleDeadline: vi.fn(async (_when: number) => {}),
  };
  const store = createConnectorRetentionStore(ports);
  const input = (rawExportId = "raw_A") => ({
    rawExportId,
    connectionId: "connection_A",
    downloadedAt: new Date(now).toISOString(),
    bytes: new TextEncoder().encode("SYNTHETIC_RAW_CANARY_7922"),
    maxBytes: 1024,
  });
  return {
    indexedDB,
    rows,
    session,
    ports,
    store,
    input,
    now: () => now,
    setNow: (value: number) => {
      now = value;
    },
  };
}

export function openDatabase(
  indexedDB: IDBFactory,
  version = 1,
  upgrade?: (db: IDBDatabase, tx: IDBTransaction) => void,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("connector-raw-exports", version);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => upgrade?.(request.result, request.transaction!);
    request.onsuccess = () => resolve(request.result);
  });
}

export async function retainedRows(indexedDB: IDBFactory, version = 1) {
  const db = await openDatabase(indexedDB, version);
  try {
    return await new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction("raw-exports").objectStore("raw-exports").getAll();
      request.onsuccess = () => resolve(request.result as unknown[]);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}
