import type { ConnectorAuthority } from "../../connector-feed/domain/contracts";
import type { ConnectorGrant } from "../../../support/request-support/connector-oauth";
import type { ChannelInboundCoverage } from "./contracts";

const authorityKeys = [
  "connectionId",
  "accountId",
  "connectionState",
  "inbound",
  "pairingId",
  "grant",
  "claimReportAllowed",
] as const satisfies readonly (keyof ConnectorAuthority)[];
const grantKeys = [
  "grantId",
  "connectionId",
  "accountId",
  "pairingId",
  "userId",
  "clientId",
  "revision",
  "expiresAt",
  "valid",
] as const satisfies readonly (keyof ConnectorGrant)[];

export function resolveChannelInboundCoverage(
  authority: ConnectorAuthority | null | undefined,
  connection: Readonly<{ accountId: string; connectionId: string }>,
): ChannelInboundCoverage {
  const absent = { state: "dark", reason: "no-inbound-authority" } as const;
  if (
    !closedRecord(authority, authorityKeys) ||
    authority.accountId !== connection.accountId ||
    authority.connectionId !== connection.connectionId ||
    !["pending-setup", "active", "paused", "disconnected"].includes(authority.connectionState) ||
    !["absent", "live", "revoked"].includes(authority.inbound) ||
    typeof authority.claimReportAllowed !== "boolean" ||
    !(authority.pairingId === null || text(authority.pairingId)) ||
    !(authority.grant === null || validGrantShape(authority.grant))
  )
    return absent;

  if (authority.inbound === "revoked") return { state: "dark", reason: "inbound-authority-revoked" };
  const grant = authority.grant;
  if (
    authority.inbound !== "live" ||
    !["active", "paused"].includes(authority.connectionState) ||
    !grant ||
    grant.valid !== true ||
    !authority.pairingId ||
    grant.accountId !== authority.accountId ||
    grant.connectionId !== authority.connectionId ||
    grant.pairingId !== authority.pairingId
  )
    return absent;

  // The fenced producer owns grant validity. Claim/report membership and heartbeat do not own inbound coverage.
  return { state: "live", reason: null };
}

function closedRecord<T>(value: T, keys: readonly string[]): value is NonNullable<T> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function validGrantShape(grant: ConnectorGrant): boolean {
  return (
    closedRecord(grant, grantKeys) &&
    [grant.grantId, grant.connectionId, grant.accountId, grant.pairingId, grant.userId, grant.clientId].every(text) &&
    Number.isSafeInteger(grant.revision) &&
    grant.revision > 0 &&
    typeof grant.expiresAt === "string" &&
    Number.isFinite(Date.parse(grant.expiresAt)) &&
    typeof grant.valid === "boolean"
  );
}
