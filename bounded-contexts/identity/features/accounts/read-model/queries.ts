import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
} from "../../../support/read-model-support/list-query";

export type AccountRow = Readonly<{
  account_id: string;
  name: string;
  display_name: string;
  account_type: string;
  status: string;
  updated_at: string;
}>;

export async function listAccounts(
  db: PgQueryable,
  params: ListParams = {},
) {
  const query = buildFilteredQuery(
    "identity_accounts",
    params,
    ["name", "display_name"],
    "display_name ASC",
  );
  return executeListQuery<AccountRow>(db, query.countSql, query.listSql, query.values);
}

export async function getAccount(db: PgQueryable, accountId: string) {
  const result = await db.query<AccountRow>(
    `SELECT * FROM identity_accounts WHERE account_id = $1`,
    [accountId],
  );
  return result.rows[0] ?? null;
}
