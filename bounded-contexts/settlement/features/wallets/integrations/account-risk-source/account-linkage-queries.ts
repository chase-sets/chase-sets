import type { AccountLinkageSignalKind } from "@chase-sets/event-core/account-linkage-facts";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountLinkageFlagPolicyValue } from "../../domain/account-linkage-policy";

export type AccountLinkageClusterCandidate = Readonly<{
  signalKind: AccountLinkageSignalKind;
  clusterKey: string;
  accountIds: readonly string[];
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
  if (branches.length === 0) return [];

  const result = await db.query<{
    signal_kind: AccountLinkageSignalKind;
    cluster_key: string;
    account_ids: string[];
  }>(
    `WITH eligible AS (
      ${branches.join("\nUNION ALL\n")}
    )
    SELECT signal_kind, cluster_key, account_ids
    FROM eligible
    WHERE $2::text IS NULL OR (signal_kind, cluster_key) > ($2::text, $3::text)
    ORDER BY signal_kind, cluster_key
    LIMIT $4`,
    [policy.minimumClusterSize, params.after?.signalKind ?? null, params.after?.clusterKey ?? null, params.limit],
  );
  return result.rows.map((row) => ({
    signalKind: row.signal_kind,
    clusterKey: row.cluster_key,
    accountIds: row.account_ids,
  }));
}
