import { withPgTransaction, type PgTransactionalPool, type PgQueryable } from "@chase-sets/event-core-postgres";
import { fundingRule, type WalletFundingId, type WalletFundingQuote, type WalletFundingState } from "../domain/domain";
import { compareMoney, addMoney } from "../../../support/runtime-support/common";
import type { WalletFundingLimits } from "../api/limits-policy";

export async function reserveWalletFundingCreation(
  pool: PgTransactionalPool,
  quote: WalletFundingQuote,
  limits: WalletFundingLimits,
) {
  return withPgTransaction(pool, async (db: PgQueryable) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `payments.wallet-funding-limits:${quote.accountId}`,
    ]);
    const prior = await db.query<{ account_id: string; requested_amount: string; released: boolean }>(
      "SELECT account_id, requested_amount::text, released FROM payments_wallet_funding_creation_reservations WHERE funding_id = $1",
      [quote.fundingId],
    );
    if (prior.rows[0]) {
      fundingRule(
        prior.rows[0].account_id === quote.accountId &&
          prior.rows[0].requested_amount === quote.requestedAmount &&
          !prior.rows[0].released,
        "funding_creation_identity_conflict",
      );
      return;
    }
    const total = await db.query<{ amount: string }>(
      `SELECT COALESCE(sum(requested_amount), 0)::text AS amount
      FROM payments_wallet_funding_creation_reservations WHERE account_id = $1 AND NOT released
      AND created_at > now() - ($2::text || ' days')::interval`,
      [quote.accountId, limits.rollingWindowDays],
    );
    fundingRule(
      compareMoney(
        addMoney(total.rows[0]?.amount ?? "0.00", quote.requestedAmount),
        limits.rollingThirtyDayMaximumAmount,
      ) <= 0,
      "funding_rolling_limit_exceeded",
    );
    await db.query(
      `INSERT INTO payments_wallet_funding_creation_reservations (funding_id, account_id, requested_amount, created_at)
      VALUES ($1,$2,$3,now())`,
      [quote.fundingId, quote.accountId, quote.requestedAmount],
    );
  });
}
export async function releaseWalletFundingCreation(db: PgQueryable, fundingId: WalletFundingId) {
  await db.query("UPDATE payments_wallet_funding_creation_reservations SET released = true WHERE funding_id = $1", [
    fundingId,
  ]);
}
export async function listWalletFundings(db: PgQueryable, accountId: string) {
  const rows = await db.query<{ funding_id: WalletFundingId; state: WalletFundingState }>(
    "SELECT funding_id, state FROM payments_wallet_funding_pages WHERE account_id = $1 ORDER BY funding_id DESC LIMIT 100",
    [accountId],
  );
  return rows.rows;
}
export async function fundingIdForProcessorReference(db: PgQueryable, reference: string) {
  const rows = await db.query<{ funding_id: WalletFundingId }>(
    "SELECT funding_id FROM payments_wallet_funding_pages WHERE processor_payment_reference = $1",
    [reference],
  );
  return rows.rows[0]?.funding_id ?? null;
}
