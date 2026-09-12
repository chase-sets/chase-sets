import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  ChannelDriftAttentionContribution,
  ChannelDriftDecision,
  ChannelHealthObservationV1,
  ChannelHealthObservationIdentity,
  ChannelReconciliationCounts,
  ChannelReconciliationMetrics,
} from "../domain/contracts";

const zeroCounts: ChannelReconciliationCounts = Object.freeze({
  listingsReconciled: 0,
  inSync: 0,
  repairable: 0,
  foreignEdit: 0,
  structural: 0,
  sourceUnavailable: 0,
  repairsEnqueued: 0,
  repairsSucceeded: 0,
  missedSaleGaps: 0,
});

export async function readChannelDriftDecision(
  db: PgQueryable,
  input: Readonly<{ connectionId: string; channelListingId: string }>,
): Promise<ChannelDriftDecision> {
  const result = await db.query<{
    revision: string | number;
    accepted_observed_fingerprint: string | null;
    accepted_expected_material_fingerprint: string | null;
    accepted_at_run_generation: string | number | null;
    repush_requested: boolean;
    last_operation_id: string | null;
  }>(
    `SELECT revision,accepted_observed_fingerprint,accepted_expected_material_fingerprint,
            accepted_at_run_generation,repush_requested,last_operation_id
     FROM channel_drift_decisions WHERE connection_id=$1 AND channel_listing_id=$2`,
    [input.connectionId, input.channelListingId],
  );
  const row = result.rows[0];
  return {
    ...input,
    revision: Number(row?.revision ?? 0),
    accepted:
      row?.accepted_observed_fingerprint && row.accepted_expected_material_fingerprint
        ? {
            observedFingerprint: row.accepted_observed_fingerprint,
            expectedMaterialFingerprint: row.accepted_expected_material_fingerprint,
            acceptedAtRunGeneration: Number(row.accepted_at_run_generation),
          }
        : null,
    repushRequested: row?.repush_requested ?? false,
    operationId: row?.last_operation_id ?? null,
  };
}

export async function readChannelDriftAttentionContribution(
  db: PgQueryable,
  input: Readonly<{ connectionId: string; limit?: number }>,
): Promise<ChannelDriftAttentionContribution | null> {
  const limit = input.limit ?? 100;
  const result = await db.query<{
    run_generation: string | number;
    total: string | number;
    fingerprints: string[];
  }>(
    `SELECT MAX(run_generation) AS run_generation,COUNT(*)::integer AS total,
            ARRAY_AGG(fingerprint ORDER BY identity) AS fingerprints
     FROM (
       SELECT run_generation,channel_listing_id AS identity,
              COALESCE(observed_fingerprint,expected_material_fingerprint) AS fingerprint
       FROM channel_reconciliation_items
       WHERE connection_id=$1 AND classification IN ('foreign-edit','structural') AND settled=false
       UNION ALL
       SELECT run_generation,finding_id AS identity,fingerprint
       FROM channel_reconciliation_findings WHERE connection_id=$1 AND open
       ORDER BY identity LIMIT $2
     ) AS bounded`,
    [input.connectionId, limit + 1],
  );
  const row = result.rows[0];
  const total = Number(row?.total ?? 0);
  if (total === 0) {
    const resolved = await db.query<{
      run_generation: string | number;
      fingerprint: string;
      resolution: "handled-on-channel" | "recovered-automatically";
    }>(
      `SELECT run_generation,fingerprint,resolution FROM channel_reconciliation_attention_resolutions
       WHERE connection_id=$1 ORDER BY run_generation DESC LIMIT 1`,
      [input.connectionId],
    );
    return resolved.rows[0]
      ? {
          connectionId: input.connectionId,
          generation: Number(resolved.rows[0].run_generation),
          affectedListingCount: 0,
          hasMore: 0,
          fingerprint: resolved.rows[0].fingerprint,
          resolution: resolved.rows[0].resolution,
        }
      : null;
  }
  const fingerprint = await sha256((row?.fingerprints ?? []).join("\0"));
  return {
    connectionId: input.connectionId,
    generation: Number(row!.run_generation),
    affectedListingCount: Math.min(total, limit),
    hasMore: total > limit ? 1 : 0,
    fingerprint,
    resolution: null,
  };
}

export async function readChannelReconciliationMetrics(
  db: PgQueryable,
  input: Readonly<{ accountId: string; connectionId: string; window: Readonly<{ from: string; to: string }> }>,
): Promise<ChannelReconciliationMetrics> {
  const result = await db.query<{
    runs_completed: string | number;
    listings_reconciled: string | number;
    in_sync: string | number;
    repairable: string | number;
    foreign_edit: string | number;
    structural: string | number;
    source_unavailable: string | number;
    repairs_enqueued: string | number;
    repairs_succeeded: string | number;
    missed_sale_gaps: string | number;
    last_clean_run_at: Date | string | null;
  }>(
    `SELECT COUNT(*)::integer AS runs_completed,
       COALESCE(SUM((counts->>'listingsReconciled')::integer),0)::integer AS listings_reconciled,
       COALESCE(SUM((counts->>'inSync')::integer),0)::integer AS in_sync,
       COALESCE(SUM((counts->>'repairable')::integer),0)::integer AS repairable,
       COALESCE(SUM((counts->>'foreignEdit')::integer),0)::integer AS foreign_edit,
       COALESCE(SUM((counts->>'structural')::integer),0)::integer AS structural,
       COALESCE(SUM((counts->>'sourceUnavailable')::integer),0)::integer AS source_unavailable,
       COALESCE(SUM((counts->>'repairsEnqueued')::integer),0)::integer AS repairs_enqueued,
       COALESCE(SUM((counts->>'repairsSucceeded')::integer),0)::integer AS repairs_succeeded,
       COALESCE(SUM((counts->>'missedSaleGaps')::integer),0)::integer AS missed_sale_gaps,
       MAX(completed_at) FILTER (WHERE clean) AS last_clean_run_at
     FROM channel_reconciliation_metrics
     WHERE account_id=$1 AND connection_id=$2 AND completed_at >= $3::timestamptz AND completed_at < $4::timestamptz`,
    [input.accountId, input.connectionId, input.window.from, input.window.to],
  );
  const row = result.rows[0];
  const counts = row
    ? {
        listingsReconciled: Number(row.listings_reconciled),
        inSync: Number(row.in_sync),
        repairable: Number(row.repairable),
        foreignEdit: Number(row.foreign_edit),
        structural: Number(row.structural),
        sourceUnavailable: Number(row.source_unavailable),
        repairsEnqueued: Number(row.repairs_enqueued),
        repairsSucceeded: Number(row.repairs_succeeded),
        missedSaleGaps: Number(row.missed_sale_gaps),
      }
    : zeroCounts;
  return {
    connectionId: input.connectionId,
    window: input.window,
    runsCompleted: Number(row?.runs_completed ?? 0),
    counts,
    lastCleanRunAt: instant(row?.last_clean_run_at ?? null),
  };
}

export async function readPendingHealthObservations(
  db: PgQueryable,
  input: Readonly<{ limit?: number }>,
): Promise<readonly ChannelHealthObservationV1[]> {
  const limit = input.limit ?? 100;
  const result = await db.query<{ payload: ChannelHealthObservationV1 }>(
    `SELECT payload FROM channel_reconciliation_health_observations
     WHERE consumed_at IS NULL ORDER BY occurred_at,source_work_id,source_attempt,result_ordinal LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => row.payload);
}

export async function acknowledgeHealthObservations(
  db: PgQueryable,
  input: Readonly<{ observations: readonly ChannelHealthObservationIdentity[]; consumedAt: string }>,
): Promise<Readonly<{ consumed: number }>> {
  if (input.observations.length < 1 || input.observations.length > 1_000) {
    throw new Error("Channel Reconciliation health acknowledgment must contain 1 to 1000 observations.");
  }
  const identities = input.observations.map((observation) => {
    const actualKeys = Object.keys(observation).sort();
    const expectedKeys = ["resultOrdinal", "sourceAttempt", "sourceWorkId"];
    if (
      actualKeys.length !== expectedKeys.length ||
      actualKeys.some((key, index) => key !== expectedKeys[index]) ||
      typeof observation.sourceWorkId !== "string" ||
      observation.sourceWorkId.length < 1 ||
      observation.sourceWorkId.length > 512 ||
      !Number.isSafeInteger(observation.sourceAttempt) ||
      observation.sourceAttempt < 1 ||
      !Number.isSafeInteger(observation.resultOrdinal) ||
      observation.resultOrdinal < 1
    ) {
      throw new Error("Channel Reconciliation health acknowledgment identity is invalid.");
    }
    return {
      source_work_id: observation.sourceWorkId,
      source_attempt: observation.sourceAttempt,
      result_ordinal: observation.resultOrdinal,
    };
  });
  const identityKeys = identities.map(
    (identity) => `${identity.source_work_id}\0${identity.source_attempt}\0${identity.result_ordinal}`,
  );
  if (new Set(identityKeys).size !== identityKeys.length) {
    throw new Error("Channel Reconciliation health acknowledgment identities must be unique.");
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.consumedAt)) {
    throw new Error("Channel Reconciliation health acknowledgment instant is invalid.");
  }
  const updated = await db.query(
    `WITH candidates AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb)
       AS candidate(source_work_id text,source_attempt integer,result_ordinal integer)
     )
     UPDATE channel_reconciliation_health_observations AS observation
     SET consumed_at=$2::timestamptz
     FROM candidates AS candidate
     WHERE observation.source_work_id=candidate.source_work_id
       AND observation.source_attempt=candidate.source_attempt
       AND observation.result_ordinal=candidate.result_ordinal
       AND observation.consumed_at IS NULL`,
    [JSON.stringify(identities), input.consumedAt],
  );
  return { consumed: Number(updated.rowCount ?? 0) };
}

async function sha256(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function instant(value: Date | string | null): string | null {
  return value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
