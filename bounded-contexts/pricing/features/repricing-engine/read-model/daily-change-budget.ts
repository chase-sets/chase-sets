import type { PgQueryable } from "@chase-sets/event-core-postgres";

export async function reserveDailyChangesInTransaction(
  client: PgQueryable,
  accountId: string,
  day: string,
  limit: number,
  requested: number,
  beforeWrite?: () => Promise<void>,
): Promise<number> {
  if (requested === 0) return 0;
  await client.query(
    `INSERT INTO pricing_repricing_daily_change_budgets (seller_account_id, budget_day, changes_reserved, updated_at)
     VALUES ($1, $2, 0, now()) ON CONFLICT (seller_account_id, budget_day) DO NOTHING`,
    [accountId, day],
  );
  const current = await client.query<{ changes_reserved: number }>(
    `SELECT changes_reserved FROM pricing_repricing_daily_change_budgets
     WHERE seller_account_id = $1 AND budget_day = $2 FOR UPDATE`,
    [accountId, day],
  );
  const reserved = Math.min(Math.max(0, limit - Number(current.rows[0]!.changes_reserved)), requested);
  if (reserved > 0) {
    await beforeWrite?.();
    await client.query(
      `UPDATE pricing_repricing_daily_change_budgets SET changes_reserved = changes_reserved + $3, updated_at = now()
       WHERE seller_account_id = $1 AND budget_day = $2`,
      [accountId, day, reserved],
    );
  }
  return reserved;
}

export async function refundDailyChanges(db: PgQueryable, accountId: string, day: string, amount: number) {
  await db.query(
    `UPDATE pricing_repricing_daily_change_budgets SET changes_reserved = GREATEST(0, changes_reserved - $3), updated_at = now()
     WHERE seller_account_id = $1 AND budget_day = $2`,
    [accountId, day, amount],
  );
}
