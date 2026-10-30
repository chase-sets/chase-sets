import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { liveExportUnknownReasons } from "../../outbound-sync/domain/live-export-codec";
import { orderPullUnknownReasons } from "../../outbound-sync/domain/order-pull-codec";
import {
  ChannelAttentionError,
  type ConnectorAttentionContribution,
  type ConnectorKindActivity,
  type ConnectorUnknownOutcome,
} from "../domain/contracts";

type Instant = Date | string | null;
type ContributionRow = {
  connection_id: string;
  export_operation_id: string | null;
  export_outcome_kind: string | null;
  export_reason: string | null;
  export_terminal_at: Instant;
  pull_operation_id: string | null;
  pull_outcome_kind: string | null;
  pull_reason: string | null;
  pull_terminal_at: Instant;
  sign_in_needed: boolean;
  batch_run_id: string | null;
  batch_state: string | null;
  batch_updated_at: Instant;
  export_work: boolean;
  export_last_succeeded_at: Instant;
  export_queued: number | null;
  export_in_flight_since: Instant;
  pull_work: boolean;
  pull_last_succeeded_at: Instant;
  pull_queued: number | null;
  pull_in_flight_since: Instant;
  batch_work: boolean;
  batch_last_succeeded_at: Instant;
  batch_queued: number | null;
  batch_in_flight_since: Instant;
};

// Signals derive only from each kind's newest terminal row, so a newer outcome supersedes an older one.
// Counts are grouped COUNTs over every row; nothing here reads a capped list. Live export and order pull
// rows are connector-only work; Staged Import Batches count only `claimant_kind='connector'`, so manual
// runs keep their own contribution. A connector batch is composed inside the connector's reservation
// claim, so its composition instant is when that work started.
const connectorContributionSql = `
WITH selected AS (
  SELECT connection.connection_id FROM channel_connections AS connection
  WHERE connection.account_id=$1 AND connection.connection_id=ANY($2::text[])
), export_activity AS (
  SELECT connection_id, count(*) FILTER (WHERE status='pending')::int AS queued,
    max(terminal_at) FILTER (WHERE status='succeeded') AS last_succeeded_at,
    min(first_claimed_at) FILTER (WHERE status='in-flight') AS in_flight_since
  FROM channel_live_export_operations WHERE connection_id IN (SELECT connection_id FROM selected) GROUP BY connection_id
), pull_activity AS (
  SELECT connection_id, count(*) FILTER (WHERE status='pending')::int AS queued,
    max(terminal_at) FILTER (WHERE status='succeeded') AS last_succeeded_at,
    min(first_claimed_at) FILTER (WHERE status='in-flight') AS in_flight_since
  FROM channel_order_pull_operations WHERE connection_id IN (SELECT connection_id FROM selected) GROUP BY connection_id
), batch_activity AS (
  SELECT connection_id, count(*) FILTER (WHERE state='composed')::int AS queued,
    max(updated_at) FILTER (WHERE state='applied') AS last_succeeded_at,
    min(created_at) FILTER (WHERE state IN ('claimed','awaiting-verification')) AS in_flight_since
  FROM channel_sync_runs WHERE claimant_kind='connector' AND connection_id IN (SELECT connection_id FROM selected)
  GROUP BY connection_id
)
SELECT selected.connection_id,
  export_newest.operation_id AS export_operation_id, export_newest.outcome->>'kind' AS export_outcome_kind,
  export_newest.outcome->>'reason' AS export_reason, export_newest.terminal_at AS export_terminal_at,
  pull_newest.operation_id AS pull_operation_id, pull_newest.outcome->>'kind' AS pull_outcome_kind,
  pull_newest.outcome->>'reason' AS pull_reason, pull_newest.terminal_at AS pull_terminal_at,
  coalesce((
    SELECT newest.outcome->>'kind' IN ('live-export-unknown','order-pull-unknown')
      AND newest.outcome->>'reason'='session-lost'
    FROM (SELECT export_newest.outcome, export_newest.terminal_at
      UNION ALL SELECT pull_newest.outcome, pull_newest.terminal_at) AS newest
    WHERE newest.terminal_at IS NOT NULL
    ORDER BY newest.terminal_at DESC, coalesce(newest.outcome->>'reason'='session-lost', false) DESC LIMIT 1
  ), false) AS sign_in_needed,
  batch_newest.run_id AS batch_run_id, batch_newest.state AS batch_state, batch_newest.updated_at AS batch_updated_at,
  export_activity.connection_id IS NOT NULL AS export_work, export_activity.last_succeeded_at AS export_last_succeeded_at,
  export_activity.queued AS export_queued, export_activity.in_flight_since AS export_in_flight_since,
  pull_activity.connection_id IS NOT NULL AS pull_work, pull_activity.last_succeeded_at AS pull_last_succeeded_at,
  pull_activity.queued AS pull_queued, pull_activity.in_flight_since AS pull_in_flight_since,
  batch_activity.connection_id IS NOT NULL AS batch_work, batch_activity.last_succeeded_at AS batch_last_succeeded_at,
  batch_activity.queued AS batch_queued, batch_activity.in_flight_since AS batch_in_flight_since
FROM selected
LEFT JOIN LATERAL (
  SELECT operation_id, outcome, terminal_at FROM channel_live_export_operations
  WHERE connection_id=selected.connection_id AND terminal_at IS NOT NULL
  ORDER BY terminal_at DESC, operation_id DESC LIMIT 1
) AS export_newest ON true
LEFT JOIN LATERAL (
  SELECT operation_id, outcome, terminal_at FROM channel_order_pull_operations
  WHERE connection_id=selected.connection_id AND terminal_at IS NOT NULL
  ORDER BY terminal_at DESC, operation_id DESC LIMIT 1
) AS pull_newest ON true
LEFT JOIN LATERAL (
  SELECT run_id, state, updated_at FROM channel_sync_runs
  WHERE connection_id=selected.connection_id AND claimant_kind='connector'
  ORDER BY sequence DESC LIMIT 1
) AS batch_newest ON true
LEFT JOIN export_activity ON export_activity.connection_id=selected.connection_id
LEFT JOIN pull_activity ON pull_activity.connection_id=selected.connection_id
LEFT JOIN batch_activity ON batch_activity.connection_id=selected.connection_id`;

export async function readConnectorAttentionContributions(
  db: PgQueryable,
  accountId: string,
  connectionIds: readonly string[],
): Promise<ReadonlyMap<string, ConnectorAttentionContribution>> {
  if (connectionIds.length > 100) throw new Error("invalid-attention-page");
  const result = await db.query<ContributionRow>(connectorContributionSql, [accountId, connectionIds]);
  return new Map(
    result.rows
      .filter((row) => row.export_work || row.pull_work || row.batch_work)
      .map((row) => [row.connection_id, contribution(row)]),
  );
}

function contribution(row: ContributionRow): ConnectorAttentionContribution {
  const unknownOutcomes: ConnectorUnknownOutcome[] = [];
  if (row.export_outcome_kind === "live-export-unknown")
    unknownOutcomes.push({
      kind: "live-export",
      idSuffix: suffix(row.export_operation_id),
      reason: member(row.export_reason, liveExportUnknownReasons),
      at: instant(row.export_terminal_at)!,
    });
  if (row.pull_outcome_kind === "order-pull-unknown")
    unknownOutcomes.push({
      kind: "order-pull",
      idSuffix: suffix(row.pull_operation_id),
      reason: member(row.pull_reason, orderPullUnknownReasons),
      at: instant(row.pull_terminal_at)!,
    });
  if (row.batch_state === "application-unknown")
    unknownOutcomes.push({
      kind: "staged-import-batch",
      idSuffix: suffix(row.batch_run_id),
      reason: "application-unknown",
      at: instant(row.batch_updated_at)!,
    });
  return {
    signInNeeded: row.sign_in_needed,
    unknownOutcomes,
    activity: {
      "live-export": activity(row.export_last_succeeded_at, row.export_queued, row.export_in_flight_since),
      "order-pull": activity(row.pull_last_succeeded_at, row.pull_queued, row.pull_in_flight_since),
      "staged-import-batch": activity(row.batch_last_succeeded_at, row.batch_queued, row.batch_in_flight_since),
    },
  };
}

function activity(lastSucceededAt: Instant, queued: number | null, inFlightSince: Instant): ConnectorKindActivity {
  return { lastSucceededAt: instant(lastSucceededAt), queued: queued ?? 0, inFlightSince: instant(inFlightSince) };
}
function instant(value: Instant): string | null {
  return value === null ? null : new Date(value).toISOString();
}
function suffix(id: string | null): string {
  if (id === null || id.length < 4) throw new ChannelAttentionError("invalid-attention-contract");
  return id.slice(-4);
}
// Persisted outcomes are closed on write; an unrecognised reason fails the read rather than guessing copy.
function member<const T extends readonly string[]>(value: string | null, values: T): T[number] {
  if (value === null || !values.includes(value)) throw new ChannelAttentionError("invalid-attention-contract");
  return value;
}
