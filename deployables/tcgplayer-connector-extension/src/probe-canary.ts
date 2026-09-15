export const SYNTHETIC_CANARY = "chase-sets-synthetic-chromium-authority-canary-v1";
export const SYNTHETIC_PLATFORM_URL = "https://platform.invalid/chase-sets-synthetic-popup-canary";
export const PROBE_DATABASE_NAME = "chase-sets-synthetic-chromium-authority";
export const PROBE_STORE_NAME = "canaries";

export async function writeIndexedDbCanary(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(PROBE_DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(PROBE_STORE_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const transaction = request.result.transaction(PROBE_STORE_NAME, "readwrite");
      transaction.objectStore(PROBE_STORE_NAME).put(SYNTHETIC_CANARY, "authority");
      transaction.oncomplete = () => {
        request.result.close();
        resolve();
      };
      transaction.onerror = () => reject(transaction.error);
    };
  });
}

export async function readIndexedDbCanary(): Promise<boolean> {
  try {
    return await new Promise<boolean>((resolve) => {
      const request = indexedDB.open(PROBE_DATABASE_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(PROBE_STORE_NAME);
      request.onerror = () => resolve(false);
      request.onsuccess = () => {
        const transaction = request.result.transaction(PROBE_STORE_NAME, "readonly");
        const read = transaction.objectStore(PROBE_STORE_NAME).get("authority");
        read.onerror = () => resolve(false);
        read.onsuccess = () => {
          request.result.close();
          resolve(read.result === SYNTHETIC_CANARY);
        };
      };
    });
  } catch {
    return false;
  }
}
