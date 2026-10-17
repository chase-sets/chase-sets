export const journalPhases = [
  "prepared",
  "dispatched",
  "receipt-captured",
  "outcome-unknown",
  "reported",
  "acked",
] as const;
export type JournalPhase = (typeof journalPhases)[number];
export type Boundary = { phase: JournalPhase | "delete"; side: "pending" | "committed" };

// Instruments the storage port, never the coordinator or its persisted grammar.
// The same observer runs with fake-indexeddb and Chromium's native IndexedDB.
export function observeJournal(indexedDB: IDBFactory, boundary?: Boundary) {
  const observations: { phase: string; side: string; stores: string[] }[] = [];
  let interrupted = false;
  const open = indexedDB.open.bind(indexedDB);
  indexedDB.open = (...args) => {
    const request = open(...args);
    request.addEventListener("success", () => {
      const db = request.result;
      const transaction = db.transaction.bind(db);
      db.transaction = (...args) => {
        const tx = transaction(...args);
        const stores = Array.from(tx.objectStoreNames);
        if (tx.mode !== "readwrite" || !stores.includes("reservations")) return tx;
        const phases = new Set<string>();
        const objectStore = tx.objectStore.bind(tx);
        tx.objectStore = (name) => {
          const store = objectStore(name);
          const remove = store.delete.bind(store);
          store.delete = (key) => {
            phases.add("delete");
            observations.push({ phase: "delete", side: "pending", stores });
            if (!interrupted && boundary?.phase === "delete" && boundary.side === "pending") {
              interrupted = true;
              tx.abort();
              throw new Error("SYNTHETIC_7940_DELETE_INTERRUPTION");
            }
            return remove(key);
          };
          const put = store.put.bind(store);
          store.put = (value, key) => {
            const phase: unknown = value?.phase ?? value?.state;
            if (typeof phase === "string") {
              phases.add(phase);
              observations.push({ phase, side: "pending", stores });
              if (!interrupted && boundary?.phase === phase && boundary.side === "pending") {
                interrupted = true;
                tx.abort();
                throw new Error("SYNTHETIC_7940_TRANSACTION_INTERRUPTION");
              }
            }
            return key === undefined ? put(value) : put(value, key);
          };
          return store;
        };
        tx.addEventListener("complete", (event) => {
          for (const phase of phases) observations.push({ phase, side: "committed", stores });
          if (!interrupted && boundary?.side === "committed" && phases.has(boundary.phase)) {
            interrupted = true;
            event.stopImmediatePropagation();
            // Lose the completion notification after commit, like a terminated worker.
            tx.onabort?.call(tx, new Event("abort"));
          }
        });
        return tx;
      };
    });
    return request;
  };
  return {
    observations,
    interrupted: () => interrupted,
    restore: () => {
      indexedDB.open = open;
    },
  };
}
