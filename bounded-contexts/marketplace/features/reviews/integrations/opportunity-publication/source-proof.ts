import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ReviewOpportunityProvenance } from "@chase-sets/event-core/review-opportunity-facts";

export const opportunitySourceProjections = [
  ["marketplace-review-order-source-projection", "ordering", 1],
  ["marketplace-review-shipment-source-projection", "fulfillment", 1],
  ["marketplace-review-support-source-projection", "platform-operations", 2],
  ["marketplace-review-hold-reaction", "platform-operations", 1],
  ["marketplace-review-scoring-reaction", "platform-operations", 1],
  ["marketplace-review-moderation-reaction", "platform-operations", 1],
  ["marketplace-review-projection", "marketplace", 1],
  ["marketplace-review-hold-projection", "marketplace", 1],
] as const;

export async function readOpportunitySourceProof(db: PgQueryable): Promise<{
  sourceGeneration: string;
  provenance: ReviewOpportunityProvenance;
} | null> {
  const result = await db.query<{ projection_name: string; position: string; generation: string }>(
    `SELECT checkpoint.projection_name, checkpoint.last_global_position::text AS position,
       generation.active_generation::text AS generation
     FROM event_subscription_checkpoints AS checkpoint
     JOIN event_projection_recovery_markers AS recovery
       ON recovery.projection_kind = 'subscription' AND recovery.projection_key = checkpoint.checkpoint_key
      AND recovery.last_global_position >= checkpoint.last_global_position
     JOIN event_projection_group_generations AS generation
       ON generation.target_context_name = 'marketplace'
      AND generation.projection_name = checkpoint.projection_name AND generation.state = 'active'
     JOIN event_projection_group_revisions AS revision
       ON revision.target_context_name = 'marketplace' AND revision.projection_name = checkpoint.projection_name
      AND revision.projection_revision = CASE WHEN checkpoint.projection_name = 'marketplace-review-projection' THEN 2 ELSE 1 END
     JOIN jsonb_to_recordset($1::jsonb) AS expected(name text, source text, version integer)
       ON expected.name = checkpoint.projection_name AND expected.source = checkpoint.source_context_name
      AND expected.version = checkpoint.subscription_version
     WHERE NOT EXISTS (
       SELECT 1 FROM event_projection_blocked_streams AS blocked
       WHERE blocked.projection_key = checkpoint.checkpoint_key AND blocked.state <> 'resolved'
     )`,
    [JSON.stringify(opportunitySourceProjections.map(([name, source, version]) => ({ name, source, version })))],
  );
  if (result.rows.length !== opportunitySourceProjections.length) return null;
  const positions = new Map(result.rows.map((row) => [row.projection_name, row.position]));
  const position = (index: number) => positions.get(opportunitySourceProjections[index]![0])!;
  // A source projection running before its reactions must not certify their absence.
  if ([3, 4, 5].some((index) => BigInt(position(index)) < BigInt(position(2)))) return null;
  const head = await db.query<{ position: string }>(
    `SELECT COALESCE(MAX(global_position), 0)::text AS position FROM event_store_events
     WHERE stream_id LIKE 'marketplace.review-%'
       AND stream_id NOT LIKE 'marketplace.review-opportunity-%'`,
  );
  if ([6, 7].some((index) => BigInt(position(index)) < BigInt(head.rows[0]!.position))) return null;
  return {
    sourceGeneration: opportunitySourceProjections
      .map(([name]) => result.rows.find((row) => row.projection_name === name)!.generation)
      .join(":"),
    provenance: {
      ordering: position(0),
      fulfillment: position(1),
      support: position(2),
      marketplace: head.rows[0]!.position,
    },
  };
}
