import { parseRawExport, RetentionError, type RawExportRecord } from "../domain/raw-export-record";
import { openConnectorDatabase } from "./connector-indexeddb";

const storeName = "raw-exports";
const chunkSize = 32;

export function createRawExportDatabase(indexedDB: IDBFactory, ranges: typeof IDBKeyRange) {
  function open(): Promise<IDBDatabase> {
    return openConnectorDatabase(indexedDB);
  }
  async function transaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore, done: (value: T) => void) => void,
  ): Promise<T> {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        let result: T;
        let failure: unknown;
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(failure ?? new RetentionError("cleanup-failed"));
        try {
          operation(tx.objectStore(storeName), (value) => {
            result = value;
          });
        } catch (error) {
          failure = error;
          tx.abort();
        }
      });
    } finally {
      db.close();
    }
  }
  function page(after?: IDBValidKey, expiredAt?: string): Promise<RawExportRecord[]> {
    return transaction("readonly", (store, done) => {
      const source = expiredAt === undefined ? store : store.index("expiresAt");
      const range =
        expiredAt === undefined
          ? after === undefined
            ? undefined
            : ranges.lowerBound(after, true)
          : ranges.upperBound(expiredAt);
      const rows: RawExportRecord[] = [];
      const request = source.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor || rows.length === chunkSize) {
          done(rows);
          return;
        }
        rows.push(cursor.value as RawExportRecord);
        cursor.continue();
      };
    });
  }
  async function inspect() {
    let after: IDBValidKey | undefined;
    do {
      const rows = await page(after);
      if (!rows.length) return;
      for (const row of rows) {
        // Inspect the version before applying the owned, closed schema.
        if (row.schemaVersion !== 1) throw new RetentionError("upgrade-required");
        parseRawExport(row);
      }
      after = rows.at(-1)!.rawExportId;
    } while (true);
  }
  return {
    inspect,
    page,
    get(id: string): Promise<RawExportRecord | undefined> {
      return transaction("readonly", (store, done) => {
        const request = store.get(id);
        request.onsuccess = () => done(request.result as RawExportRecord | undefined);
      });
    },
    add(row: RawExportRecord): Promise<void> {
      return transaction("readwrite", (store, done) => {
        store.add(row);
        done(undefined);
      });
    },
    change(row: RawExportRecord, replacement?: RawExportRecord): Promise<boolean> {
      return transaction("readwrite", (store, done) => {
        const request = store.get(row.rawExportId);
        request.onsuccess = () => {
          const current = request.result as RawExportRecord | undefined;
          if (
            !current ||
            current.schemaVersion !== 1 ||
            current.revision !== row.revision ||
            current.keyId !== row.keyId
          ) {
            done(false);
            return;
          }
          if (replacement) store.put(replacement);
          else store.delete(row.rawExportId);
          done(true);
        };
      });
    },
    deadline(): Promise<number | null> {
      return transaction("readonly", (store, done) => {
        const request = store.index("expiresAt").openCursor();
        request.onsuccess = () => done(request.result ? Date.parse(request.result.key as string) : null);
      });
    },
  };
}
