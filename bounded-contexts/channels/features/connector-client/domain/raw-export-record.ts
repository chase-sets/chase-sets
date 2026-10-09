import { closedRecord, connectorValue, safeRevision, utcInstant } from "./extension-records";

export const rawExportLifetime = 24 * 60 * 60 * 1000;
export const rawExportFields = [
  "schemaVersion",
  "rawExportId",
  "connectionId",
  "downloadedAt",
  "expiresAt",
  "digest",
  "byteLength",
  "acceptedSnapshotAt",
  "revision",
  "keyId",
  "nonce",
  "ciphertext",
] as const;
export type RawExportRecord = Readonly<{
  schemaVersion: 1;
  rawExportId: string;
  connectionId: string;
  downloadedAt: string;
  expiresAt: string;
  digest: string;
  byteLength: number;
  acceptedSnapshotAt: string | null;
  revision: number;
  keyId: string;
  nonce: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
}>;

export class RetentionError extends Error {
  constructor(
    readonly code: "invalid-record" | "upgrade-required" | "cleanup-failed" | "read-refused" | "write-refused",
  ) {
    super(code);
  }
}

export function parseRawExport(value: unknown, maxBytes = Number.MAX_SAFE_INTEGER): RawExportRecord {
  const row = closedRecord(value, rawExportFields);
  if (safeRevision(row.schemaVersion) && row.schemaVersion > 1) throw new RetentionError("upgrade-required");
  if (
    row.schemaVersion !== 1 ||
    !safeRevision(row.revision) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !Number.isSafeInteger(row.byteLength) ||
    (row.byteLength as number) < 1 ||
    (row.byteLength as number) > maxBytes ||
    !utcInstant(row.downloadedAt) ||
    !utcInstant(row.expiresAt) ||
    new Date(row.expiresAt as string).toISOString() !== row.expiresAt ||
    Date.parse(row.expiresAt as string) !== Date.parse(row.downloadedAt as string) + rawExportLifetime ||
    (row.acceptedSnapshotAt !== null && !utcInstant(row.acceptedSnapshotAt)) ||
    typeof row.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(row.digest) ||
    !(row.nonce instanceof Uint8Array) ||
    row.nonce.length !== 12 ||
    Object.keys(row.nonce).length !== 12 ||
    !(row.ciphertext instanceof ArrayBuffer) ||
    Object.keys(row.ciphertext).length !== 0 ||
    row.ciphertext.byteLength !== (row.byteLength as number) + 16
  )
    throw new RetentionError("invalid-record");
  for (const name of ["rawExportId", "connectionId", "keyId"] as const) connectorValue(row[name]);
  if (!(row.keyId as string).startsWith("connector-raw-key:")) throw new RetentionError("invalid-record");
  return row as RawExportRecord;
}

export function rawExportAuthenticatedData(record: RawExportRecord): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify([
      record.schemaVersion,
      record.rawExportId,
      record.connectionId,
      record.downloadedAt,
      record.expiresAt,
      record.digest,
      record.byteLength,
      record.acceptedSnapshotAt,
      record.revision,
      record.keyId,
    ]),
  );
}
