import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import { accountBadgeKeys, type AccountBadgeKey } from "../domain/domain";

export type AccountRow = Readonly<{
  account_id: string;
  name: string;
  display_name: string;
  account_type: string;
  status: string;
  badges: AccountBadgeKey[];
  founder_number: number | null;
  founders_window_started_at: string | null;
  founders_window_ends_at: string | null;
  updated_at: string;
}>;

type AccountQueryRow = Omit<AccountRow, "badges"> & Readonly<{ badges: unknown }>;

const accountPublicColumns = `account_id,
  name,
  display_name,
  account_type,
  status,
  badges,
  founder_number,
  founders_window_started_at,
  founders_window_ends_at,
  updated_at`;

function normalizeAccountBadges(value: unknown): AccountBadgeKey[] {
  const badges = Array.isArray(value) ? value : [];
  return badges.filter(
    (badgeKey): badgeKey is AccountBadgeKey =>
      typeof badgeKey === "string" && accountBadgeKeys.includes(badgeKey as AccountBadgeKey),
  );
}

function mapAccountRow(row: AccountQueryRow): AccountRow {
  return {
    account_id: row.account_id,
    name: row.name,
    display_name: row.display_name,
    account_type: row.account_type,
    status: row.status,
    badges: normalizeAccountBadges(row.badges),
    founder_number: row.founder_number,
    founders_window_started_at: row.founders_window_started_at,
    founders_window_ends_at: row.founders_window_ends_at,
    updated_at: row.updated_at,
  };
}

export async function listAccounts(db: PgQueryable, params: ListParams = {}) {
  const query = buildFilteredQuery(
    `(SELECT ${accountPublicColumns}
      FROM identity_accounts) AS identity_account_public_rows`,
    params,
    ["name", "display_name"],
    "display_name ASC",
  );
  const result = await executeListQuery<AccountQueryRow>(
    db,
    query.countSql,
    query.listSql,
    query.countValues,
    query.listValues,
  );
  return {
    ...result,
    items: result.items.map(mapAccountRow),
  };
}

export async function getAccount(db: PgQueryable, accountId: string) {
  const result = await db.query<AccountQueryRow>(
    `SELECT ${accountPublicColumns}
     FROM identity_accounts
     WHERE account_id = $1`,
    [accountId],
  );
  const row = result.rows[0] ?? null;
  return row ? mapAccountRow(row) : null;
}
