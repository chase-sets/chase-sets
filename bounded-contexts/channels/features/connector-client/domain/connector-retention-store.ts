import type { TrustedStorageArea } from "./extension-credential-custody";
import { closedRecord, connectorValue, utcInstant } from "./extension-records";
import { createRawExportDatabase } from "../integrations/raw-export-indexeddb";
import {
  parseRawExport,
  rawExportAuthenticatedData,
  rawExportLifetime,
  RetentionError,
  type RawExportRecord,
} from "./raw-export-record";

type Ports = Readonly<{
  indexedDB: IDBFactory;
  keyRange: typeof IDBKeyRange;
  session: TrustedStorageArea;
  clock: Readonly<{ now(): number }>;
  crypto?: Crypto;
  scheduleDeadline(when: number): Promise<void>;
}>;
type Worker = { tail: Promise<unknown>; generation: number };
const workers = new WeakMap<IDBFactory, Worker>();

export function createConnectorRetentionStore(ports: Ports) {
  const database = createRawExportDatabase(ports.indexedDB, ports.keyRange);
  const cryptography = ports.crypto ?? globalThis.crypto;
  let worker = workers.get(ports.indexedDB);
  if (!worker) {
    worker = { tail: Promise.resolve(), generation: 0 };
    workers.set(ports.indexedDB, worker);
  }
  const owner = worker;
  const refused = new Set<string>();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = owner.tail.then(operation);
    owner.tail = result.catch(() => {});
    return result;
  }
  async function trusted() {
    await ports.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  }
  async function key(row: RawExportRecord): Promise<CryptoKey | null> {
    const value = (await ports.session.get([row.keyId]))[row.keyId];
    if (
      !Array.isArray(value) ||
      value.length !== 32 ||
      value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
    )
      return null;
    return cryptography.subtle.importKey("raw", new Uint8Array(value), "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  function allowed(row: RawExportRecord, generation: number) {
    if (
      row.acceptedSnapshotAt !== null ||
      refused.has(row.rawExportId) ||
      generation !== owner.generation ||
      !Number.isFinite(ports.clock.now()) ||
      ports.clock.now() >= Date.parse(row.expiresAt)
    )
      throw new RetentionError("read-refused");
  }
  async function remove(row: RawExportRecord) {
    const current = await database.get(row.rawExportId);
    if (!current || current.schemaVersion !== 1 || current.revision !== row.revision || current.keyId !== row.keyId)
      return;
    // Remove only this revision's unique key; a replacement owns a different key.
    // Retain keyless ciphertext on IDB failure for the next sweep to retry.
    await ports.session.remove([row.keyId]);
    await database.change(row);
  }
  async function inspect(): Promise<"ready" | "upgrade-required" | "cleanup-failed"> {
    try {
      await database.inspect();
      return "ready";
    } catch (error) {
      return error instanceof RetentionError && error.code === "upgrade-required"
        ? "upgrade-required"
        : "cleanup-failed";
    }
  }
  return {
    inspect,
    async write(
      input: Readonly<{
        rawExportId: string;
        connectionId: string;
        downloadedAt: string;
        bytes: Uint8Array;
        maxBytes: number;
      }>,
    ) {
      closedRecord(input, ["rawExportId", "connectionId", "downloadedAt", "bytes", "maxBytes"]);
      connectorValue(input.rawExportId);
      connectorValue(input.connectionId);
      if (
        !utcInstant(input.downloadedAt) ||
        !(input.bytes instanceof Uint8Array) ||
        !Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 1 ||
        input.bytes.length < 1 ||
        input.bytes.length > input.maxBytes ||
        Date.parse(input.downloadedAt) > ports.clock.now() ||
        ports.clock.now() >= Date.parse(input.downloadedAt) + rawExportLifetime
      )
        throw new RetentionError("write-refused");
      const bytes = new Uint8Array(input.bytes);
      const generation = owner.generation;
      return serial(async () => {
        await database.inspect();
        await trusted();
        const keyId = `connector-raw-key:${cryptography.randomUUID()}`;
        const material = cryptography.getRandomValues(new Uint8Array(32));
        const encryptionKey = await cryptography.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt"]);
        const digest = Array.from(new Uint8Array(await cryptography.subtle.digest("SHA-256", bytes)), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        const record: RawExportRecord = {
          schemaVersion: 1,
          rawExportId: input.rawExportId,
          connectionId: input.connectionId,
          downloadedAt: input.downloadedAt,
          expiresAt: new Date(Date.parse(input.downloadedAt) + rawExportLifetime).toISOString(),
          digest,
          byteLength: bytes.length,
          acceptedSnapshotAt: null,
          revision: 0,
          keyId,
          nonce: cryptography.getRandomValues(new Uint8Array(12)),
          ciphertext: new ArrayBuffer(bytes.length + 16),
        };
        const ciphertext = await cryptography.subtle.encrypt(
          { name: "AES-GCM", iv: record.nonce, additionalData: rawExportAuthenticatedData(record), tagLength: 128 },
          encryptionKey,
          bytes,
        );
        const sealed = parseRawExport({ ...record, ciphertext }, input.maxBytes);
        allowed(sealed, generation);
        try {
          await ports.session.set({ [keyId]: Array.from(material) });
          // Schedule before commit: alarm failure must never strand a readable export.
          await ports.scheduleDeadline(Math.min(Date.parse(sealed.expiresAt), (await database.deadline()) ?? Infinity));
          allowed(sealed, generation);
          await database.add(sealed);
        } catch (error) {
          await ports.session.remove([keyId]);
          throw error;
        } finally {
          material.fill(0);
          bytes.fill(0);
        }
        return { rawExportId: sealed.rawExportId, digest, expiresAt: sealed.expiresAt, revision: sealed.revision };
      });
    },
    read(rawExportId: string): Promise<Uint8Array<ArrayBuffer>> {
      const generation = owner.generation;
      return serial(async () => {
        await database.inspect();
        await trusted();
        const stored = await database.get(rawExportId);
        if (!stored) throw new RetentionError("read-refused");
        const row = parseRawExport(stored);
        allowed(row, generation);
        const material = await key(row);
        if (!material) throw new RetentionError("read-refused");
        const bytes = new Uint8Array(
          await cryptography.subtle.decrypt(
            { name: "AES-GCM", iv: row.nonce, additionalData: rawExportAuthenticatedData(row), tagLength: 128 },
            material,
            row.ciphertext,
          ),
        );
        try {
          const current = await database.get(rawExportId);
          if (!current || current.revision !== row.revision || current.keyId !== row.keyId || !(await key(row)))
            throw new RetentionError("read-refused");
          allowed(parseRawExport(current), generation);
          return bytes;
        } catch (error) {
          bytes.fill(0);
          throw error;
        }
      });
    },
    accept(rawExportId: string): Promise<void> {
      refused.add(rawExportId);
      return serial(async () => {
        await database.inspect();
        await trusted();
        const stored = await database.get(rawExportId);
        if (!stored) return;
        const row = parseRawExport(stored);
        if (row.revision === Number.MAX_SAFE_INTEGER) throw new RetentionError("cleanup-failed");
        const terminal = {
          ...row,
          acceptedSnapshotAt: new Date(ports.clock.now()).toISOString(),
          revision: row.revision + 1,
        };
        if (await database.change(row, terminal)) await remove(terminal);
      });
    },
    run(input: Readonly<{ reason: "boot" | "work" | "unpair" | "retention"; deleteAll: boolean }>) {
      if (input.deleteAll) owner.generation++;
      return serial(async () => {
        try {
          await database.inspect();
          await trusted();
          let expired: RawExportRecord[];
          do {
            expired = await database.page(undefined, new Date(ports.clock.now()).toISOString());
            for (const row of expired) await remove(row);
          } while (expired.length);
          let after: IDBValidKey | undefined;
          do {
            const rows = await database.page(after);
            if (!rows.length) break;
            for (const row of rows) {
              if (input.deleteAll || row.acceptedSnapshotAt !== null || !(await key(row))) await remove(row);
            }
            after = rows.at(-1)!.rawExportId;
          } while (true);
          return { ok: true, nextDeadline: await database.deadline() };
        } catch (error) {
          return {
            ok: false,
            nextDeadline: null,
            error:
              error instanceof RetentionError && error.code === "upgrade-required"
                ? ("upgrade-required" as const)
                : ("cleanup-failed" as const),
          };
        }
      });
    },
  };
}
