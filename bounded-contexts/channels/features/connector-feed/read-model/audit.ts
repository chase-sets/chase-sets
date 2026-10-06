import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { assertClosedRecord, assertOpaqueId } from "../../connections/domain/validation";
import {
  connectorAuditReasons,
  connectorAuditRoutes,
  ConnectorPairingError,
  type ConnectorAuditEntry,
} from "../domain/contracts";

export async function recordConnectorAudit(db: PgQueryable, entry: ConnectorAuditEntry): Promise<void> {
  assertClosedRecord(entry, ["requestId", "identity", "route", "outcome", "reason"], "connector audit");
  assertOpaqueId(entry.requestId, "requestId");
  if (
    !connectorAuditRoutes.includes(entry.route) ||
    !connectorAuditReasons.includes(entry.reason) ||
    (entry.outcome !== "accepted" && entry.outcome !== "refused") ||
    (entry.outcome === "accepted") !== (entry.reason === "accepted")
  )
    throw new ConnectorPairingError("invalid-request");
  if (entry.identity !== null) {
    assertClosedRecord(entry.identity, ["connectionId", "pairingId"], "connector audit identity");
    assertOpaqueId(entry.identity.connectionId, "connectionId");
    if (entry.identity.pairingId !== null) assertOpaqueId(entry.identity.pairingId, "pairingId");
  }
  await db.query(
    `INSERT INTO channel_connector_audit
    (request_id, connection_id, pairing_id, route, outcome, reason, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      entry.requestId,
      entry.identity?.connectionId ?? null,
      entry.identity?.pairingId ?? null,
      entry.route,
      entry.outcome,
      entry.reason,
      new Date().toISOString(),
    ],
  );
}
