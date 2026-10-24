import { withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { receiptQuery } from "../api/runtime";
import { ebayReceiptRetention } from "../domain/policy";

export function createEbayReceiptExpiryStore(db: PgTransactionalPool) {
  return {
    async cutoff() {
      return (await receiptQuery<{ at: Date }>(db, "SELECT statement_timestamp() AS at")).rows[0]!.at.toISOString();
    },
    async batch(cutoff: string) {
      return withPgTransaction(db, async (tx) => {
        await receiptQuery(tx, "SET LOCAL statement_timeout = '1000ms'");
        const deleted = await receiptQuery(
          tx,
          `WITH candidates AS (
          SELECT notification_id, expires_at FROM channels_ebay_account_deletion_receipts
          WHERE expires_at <= $1::timestamptz ORDER BY expires_at, notification_id
          LIMIT $2 FOR UPDATE SKIP LOCKED
        ) DELETE FROM channels_ebay_account_deletion_receipts receipt USING candidates
          WHERE receipt.notification_id = candidates.notification_id AND receipt.expires_at = candidates.expires_at
            AND receipt.expires_at <= $1::timestamptz RETURNING receipt.notification_id`,
          [cutoff, ebayReceiptRetention.batchSize],
        );
        const remaining = await receiptQuery<{ remaining: boolean }>(
          tx,
          `SELECT EXISTS (
          SELECT 1 FROM channels_ebay_account_deletion_receipts WHERE expires_at <= $1::timestamptz
          ORDER BY expires_at, notification_id LIMIT 1) AS remaining`,
          [cutoff],
        );
        return { deleted: deleted.rows.length, remaining: remaining.rows[0]!.remaining };
      });
    },
  };
}
