import type { PgQueryable } from "@chase-sets/event-core-postgres";

// Ordering and Settlement have independent subscription transactions. Take
// the same account locks before either side reads the other's committed work.
export async function lockPayoutReviewAccounts(db: PgQueryable, accountIds: readonly string[]) {
  await db.query(
    `SELECT pg_advisory_xact_lock(lock_key)
     FROM (
       SELECT DISTINCT hashtextextended('pricing:payout-review:' || account_id, 0) AS lock_key
       FROM unnest($1::text[]) AS accounts(account_id)
       ORDER BY lock_key
     ) AS locks`,
    [accountIds],
  );
}
