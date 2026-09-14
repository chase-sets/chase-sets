import { createHash } from "node:crypto";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ChannelDriftDetail, ChannelDriftDetailRow } from "../domain/contracts";

type Cursor = Readonly<{ scope: string; basis: string; kind: "finding" | "listing"; identity: string }>;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export async function readChannelDriftDetail(
  pool: PgTransactionalPool,
  input: Readonly<{ accountId: string; connectionId: string; cursor?: string }>,
): Promise<ChannelDriftDetail> {
  try {
    const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor);
    const source = await pool.query<{
      state: Extract<ChannelDriftDetail, { kind: "loaded" }>["runState"] | null;
      generation: string | null;
      revision: string | null;
      updated_at: Date | string | null;
      drift_generation: string | null;
      fingerprint: string | null;
      detail_rows: Array<{
        row_kind: "listing" | "finding";
        row_identity: string;
        channel_listing_id: string | null;
        classification: Extract<ChannelDriftDetailRow, { rowKind: "listing" }>["classification"];
        actionable: boolean;
        run_generation: string;
        observed_fingerprint: string | null;
        expected_material_fingerprint: string | null;
        revision: string | null;
        accepted_observed_fingerprint: string | null;
        accepted_expected_material_fingerprint: string | null;
        accepted_at_run_generation: string | null;
        repush_requested: boolean | null;
        last_operation_id: string | null;
      }>;
    }>(
      `WITH source AS (
          SELECT run.state,run.generation,run.revision,run.updated_at,
                 run.drift_generation->>'generation' AS drift_generation,
                 run.drift_generation->>'fingerprint' AS fingerprint,
                 run.drift_generation->'members' AS members
          FROM channel_connections AS connection
          LEFT JOIN channel_reconciliation_state AS run
            ON run.connection_id=connection.connection_id AND run.account_id=connection.account_id
          WHERE connection.account_id=$1 AND connection.connection_id=$2
        ), rows AS (
          (
            SELECT 'listing'::text AS row_kind,
                   channel_drift_detail_identity(item.channel_listing_id) AS row_identity,
                   item.channel_listing_id,item.classification,item.run_generation,
                   item.observed_fingerprint,item.expected_material_fingerprint
            FROM channel_reconciliation_items AS item
            WHERE item.connection_id=$2 AND EXISTS (SELECT 1 FROM source)
              AND channel_drift_detail_identity(item.channel_listing_id) > $3
            ORDER BY row_identity LIMIT 51
          )
            UNION ALL
          (
            SELECT 'finding',channel_drift_detail_identity(finding_id),NULL,NULL,run_generation,NULL,NULL
            FROM channel_reconciliation_findings
            WHERE connection_id=$2 AND open AND $4::boolean AND EXISTS (SELECT 1 FROM source)
              AND channel_drift_detail_identity(finding_id) > $5
            ORDER BY 2 LIMIT 51
          )
          ), page AS (
            SELECT * FROM rows
            ORDER BY row_kind,row_identity LIMIT 51
          ), detail AS (
          SELECT page.*,COALESCE(page.classification='foreign-edit'
                 AND page.observed_fingerprint ~ '^[a-f0-9]{64}$'
                 AND page.expected_material_fingerprint ~ '^[a-f0-9]{64}$'
                 AND (SELECT members FROM source) @> jsonb_build_array(jsonb_build_object(
                   'identity','listing:'||page.channel_listing_id,'kind','foreign-edit','settlement','open',
                   'observedFingerprint',page.observed_fingerprint,
                   'expectedFingerprint',page.expected_material_fingerprint)),false) AS actionable,
                 decision.revision,decision.accepted_observed_fingerprint,
                 decision.accepted_expected_material_fingerprint,decision.accepted_at_run_generation,
                 decision.repush_requested,decision.last_operation_id
          FROM page LEFT JOIN LATERAL (
            SELECT * FROM channel_drift_decisions
            WHERE connection_id=$2 AND channel_listing_id=page.channel_listing_id LIMIT 1
          ) AS decision ON true
          )
          SELECT source.*, COALESCE((SELECT jsonb_agg(detail ORDER BY row_kind,row_identity) FROM detail),'[]'::jsonb) AS detail_rows
          FROM source`,
      [
        input.accountId,
        input.connectionId,
        cursor?.kind === "listing" ? cursor.identity : "",
        cursor?.kind !== "listing",
        cursor?.kind === "finding" ? cursor.identity : "",
      ],
    );
    const run = source.rows[0];
    if (!run) return { kind: "not-found" };
    const scope = digest(JSON.stringify([input.accountId, input.connectionId]));
    if (input.cursor !== undefined && (!cursor || cursor.scope !== scope)) return { kind: "stale-page" };
    if (!run.state || Number(run.generation) === 0) return { kind: cursor ? "stale-page" : "not-yet-observed" };
    const observedAt = new Date(run.updated_at!).toISOString();
    const basis = digest(
      JSON.stringify([run.generation, run.revision, observedAt, run.drift_generation, run.fingerprint]),
    );
    if (cursor && cursor.basis !== basis) return { kind: "stale-page" };
    const rows = run.detail_rows.slice(0, 50).map((row): ChannelDriftDetailRow => {
      if (row.row_kind === "finding")
        return {
          rowKind: "finding",
          rowIdentity: row.row_identity,
          flag: "unmapped",
          runGeneration: Number(row.run_generation),
        };
      return {
        rowKind: "listing",
        rowIdentity: row.row_identity,
        channelListingId: row.channel_listing_id!,
        classification: row.classification,
        actionable: row.actionable,
        runGeneration: Number(row.run_generation),
        observedFingerprint: row.observed_fingerprint,
        expectedMaterialFingerprint: row.expected_material_fingerprint,
        decision: {
          connectionId: input.connectionId,
          channelListingId: row.channel_listing_id!,
          revision: Number(row.revision ?? 0),
          accepted:
            row.accepted_observed_fingerprint && row.accepted_expected_material_fingerprint
              ? {
                  observedFingerprint: row.accepted_observed_fingerprint,
                  expectedMaterialFingerprint: row.accepted_expected_material_fingerprint,
                  acceptedAtRunGeneration: Number(row.accepted_at_run_generation),
                }
              : null,
          repushRequested: row.repush_requested ?? false,
          operationId: row.last_operation_id,
        },
      };
    });
    const hasMore = run.detail_rows.length > 50 ? 1 : 0;
    const last = rows.at(-1);
    return {
      kind: "loaded",
      basis,
      runState: run.state,
      observedAt,
      rows,
      hasMore,
      cursor:
        hasMore && last
          ? Buffer.from(JSON.stringify({ scope, basis, kind: last.rowKind, identity: last.rowIdentity })).toString(
              "base64url",
            )
          : null,
    };
  } catch {
    return { kind: "unavailable" };
  }
}

function decodeCursor(value: string): Cursor | null {
  if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const data: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const row = data as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(",") !== "basis,identity,kind,scope" ||
      (row.kind !== "finding" && row.kind !== "listing") ||
      ![row.scope, row.basis, row.identity].every((field) => typeof field === "string" && /^[a-f0-9]{64}$/.test(field))
    )
      return null;
    return row as Cursor;
  } catch {
    return null;
  }
}
