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

function normalizeAccountBadges(value: unknown): AccountBadgeKey[] {
  const badges = Array.isArray(value) ? value : [];
  return badges.filter(
    (badgeKey): badgeKey is AccountBadgeKey =>
      typeof badgeKey === "string" && accountBadgeKeys.includes(badgeKey as AccountBadgeKey),
  );
}

function mapAccountRow(row: AccountQueryRow): AccountRow {
  return {
    ...row,
    badges: normalizeAccountBadges(row.badges),
  };
}

export async function listAccounts(db: PgQueryable, params: ListParams = {}) {
  const query = buildFilteredQuery("identity_accounts", params, ["name", "display_name"], "display_name ASC");
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
  const result = await db.query<AccountQueryRow>(`SELECT * FROM identity_accounts WHERE account_id = $1`, [accountId]);
  const row = result.rows[0] ?? null;
  return row ? mapAccountRow(row) : null;
}
