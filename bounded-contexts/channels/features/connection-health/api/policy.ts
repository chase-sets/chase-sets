import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { decodeChannelHealthPolicy } from "../domain/codecs";
import { healthDigest } from "../domain/identity";
import { channelHealthPolicy } from "../domain/policy";
import { ChannelHealthError } from "../domain/contracts";

export async function resolveChannelHealthPolicy(eventStore: EventStore, db: PgQueryable, at: string) {
  // Protect absent candidates as well as existing rows against projection inserts/revisions.
  // The lock is shared by health readers and held only for this short transaction.
  await db.query("LOCK TABLE platform_policy_documents IN SHARE MODE");
  const resolved = await createPolicyRuntime({ eventStore, db }).resolvePolicy(channelHealthPolicy, { at });
  const selected =
    resolved.documentId === null
      ? null
      : (
          await db.query<{ updated_at: Date; event_id: string | null }>(
            `SELECT d.updated_at, (SELECT h.event_id FROM platform_policy_document_history h
              WHERE h.document_id = d.document_id ORDER BY h.history_id DESC LIMIT 1) AS event_id
             FROM platform_policy_documents d WHERE d.document_id = $1`,
            [resolved.documentId],
          )
        ).rows[0];
  const value = decodeChannelHealthPolicy(resolved.value);
  if (resolved.documentId !== null && !selected?.event_id) throw new ChannelHealthError("invalid-health-contract");
  return {
    revision: healthDigest([
      "channels.connection-health/v1",
      resolved.documentId,
      resolved.effectiveFrom,
      resolved.effectiveUntil,
      selected?.updated_at.toISOString() ?? null,
      selected?.event_id ?? null,
      value,
    ]),
    value,
  };
}
