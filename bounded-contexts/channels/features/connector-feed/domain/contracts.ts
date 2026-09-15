import type { ConnectorGrant } from "../../../support/request-support/connector-oauth";
import { CHANNEL_CONNECTOR_OPERATIONS } from "@chase-sets/auth-context";

export const connectorOperations = CHANNEL_CONNECTOR_OPERATIONS;
export type ConnectorOperation = (typeof connectorOperations)[number];
export const connectorOAuthRoutes = ["register", "authorize", "token", "revoke"] as const;
export const connectorAuditRoutes = [
  ...connectorOAuthRoutes,
  "pairing-read",
  "pairing-create",
  "unpair",
  ...connectorOperations,
] as const;
export type ConnectorAuditRoute = (typeof connectorAuditRoutes)[number];
export const connectorAuditReasons = [
  "accepted",
  "invalid-request",
  "invalid-credential",
  "authorization-refused",
  "unavailable",
  "connection-not-found",
  "pairing-expired",
  "conflict",
] as const;
export type ConnectorAuditReason = (typeof connectorAuditReasons)[number];
export type ConnectorAuditEntry = Readonly<{
  requestId: string;
  identity: ConnectorIdentity | null;
  route: ConnectorAuditRoute;
  outcome: "accepted" | "refused";
  reason: ConnectorAuditReason;
}>;
export type ConnectorIdentity = Readonly<{ connectionId: string; pairingId: string | null }>;
export type ConnectorAuthority = Readonly<{
  connectionId: string;
  accountId: string;
  connectionState: "pending-setup" | "active" | "paused" | "disconnected";
  inbound: "absent" | "live" | "revoked";
  pairingId: string | null;
  grant: ConnectorGrant | null;
  claimReportAllowed: boolean;
}>;
export type ConnectorPairingDetail = Readonly<{
  state: "unpaired" | "code" | "expired" | "paired";
  pairingId: string | null;
  revision: number | null;
  codeExpiresAt: string | null;
  lastSeenAt: string | null;
}>;
export type GeneratedPairingCode = Readonly<{ pairingId: string; revision: number; code: string; expiresAt: string }>;
export class ConnectorPairingError extends Error {
  constructor(
    readonly code:
      | "connection-not-found"
      | "pairing-expired"
      | "conflict"
      | "authorization-refused"
      | "invalid-request"
      | "invalid-credential"
      | "unavailable",
  ) {
    super(code);
  }
}
