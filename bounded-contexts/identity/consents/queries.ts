import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
} from "../read-model-support/list-query";

export type ConsentRow = Readonly<{
  consent_id: string;
  subject_type: string;
  user_id: string | null;
  account_id: string | null;
  policy_key: string;
  policy_version: string;
  recorded_at: string;
  updated_at: string;
}>;

export async function listConsents(
  db: PgQueryable,
  params: ListParams = {},
) {
  const query = buildFilteredQuery(
    "identity_consents",
    params,
    ["policy_key", "policy_version", "subject_type"],
    "recorded_at DESC",
  );
  return executeListQuery<ConsentRow>(db, query.countSql, query.listSql, query.values);
}
