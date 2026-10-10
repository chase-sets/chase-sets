import { createHash } from "node:crypto";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { definePolicy } from "@chase-sets/platform-policy/define-policy";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { canonicalJson } from "../../outbound-sync/domain/validation";
import {
  decodeStagedImportDispatchPolicy,
  decodeStagedImportDispatchPolicyResponse,
  stagedImportDispatchApplicability,
  stagedImportDispatchPolicyKey,
  StagedImportDispatchError,
} from "../domain/staged-import-dispatch-policy";
import { ConnectorPairingError } from "../domain/contracts";
import { connectorRecord, connectorString } from "../../../support/request-support/connector-oauth";
import type { ConnectorFeedServices } from "./runtime";

export const tcgplayerStagedImportDispatchPolicy = definePolicy({
  policyKey: stagedImportDispatchPolicyKey,
  contextName: "channels",
  schemaSummary:
    "TcgplayerStagedImportDispatchPolicy/v1 { minimumRequestStartIntervalSeconds: integer 60..600 seconds }; engineering bound, not provider capacity",
  defaultValue: { minimumRequestStartIntervalSeconds: 60 },
  decodeValue: decodeStagedImportDispatchPolicy,
});

export function createStagedImportDispatchPolicyReader(eventStore: EventStore, authority: ConnectorFeedServices) {
  return async (token: string, query: unknown, identify: Parameters<ConnectorFeedServices["withAuthority"]>[2]) => {
    const input = connectorRecord(query, ["reservationId", "requestNonce"]);
    const reservationId = connectorString(input.reservationId);
    const requestNonce = connectorString(input.requestNonce);
    if (!/^[a-f0-9]{32}$/.test(requestNonce)) throw new ConnectorPairingError("invalid-request");
    return authority.withGrantAuthority(
      token,
      async (current, db) => {
        if (current.connectionState !== "active" || !current.pairingId)
          throw new ConnectorPairingError("authorization-refused");
        const at = new Date().toISOString();
        // Reservation membership is producer-owned; this read never reserves, renews or reports it.
        const reserved = await db.query<{ valid: boolean }>(
          `SELECT count(*) > 0 AND bool_and(COALESCE(connection_id=$2 AND claimant_kind='connector'
          AND claim_owner_id=$3 AND status='in-flight' AND claimed_until > $4, false)) AS valid
         FROM channel_outbound_operations WHERE reservation_id=$1`,
          [reservationId, current.connectionId, current.pairingId, at],
        );
        if (reserved.rows[0]?.valid !== true) throw new ConnectorPairingError("authorization-refused");
        const policy = await resolveStagedImportDispatchPolicy(eventStore, db, at);
        return decodeStagedImportDispatchPolicyResponse({
          schemaVersion: 1,
          policyKey: stagedImportDispatchPolicyKey,
          unit: "seconds",
          applicability: stagedImportDispatchApplicability,
          connectionId: current.connectionId,
          pairingId: current.pairingId,
          reservationId,
          requestNonce,
          policy,
        });
      },
      identify,
    );
  };
}

export async function resolveStagedImportDispatchPolicy(eventStore: EventStore, db: PgQueryable, at: string) {
  try {
    await db.query("LOCK TABLE platform_policy_documents IN SHARE MODE");
    const resolved = await createPolicyRuntime({ eventStore, db }).resolvePolicy(tcgplayerStagedImportDispatchPolicy, {
      at,
    });
    if (resolved.source !== "policy" || !resolved.documentId || !resolved.effectiveFrom) throw new Error();
    const selected = (
      await db.query<{ event_id: string | null }>(
        `SELECT (SELECT h.event_id FROM platform_policy_document_history h
       WHERE h.document_id=d.document_id ORDER BY h.history_id DESC LIMIT 1) AS event_id
       FROM platform_policy_documents d WHERE d.document_id=$1`,
        [resolved.documentId],
      )
    ).rows[0];
    if (!selected?.event_id) throw new Error();
    const value = decodeStagedImportDispatchPolicy(resolved.value);
    return {
      source: "policy" as const,
      documentId: resolved.documentId,
      effectiveFrom: resolved.effectiveFrom,
      effectiveUntil: resolved.effectiveUntil,
      resolvedAt: resolved.resolvedAt,
      value,
      revision: createHash("sha256")
        .update(
          canonicalJson([
            stagedImportDispatchPolicyKey,
            "TcgplayerStagedImportDispatchPolicy/v1",
            "seconds",
            stagedImportDispatchApplicability,
            resolved.documentId,
            resolved.effectiveFrom,
            resolved.effectiveUntil,
            selected.event_id,
            value,
          ]),
        )
        .digest("hex"),
    };
  } catch {
    throw new StagedImportDispatchError("staged-import-policy-unavailable");
  }
}
