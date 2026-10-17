import { loadProjectionGroupGeneration } from "@chase-sets/bounded-context-runtime";
import { withPgTransaction, type PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ConnectorLivenessAuthority, ConnectorLivenessCursor } from "../../connector-feed/domain/liveness";
import { closed, decodeChannelHealthSnapshot, instant, integer } from "../domain/codecs";
import { evaluateConnectorLiveness } from "../domain/connector-liveness";
import {
  ChannelHealthError,
  type ChannelHealthObservation,
  type ChannelHealthSnapshot,
  type ChannelHealthSubmission,
  type ConnectorLivenessSweep,
} from "../domain/contracts";
import type { ConnectionHealthDependencies } from "./runtime";

const projection = { targetContextName: "channels", projectionName: "channel-connection-projection" };

async function readSnapshot(db: PgQueryable, connectionId: string) {
  const result = await db.query<{ snapshot: unknown }>(
    `SELECT jsonb_build_object('policyRevision',policy_revision,'evaluationGeneration',evaluation_generation,
      'state',state,'reasons',reasons,'observedAt',observed_at) AS snapshot
     FROM channel_connection_health WHERE connection_id=$1`,
    [connectionId],
  );
  return result.rows[0] ? decodeChannelHealthSnapshot(result.rows[0].snapshot) : null;
}

function openLiveness(health: ChannelHealthSnapshot | null) {
  return (
    health?.reasons.find((reason) => reason.reasonCode === "connector-liveness" && reason.state !== "closed") ?? null
  );
}

export function createConnectorLivenessSweep(
  deps: ConnectionHealthDependencies,
  submit: (
    observation: ChannelHealthObservation,
    context: EventStoreContext,
    db: PgQueryable,
  ) => Promise<ChannelHealthSubmission>,
) {
  return async (input: Readonly<{ now: string; limit: number }>): Promise<ConnectorLivenessSweep> => {
    closed(input, ["now", "limit"]);
    const now = instant(input.now);
    const limit = integer(input.limit, 100);
    const policy = await withPgTransaction(deps.db, (db) => deps.resolvePolicy(db, now));
    let examined = 0;
    let accepted = 0;
    const refusals: { connectionId: string; reason: ConnectorLivenessSweep["refusals"][number]["reason"] }[] = [];
    const visited = new Set<string>();

    async function consider(connectionId: string, authority: ConnectorLivenessAuthority | null) {
      visited.add(connectionId);
      examined++;
      const refuse = (reason: ConnectorLivenessSweep["refusals"][number]["reason"]) => {
        refusals.push({ connectionId, reason });
      };
      if (!authority) return refuse("authority-missing");
      const generation = await loadProjectionGroupGeneration(deps.db, projection);
      if (generation?.state !== "active") return refuse("connection-projection-rebuilding");
      const health = await readSnapshot(deps.db, connectionId);
      const observation = evaluateConnectorLiveness({
        authority,
        openGeneration: openLiveness(health),
        now,
        policyRevision: policy.revision,
        evaluationGeneration: health
          ? health.evaluationGeneration + Number(health.policyRevision !== policy.revision)
          : 1,
      });
      if (!observation) return;
      await withPgTransaction(deps.db, async (db) => {
        // Pairing and intake writers share this order: stream, connection, authority, health.
        await db.query("SELECT stream_id FROM event_store_streams WHERE stream_id=$1 FOR UPDATE", [
          `channels.connection-${connectionId}`,
        ]);
        const current = await deps.connectorLiveness.readConnectorLivenessAuthorityInTransaction(db, { connectionId });
        if (!current) return refuse("authority-missing");
        const currentGeneration = await loadProjectionGroupGeneration(db, projection);
        if (currentGeneration?.state !== "active") return refuse("connection-projection-rebuilding");
        const currentHealth = await readSnapshot(db, connectionId);
        const currentPolicy = await deps.resolvePolicy(db, now);
        if (
          JSON.stringify(current) !== JSON.stringify(authority) ||
          JSON.stringify(currentGeneration) !== JSON.stringify(generation) ||
          JSON.stringify(currentHealth) !== JSON.stringify(health) ||
          JSON.stringify(currentPolicy) !== JSON.stringify(policy)
        )
          return refuse("snapshot-changed");
        const opening = await db.query<{
          tenant_id: EventStoreContext["tenantId"];
          for_account_id: EventStoreContext["audit"]["forAccountId"];
        }>(
          "SELECT tenant_id,for_account_id FROM event_store_events WHERE stream_id=$1 ORDER BY stream_version LIMIT 1",
          [`channels.connection-${connectionId}`],
        );
        const event = opening.rows[0];
        if (!event) return refuse("snapshot-changed");
        const result = await submit(
          observation,
          {
            tenantId: event.tenant_id,
            audit: { performedByUserId: "usr_system", forAccountId: event.for_account_id },
          },
          db,
        );
        if (result.outcome === "accepted") accepted++;
      }).catch((error: unknown) => {
        if (!(error instanceof ChannelHealthError) || error.code !== "health-snapshot-changed") throw error;
        refuse("snapshot-changed");
      });
    }

    // A: due authorities without an open reason. Keyset traversal cannot be starved by an open first page.
    let after: ConnectorLivenessCursor | undefined;
    let failures = 0;
    do {
      const page = await deps.connectorLiveness.listConnectorLivenessCandidates({
        dueAt: now,
        limit,
        ...(after ? { after } : {}),
      });
      for (const authority of page.candidates) {
        if (openLiveness(await readSnapshot(deps.db, authority.connectionId))) continue;
        await consider(authority.connectionId, authority);
        if (++failures === limit) break;
      }
      after = page.nextCursor ?? undefined;
    } while (after && failures < limit);

    // B: every changed open series, including missing authority (a named refusal, never a token).
    let afterConnectionId = "";
    let closes = 0;
    while (closes < limit) {
      const pageLimit = limit - closes;
      const changed = await deps.db.query<{ connection_id: string }>(
        `SELECT h.connection_id FROM channel_connection_health h
       JOIN channel_connections c USING (connection_id)
       CROSS JOIN LATERAL jsonb_array_elements(h.reasons) reason
       LEFT JOIN channel_connector_liveness_authority a ON a.connection_id=h.connection_id
       WHERE h.connection_id > $1 AND h.reasons @> '[{"reasonCode":"connector-liveness","state":"failing"}]'::jsonb
         AND c.status IN ('active','pending-setup') AND reason->>'reasonCode'='connector-liveness'
         AND reason->>'state'<>'closed'
         AND (a.connection_id IS NULL OR a.live_pairing_id IS DISTINCT FROM reason->>'fingerprint'
           OR a.heartbeat_revision IS DISTINCT FROM ((reason->'opening'->>'sourceWorkId')::jsonb->>3)::bigint)
       ORDER BY h.connection_id LIMIT $2`,
        [afterConnectionId, pageLimit],
      );
      for (const { connection_id: connectionId } of changed.rows) {
        afterConnectionId = connectionId;
        if (!visited.has(connectionId)) {
          await consider(connectionId, await deps.connectorLiveness.readConnectorLivenessAuthority({ connectionId }));
          closes++;
        }
      }
      if (changed.rows.length < pageLimit) break;
    }
    return { examined, accepted, refusals };
  };
}
