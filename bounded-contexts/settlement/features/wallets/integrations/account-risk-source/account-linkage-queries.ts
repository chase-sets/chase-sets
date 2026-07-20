import type { AccountLinkageSignalKind } from "@chase-sets/event-core/account-linkage-facts";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountLinkageFlagPolicyValue } from "../../domain/account-linkage-policy";

export type AccountLinkageClusterCandidate = Readonly<{
  signalKind: AccountLinkageSignalKind;
  clusterKey: string;
  clusterHash: string | null;
  accountIds: readonly string[] | null;
}>;

export type AccountLinkageCloserCursor = Readonly<{
  signalKind: AccountLinkageSignalKind;
  clusterKey: string;
}>;

const CLOSER_NAME = "account-linkage-closer";

export async function getAccountLinkageCloserCursor(db: PgQueryable): Promise<AccountLinkageCloserCursor | null> {
  const result = await db.query<{ after_signal_kind: AccountLinkageSignalKind; after_cluster_key: string }>(
    `SELECT after_signal_kind, after_cluster_key
     FROM settlement_account_linkage_closer_cursors
     WHERE closer_name = $1`,
    [CLOSER_NAME],
  );
  const row = result.rows[0];
  return row ? { signalKind: row.after_signal_kind, clusterKey: row.after_cluster_key } : null;
}

export async function saveAccountLinkageCloserCursor(
  db: PgQueryable,
  cursor: AccountLinkageCloserCursor | null,
  updatedAt: string,
): Promise<void> {
  if (!cursor) {
    await db.query(`DELETE FROM settlement_account_linkage_closer_cursors WHERE closer_name = $1`, [CLOSER_NAME]);
    return;
  }
  await db.query(
    `INSERT INTO settlement_account_linkage_closer_cursors (
       closer_name, after_signal_kind, after_cluster_key, updated_at
     ) VALUES ($1, $2, $3, $4)
     ON CONFLICT (closer_name) DO UPDATE SET
       after_signal_kind = EXCLUDED.after_signal_kind,
       after_cluster_key = EXCLUDED.after_cluster_key,
       updated_at = EXCLUDED.updated_at`,
    [CLOSER_NAME, cursor.signalKind, cursor.clusterKey, updatedAt],
  );
}

export async function listAccountLinkageClusterCandidates(
  db: PgQueryable,
  policy: AccountLinkageFlagPolicyValue,
  params: Readonly<{ after: AccountLinkageCloserCursor | null; limit: number }>,
): Promise<readonly AccountLinkageClusterCandidate[]> {
  const branches: string[] = [];
  if (policy.sharedInstrumentEnabled) {
    branches.push(`SELECT
      'shared-instrument'::text AS signal_kind,
      instrument_cluster_key AS cluster_key,
      ARRAY_AGG(DISTINCT account_id ORDER BY account_id) AS account_ids
    FROM settlement_account_instrument_risk_sources
    WHERE active = TRUE AND instrument_cluster_key IS NOT NULL
    GROUP BY instrument_cluster_key
    HAVING COUNT(DISTINCT account_id) >= $1`);
  }
  if (policy.sharedAddressEnabled) {
    branches.push(`SELECT
      'shared-address'::text AS signal_kind,
      address_cluster_key AS cluster_key,
      ARRAY_AGG(DISTINCT account_id ORDER BY account_id) AS account_ids
    FROM settlement_account_address_risk_sources
    WHERE active = TRUE AND address_cluster_key IS NOT NULL
    GROUP BY address_cluster_key
      HAVING COUNT(DISTINCT account_id) >= $1`);
  }
  const eligibleSql =
    branches.length > 0
      ? branches.join("\nUNION ALL\n")
      : `SELECT
      NULL::text AS signal_kind,
      NULL::text AS cluster_key,
      ARRAY[]::text[] AS account_ids
    WHERE FALSE AND $1::integer IS NULL`;

  const result = await db.query<{
    signal_kind: AccountLinkageSignalKind;
    cluster_key: string;
    cluster_hash: string | null;
    account_ids: string[] | null;
  }>(
    `WITH eligible AS (
      ${eligibleSql}
    ), reconciled AS (
      SELECT
        eligible.signal_kind,
        eligible.cluster_key,
        clusters.cluster_hash,
        eligible.account_ids
      FROM eligible
      LEFT JOIN settlement_account_linkage_clusters clusters
        USING (signal_kind, cluster_key)

      UNION ALL

      SELECT
        clusters.signal_kind,
        clusters.cluster_key,
        clusters.cluster_hash,
        NULL::text[] AS account_ids
      FROM settlement_account_linkage_clusters clusters
      WHERE clusters.flagged = TRUE
        AND NOT EXISTS (
          SELECT 1
          FROM eligible
          WHERE eligible.signal_kind = clusters.signal_kind
            AND eligible.cluster_key = clusters.cluster_key
        )
    )
    SELECT signal_kind, cluster_key, cluster_hash, account_ids
    FROM reconciled
    WHERE $2::text IS NULL OR (signal_kind, cluster_key) > ($2::text, $3::text)
    ORDER BY signal_kind, cluster_key
    LIMIT $4`,
    [policy.minimumClusterSize, params.after?.signalKind ?? null, params.after?.clusterKey ?? null, params.limit],
  );
  return result.rows.map((row) => ({
    signalKind: row.signal_kind,
    clusterKey: row.cluster_key,
    clusterHash: row.cluster_hash,
    accountIds: row.account_ids,
  }));
}

export async function getOrCreateAccountLinkageClusterHash(
  db: PgQueryable,
  params: Readonly<{
    signalKind: AccountLinkageSignalKind;
    clusterKey: string;
    proposedClusterHash: string;
    updatedAt: string;
  }>,
): Promise<string> {
  const result = await db.query<{ cluster_hash: string }>(
    `INSERT INTO settlement_account_linkage_clusters (
       signal_kind, cluster_key, cluster_hash, flagged, created_at, updated_at
     ) VALUES ($1, $2, $3, FALSE, $4, $4)
     ON CONFLICT (signal_kind, cluster_key) DO UPDATE SET
       cluster_key = EXCLUDED.cluster_key
     RETURNING cluster_hash`,
    [params.signalKind, params.clusterKey, params.proposedClusterHash, params.updatedAt],
  );
  const clusterHash = result.rows[0]?.cluster_hash;
  if (!clusterHash) throw new Error("Account-linkage cluster mapping did not return an opaque identifier.");
  return clusterHash;
}

export async function setAccountLinkageClusterFlagged(
  db: PgQueryable,
  params: Readonly<{
    signalKind: AccountLinkageSignalKind;
    clusterKey: string;
    flagged: boolean;
    updatedAt: string;
  }>,
): Promise<void> {
  await db.query(
    `UPDATE settlement_account_linkage_clusters
     SET flagged = $3, updated_at = $4
     WHERE signal_kind = $1 AND cluster_key = $2`,
    [params.signalKind, params.clusterKey, params.flagged, params.updatedAt],
  );
}
