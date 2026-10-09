import { RetentionError } from "../domain/raw-export-record";

export const connectorDatabaseName = "connector-raw-exports";
export const connectorDatabaseVersion = 2;
export const connectorStores = ["raw-exports", "operation-attempts", "reservations"] as const;

export function openConnectorDatabase(indexedDB: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(connectorDatabaseName, connectorDatabaseVersion);
    let refused = false;
    const refuse = () => {
      refused = true;
      clearTimeout(timer);
      reject(new RetentionError("cleanup-failed"));
    };
    const timer = setTimeout(refuse, 1000);
    request.onblocked = refuse;
    request.onerror = () => {
      clearTimeout(timer);
      reject(new RetentionError(request.error?.name === "VersionError" ? "upgrade-required" : "cleanup-failed"));
    };
    request.onupgradeneeded = (event) => {
      const db = request.result;
      if (
        refused ||
        (event.oldVersion === 1 && (db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains("raw-exports")))
      ) {
        request.transaction!.abort();
        return;
      }
      if (event.oldVersion === 0)
        db.createObjectStore("raw-exports", { keyPath: "rawExportId" }).createIndex("expiresAt", "expiresAt");
      db.createObjectStore("operation-attempts", { keyPath: ["connectionId", "operationId"] });
      db.createObjectStore("reservations", { keyPath: ["connectionId", "reservationId"] });
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const db = request.result;
      db.onversionchange = () => db.close();
      if (refused) {
        db.close();
        return;
      }
      if (
        db.objectStoreNames.length !== connectorStores.length ||
        connectorStores.some((name) => !db.objectStoreNames.contains(name))
      ) {
        db.close();
        reject(new RetentionError("upgrade-required"));
      } else resolve(db);
    };
  });
}
