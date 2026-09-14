import { assertClosedRecord, assertOpaqueId, assertRfc3339Instant } from "../../connections/domain/validation";
import { ConnectorPairingError, type ConnectorPairingDetail, type GeneratedPairingCode } from "./contracts";

export function decodeGeneratedPairingCode(value: unknown): GeneratedPairingCode {
  assertClosedRecord(value, ["pairingId", "revision", "code", "expiresAt"], "generated pairing code");
  const { pairingId, revision, code, expiresAt } = value;
  assertOpaqueId(pairingId, "pairingId");
  assertRfc3339Instant(expiresAt, "expiresAt");
  if (revision !== 1 || typeof code !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(code))
    throw new ConnectorPairingError("invalid-request");
  return { pairingId, revision, code, expiresAt };
}

export function decodeConnectorPairingDetail(value: unknown): ConnectorPairingDetail {
  assertClosedRecord(value, ["state", "pairingId", "revision", "codeExpiresAt", "lastSeenAt"], "connector pairing");
  const { state, pairingId, revision, codeExpiresAt, lastSeenAt } = value;
  if (state !== "unpaired" && state !== "code" && state !== "expired" && state !== "paired")
    throw new ConnectorPairingError("invalid-request");
  if (pairingId !== null) assertOpaqueId(pairingId, "pairingId");
  if (revision !== null && (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1))
    throw new ConnectorPairingError("invalid-request");
  if (codeExpiresAt !== null) assertRfc3339Instant(codeExpiresAt, "codeExpiresAt");
  if (lastSeenAt !== null) assertRfc3339Instant(lastSeenAt, "lastSeenAt");
  if (
    pairingId === null &&
    (revision !== null || codeExpiresAt !== null || lastSeenAt !== null || state !== "unpaired")
  )
    throw new ConnectorPairingError("invalid-request");
  if (pairingId !== null && (revision === null || codeExpiresAt === null))
    throw new ConnectorPairingError("invalid-request");
  return { state, pairingId, revision, codeExpiresAt, lastSeenAt };
}
