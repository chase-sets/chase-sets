import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildWalletProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "settlement.wallet.opened": async (event) => {
      const data = event.data as {
        accountId: string;
        currencyCode: string;
        openedAt: string;
      };

      await db.query(
        `INSERT INTO settlement_wallet_pages (
           account_id,
           currency_code,
           pending_balance_amount,
           available_balance_amount,
           total_credited_amount,
           total_debited_amount,
           negative_balance_status,
           negative_balance_started_at,
           collections_escalated_at,
           opened_at,
           updated_at
         ) VALUES (
           $1, $2, 0, 0, 0, 0, 'in-good-standing', NULL, NULL, $3, $3
         )
         ON CONFLICT (account_id) DO UPDATE
         SET currency_code = EXCLUDED.currency_code,
             opened_at = COALESCE(settlement_wallet_pages.opened_at, EXCLUDED.opened_at),
             updated_at = EXCLUDED.updated_at`,
        [data.accountId, data.currencyCode, data.openedAt],
      );
    },
    "settlement.wallet.ledger-entry-posted": async (event) => {
      const data = event.data as {
        accountId: string;
        ledgerEntryId: string;
        kind: string;
        direction: string;
        amount: string;
        currencyCode: string;
        fundsStatus: string;
        orderId: string | null;
        paymentId: string | null;
        payoutId: string | null;
        description: string | null;
        postedAt: string;
      };
      const signedAmount = data.direction === "credit" ? data.amount : `-${data.amount}`;
      const pendingDelta = data.fundsStatus === "pending" ? signedAmount : "0.00";
      const availableDelta = data.fundsStatus === "available" ? signedAmount : "0.00";
      const creditedDelta = data.direction === "credit" ? data.amount : "0.00";
      const debitedDelta = data.direction === "debit" ? data.amount : "0.00";

      const insertedEntry = await db.query(
        `INSERT INTO settlement_ledger_entry_pages (
           ledger_entry_id,
           account_id,
           kind,
           direction,
           amount,
           currency_code,
           funds_status,
           order_id,
           payment_id,
           payout_id,
           description,
           posted_at,
           available_at,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, $12
         )
         ON CONFLICT (ledger_entry_id) DO NOTHING
         RETURNING ledger_entry_id`,
        [
          data.ledgerEntryId,
          data.accountId,
          data.kind,
          data.direction,
          data.amount,
          data.currencyCode,
          data.fundsStatus,
          data.orderId,
          data.paymentId,
          data.payoutId,
          data.description,
          data.postedAt,
        ],
      );

      if (insertedEntry.rowCount === 0) {
        return;
      }

      await db.query(
        `UPDATE settlement_wallet_pages
         SET pending_balance_amount = pending_balance_amount + $2::numeric,
             available_balance_amount = available_balance_amount + $3::numeric,
             total_credited_amount = total_credited_amount + $4::numeric,
             total_debited_amount = total_debited_amount + $5::numeric,
             updated_at = $6
         WHERE account_id = $1`,
        [data.accountId, pendingDelta, availableDelta, creditedDelta, debitedDelta, data.postedAt],
      );
    },
    "settlement.wallet.ledger-entry-available-recorded": async (event) => {
      const data = event.data as {
        accountId: string;
        ledgerEntryId: string;
        amount: string;
        availableAt: string;
      };

      const releasedEntry = await db.query(
        `UPDATE settlement_ledger_entry_pages
         SET funds_status = 'available',
             available_at = $2,
             updated_at = $2
         WHERE ledger_entry_id = $1
           AND funds_status <> 'available'`,
        [data.ledgerEntryId, data.availableAt],
      );

      if (releasedEntry.rowCount === 0) {
        return;
      }

      await db.query(
        `UPDATE settlement_wallet_pages
         SET pending_balance_amount = pending_balance_amount - $2::numeric,
             available_balance_amount = available_balance_amount + $2::numeric,
             updated_at = $3
         WHERE account_id = $1`,
        [data.accountId, data.amount, data.availableAt],
      );
    },
    "settlement.wallet.negative-balance-entered": async (event) => {
      const data = event.data as {
        accountId: string;
        enteredAt: string;
      };

      await db.query(
        `UPDATE settlement_wallet_pages
         SET negative_balance_status = 'negative',
             negative_balance_started_at = $2,
             collections_escalated_at = NULL,
             updated_at = $2
         WHERE account_id = $1`,
        [data.accountId, data.enteredAt],
      );
    },
    "settlement.wallet.negative-balance-collections-opened": async (event) => {
      const data = event.data as {
        accountId: string;
        negativeSince: string;
        openedAt: string;
      };

      await db.query(
        `UPDATE settlement_wallet_pages
         SET negative_balance_status = 'collections',
             negative_balance_started_at = $2,
             collections_escalated_at = $3,
             updated_at = $3
         WHERE account_id = $1`,
        [data.accountId, data.negativeSince, data.openedAt],
      );
    },
    "settlement.wallet.negative-balance-recovered": async (event) => {
      const data = event.data as {
        accountId: string;
        recoveredAt: string;
      };

      await db.query(
        `UPDATE settlement_wallet_pages
         SET negative_balance_status = 'in-good-standing',
             negative_balance_started_at = NULL,
             collections_escalated_at = NULL,
             updated_at = $2
         WHERE account_id = $1`,
        [data.accountId, data.recoveredAt],
      );
    },
    "settlement.wallet.spend-hold-placed": async (event) => {
      const data = event.data as {
        accountId: string;
        holdId: string;
        paymentId: string | null;
        amount: string;
        currencyCode: string;
        placedAt: string;
        expiresAt: string | null;
      };

      await db.query(
        `INSERT INTO settlement_wallet_spend_holds (
           hold_id,
           account_id,
           payment_id,
           amount,
           currency_code,
           status,
           placed_at,
           expires_at,
           released_at,
           release_reason,
           updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'active', $6, $7, NULL, NULL, $6
         )
         ON CONFLICT (hold_id) DO NOTHING`,
        [data.holdId, data.accountId, data.paymentId, data.amount, data.currencyCode, data.placedAt, data.expiresAt],
      );
    },
    "settlement.wallet.spend-hold-released": async (event) => {
      const data = event.data as {
        accountId: string;
        holdId: string;
        reason: string;
        releasedAt: string;
      };

      await db.query(
        `UPDATE settlement_wallet_spend_holds
         SET status = 'released',
             release_reason = $2,
             released_at = $3,
             updated_at = $3
         WHERE hold_id = $1
           AND status = 'active'`,
        [data.holdId, data.reason, data.releasedAt],
      );
    },
  };
}
