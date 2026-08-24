export const SHIPMENT_MUTATION_RECOVERY_SCHEMA_VERSION = 1;
export const SHIPMENT_MUTATION_RECOVERY_MAX_NONTERMINAL = 256;
export const SHIPMENT_MUTATION_RECOVERY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type ShipmentMutationClientState =
  | "editing"
  | "submitting"
  | "provider-pending"
  | "confirming"
  | "succeeded"
  | "partial"
  | "failed-safe"
  | "conflict"
  | "ambiguous"
  | "reauthentication-required"
  | "recovery-storage-required";

export type ShipmentMutationRecoveryDescriptor = Readonly<{
  schemaVersion: 1;
  tenantId: string;
  sellerAccountId: string;
  shipmentId: string;
  command: string;
  target: string | null;
  intentHash: string;
  mutationAttemptId: string;
  createdAt: string;
  lastObservedAt: string;
  state: Exclude<ShipmentMutationClientState, "editing" | "recovery-storage-required">;
  sentAt: string | null;
  automaticRecoveryReadAt: string | null;
}>;

type EncryptedDescriptorRecord = Readonly<{
  id: string;
  scope: string;
  terminal: boolean;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
}>;

const DATABASE_NAME = "chase-sets-fulfillment-mutation-recovery-v1";
const KEY_STORE = "keys";
const DESCRIPTOR_STORE = "descriptors";
const KEY_ID = "shipment-mutation-aes-gcm-v1";
const TERMINAL_STATES = new Set<ShipmentMutationClientState>(["succeeded", "failed-safe", "conflict"]);

export class ShipmentRecoveryStorageRequiredError extends Error {
  public constructor(message = "Secure recovery storage is required before this Shipment action can be sent.") {
    super(message);
    this.name = "ShipmentRecoveryStorageRequiredError";
  }
}

function requireBrowserCrypto() {
  if (!globalThis.crypto?.subtle || typeof indexedDB === "undefined") {
    throw new ShipmentRecoveryStorageRequiredError();
  }
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new ShipmentRecoveryStorageRequiredError());
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(new ShipmentRecoveryStorageRequiredError());
    transaction.onerror = () => reject(new ShipmentRecoveryStorageRequiredError());
  });
}

async function openDatabase() {
  requireBrowserCrypto();
  const request = indexedDB.open(DATABASE_NAME, 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
    if (!db.objectStoreNames.contains(DESCRIPTOR_STORE)) {
      const descriptors = db.createObjectStore(DESCRIPTOR_STORE, { keyPath: "id" });
      descriptors.createIndex("scope", "scope", { unique: false });
    }
  };
  return requestResult(request);
}

async function digest(value: string) {
  requireBrowserCrypto();
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hashShipmentMutationIntent(value: unknown) {
  return digest(JSON.stringify(value));
}

async function scopeIdentity(tenantId: string, sellerAccountId: string) {
  return digest(`shipment-recovery-scope/v1\n${tenantId}\n${sellerAccountId}`);
}

async function descriptorIdentity(
  input: Pick<ShipmentMutationRecoveryDescriptor, "tenantId" | "sellerAccountId" | "shipmentId" | "command" | "target">,
) {
  return digest(
    `shipment-recovery-descriptor/v1\n${input.tenantId}\n${input.sellerAccountId}\n${input.shipmentId}\n${input.command}\n${input.target ?? ""}`,
  );
}

async function getOrCreateKey(db: IDBDatabase) {
  const read = db.transaction(KEY_STORE, "readonly");
  const readDone = transactionDone(read);
  const existing = (await requestResult(read.objectStore(KEY_STORE).get(KEY_ID))) as CryptoKey | undefined;
  await readDone;
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const write = db.transaction(KEY_STORE, "readwrite");
  const writeDone = transactionDone(write);
  write.objectStore(KEY_STORE).add(key, KEY_ID);
  await writeDone;
  return key;
}

function descriptorAdditionalData(id: string, scope: string) {
  return new TextEncoder().encode(`shipment-recovery-aad/v1\n${scope}\n${id}`);
}

async function encryptDescriptor(
  key: CryptoKey,
  descriptor: ShipmentMutationRecoveryDescriptor,
  id: string,
  scope: string,
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: descriptorAdditionalData(id, scope) },
    key,
    new TextEncoder().encode(JSON.stringify(descriptor)),
  );
  return { iv: iv.buffer, ciphertext };
}

async function decryptDescriptor(key: CryptoKey, record: EncryptedDescriptorRecord) {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: record.iv, additionalData: descriptorAdditionalData(record.id, record.scope) },
      key,
      record.ciphertext,
    );
    const value = JSON.parse(new TextDecoder().decode(plaintext)) as ShipmentMutationRecoveryDescriptor;
    if (value.schemaVersion !== SHIPMENT_MUTATION_RECOVERY_SCHEMA_VERSION) throw new Error("unknown-schema");
    return value;
  } catch {
    throw new ShipmentRecoveryStorageRequiredError("Stored Shipment recovery material could not be verified.");
  }
}

async function recordsForScope(db: IDBDatabase, scope: string) {
  const transaction = db.transaction(DESCRIPTOR_STORE, "readonly");
  const done = transactionDone(transaction);
  const records = (await requestResult(
    transaction.objectStore(DESCRIPTOR_STORE).index("scope").getAll(scope),
  )) as EncryptedDescriptorRecord[];
  await done;
  return records;
}

function buffersEqual(left: ArrayBuffer, right: ArrayBuffer) {
  const leftBytes = new Uint8Array(left);
  const rightBytes = new Uint8Array(right);
  return leftBytes.length === rightBytes.length && leftBytes.every((value, index) => value === rightBytes[index]);
}

function recordsEqual(left: EncryptedDescriptorRecord, right: EncryptedDescriptorRecord) {
  return (
    left.id === right.id &&
    left.scope === right.scope &&
    left.terminal === right.terminal &&
    buffersEqual(left.iv, right.iv) &&
    buffersEqual(left.ciphertext, right.ciphertext)
  );
}

export async function persistShipmentMutationDescriptor(
  input: Readonly<{
    tenantId: string;
    sellerAccountId: string;
    shipmentId: string;
    command: string;
    target?: string | null;
    intentHash: string;
  }>,
) {
  const db = await openDatabase();
  try {
    const key = await getOrCreateKey(db);
    const scope = await scopeIdentity(input.tenantId, input.sellerAccountId);
    const id = await descriptorIdentity({ ...input, target: input.target ?? null });
    const records = await recordsForScope(db, scope);
    const decoded: ShipmentMutationRecoveryDescriptor[] = [];
    for (const record of records) {
      try {
        decoded.push(await decryptDescriptor(key, record));
      } catch {
        const purge = db.transaction(DESCRIPTOR_STORE, "readwrite");
        const purgeDone = transactionDone(purge);
        purge.objectStore(DESCRIPTOR_STORE).delete(record.id);
        await purgeDone;
        throw new ShipmentRecoveryStorageRequiredError();
      }
    }
    const existingIndex = records.findIndex((record) => record.id === id);
    if (existingIndex >= 0) {
      const existing = decoded[existingIndex]!;
      if (TERMINAL_STATES.has(existing.state)) {
        // Reclaimed atomically below; a completed action never owns the next explicit attempt.
      } else {
        if (
          existing.tenantId !== input.tenantId ||
          existing.sellerAccountId !== input.sellerAccountId ||
          existing.shipmentId !== input.shipmentId ||
          existing.command !== input.command ||
          existing.target !== (input.target ?? null) ||
          existing.intentHash !== input.intentHash
        ) {
          throw new ShipmentRecoveryStorageRequiredError(
            "An unresolved Shipment action already owns this recovery slot.",
          );
        }
        return existing;
      }
    }
    const nonterminalCount = decoded.filter((descriptor) => !TERMINAL_STATES.has(descriptor.state)).length;
    if (nonterminalCount >= SHIPMENT_MUTATION_RECOVERY_MAX_NONTERMINAL) {
      throw new ShipmentRecoveryStorageRequiredError("The secure Shipment recovery limit has been reached.");
    }
    const now = new Date().toISOString();
    const descriptor: ShipmentMutationRecoveryDescriptor = {
      schemaVersion: 1,
      tenantId: input.tenantId,
      sellerAccountId: input.sellerAccountId,
      shipmentId: input.shipmentId,
      command: input.command,
      target: input.target ?? null,
      intentHash: input.intentHash,
      mutationAttemptId: crypto.randomUUID(),
      createdAt: now,
      lastObservedAt: now,
      state: "submitting",
      sentAt: null,
      automaticRecoveryReadAt: null,
    };
    const encrypted = await encryptDescriptor(key, descriptor, id, scope);
    const reclaimableTerminalRecords = new Map(
      records.flatMap((record, index) =>
        TERMINAL_STATES.has(decoded[index]!.state) && record.terminal === true ? [[record.id, record] as const] : [],
      ),
    );
    const write = db.transaction(DESCRIPTOR_STORE, "readwrite");
    const writeDone = transactionDone(write);
    const store = write.objectStore(DESCRIPTOR_STORE);
    const scopedRecords = (await requestResult(store.index("scope").getAll(scope))) as EncryptedDescriptorRecord[];
    const terminalRecords = scopedRecords.filter((record) => {
      const observed = reclaimableTerminalRecords.get(record.id);
      return observed !== undefined && recordsEqual(observed, record);
    });
    const nonterminalRecords = scopedRecords.filter((record) => !terminalRecords.includes(record));
    if (nonterminalRecords.length >= SHIPMENT_MUTATION_RECOVERY_MAX_NONTERMINAL) {
      write.abort();
      await writeDone.catch(() => undefined);
      throw new ShipmentRecoveryStorageRequiredError("The secure Shipment recovery limit has been reached.");
    }
    for (const record of terminalRecords) {
      store.delete(record.id);
    }
    store.add({ id, scope, terminal: false, ...encrypted } satisfies EncryptedDescriptorRecord);
    await writeDone;
    const verify = db.transaction(DESCRIPTOR_STORE, "readonly");
    const verifyDone = transactionDone(verify);
    const stored = (await requestResult(verify.objectStore(DESCRIPTOR_STORE).get(id))) as EncryptedDescriptorRecord;
    await verifyDone;
    const roundTrip = await decryptDescriptor(key, stored);
    if (JSON.stringify(roundTrip) !== JSON.stringify(descriptor)) throw new ShipmentRecoveryStorageRequiredError();
    return descriptor;
  } finally {
    db.close();
  }
}

export async function updateShipmentMutationDescriptor(
  descriptor: ShipmentMutationRecoveryDescriptor,
  patch: Partial<
    Pick<ShipmentMutationRecoveryDescriptor, "state" | "sentAt" | "automaticRecoveryReadAt" | "lastObservedAt">
  >,
) {
  const db = await openDatabase();
  try {
    const key = await getOrCreateKey(db);
    const scope = await scopeIdentity(descriptor.tenantId, descriptor.sellerAccountId);
    const id = await descriptorIdentity(descriptor);
    const next = { ...descriptor, ...patch };
    const encrypted = await encryptDescriptor(key, next, id, scope);
    const transaction = db.transaction(DESCRIPTOR_STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(DESCRIPTOR_STORE).put({
      id,
      scope,
      terminal: TERMINAL_STATES.has(next.state),
      ...encrypted,
    } satisfies EncryptedDescriptorRecord);
    await done;
    return next;
  } finally {
    db.close();
  }
}

export async function listShipmentMutationDescriptors(tenantId: string, sellerAccountId: string) {
  const db = await openDatabase();
  try {
    const key = await getOrCreateKey(db);
    const scope = await scopeIdentity(tenantId, sellerAccountId);
    const records = await recordsForScope(db, scope);
    const descriptors: ShipmentMutationRecoveryDescriptor[] = [];
    for (const record of records) {
      try {
        const descriptor = await decryptDescriptor(key, record);
        if (descriptor.tenantId === tenantId && descriptor.sellerAccountId === sellerAccountId)
          descriptors.push(descriptor);
      } catch {
        const purge = db.transaction(DESCRIPTOR_STORE, "readwrite");
        const purgeDone = transactionDone(purge);
        purge.objectStore(DESCRIPTOR_STORE).delete(record.id);
        await purgeDone;
      }
    }
    return descriptors;
  } finally {
    db.close();
  }
}

export async function purgeShipmentMutationDescriptor(descriptor: ShipmentMutationRecoveryDescriptor) {
  const db = await openDatabase();
  try {
    const id = await descriptorIdentity(descriptor);
    const transaction = db.transaction(DESCRIPTOR_STORE, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(DESCRIPTOR_STORE).delete(id);
    await done;
  } finally {
    db.close();
  }
}

export async function completeShipmentMutationDescriptor(
  descriptor: ShipmentMutationRecoveryDescriptor,
  state: "succeeded" | "failed-safe" | "conflict",
) {
  const terminal = await updateShipmentMutationDescriptor(descriptor, {
    state,
    lastObservedAt: new Date().toISOString(),
  });
  await purgeShipmentMutationDescriptor(terminal);
}

export async function purgeAllShipmentMutationRecovery() {
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
