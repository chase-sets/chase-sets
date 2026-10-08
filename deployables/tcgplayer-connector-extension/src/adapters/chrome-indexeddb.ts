import type { createConnectorRetentionStore } from "@chase-sets/channels/client";

export function chromeIndexedDB(): Pick<Parameters<typeof createConnectorRetentionStore>[0], "indexedDB" | "keyRange"> {
  return { indexedDB: globalThis.indexedDB, keyRange: globalThis.IDBKeyRange };
}
