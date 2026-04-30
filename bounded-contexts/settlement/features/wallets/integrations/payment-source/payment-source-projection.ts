import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId, LedgerEntryId, PaymentId } from "@chase-sets/primitives/typed-ids";
import type { WalletServices } from "../../api/runtime";
import {
  compareMoney,
  normalizeCurrencyCode,
  SettlementDomainError,
} from "../../../../support/runtime-support/common";

async function debitAppliedBalanceCredit(
  wallets: WalletServices | undefined,
  data: Readonly<{
    paymentId: string;
    buyerAccountId: string;
    amount: string;
    currencyCode: string;
    capturedAt: string;
  }>,
  event: TransportEvent,
) {
  if (!wallets || compareMoney(data.amount, "0.00") === 0) {
    return;
  }

  try {
    await wallets.postEntry(
      {
        accountId: data.buyerAccountId as AccountId,
        ledgerEntryId: `led_balance_credit_${data.paymentId}` as LedgerEntryId,
        kind: "platform-purchase",
        direction: "debit",
        amount: data.amount,
        currencyCode: normalizeCurrencyCode(data.currencyCode),
        fundsStatus: "available",
        paymentId: data.paymentId as PaymentId,
        description: `Applied wallet balance to payment ${data.paymentId}`,
        postedAt: data.capturedAt,
      },
      {
        tenantId: event.tenantId,
        audit: event.audit,
        trace: event.trace,
      },
    );
  } catch (error) {
    if (
      error instanceof SettlementDomainError &&
      error.message === "Ledger entry has already been posted."
    ) {
      return;
    }
    throw error;
  }
}

export function buildSettlementPaymentInputProjectionHandlers(
  db: PgQueryable,
  wallets?: WalletServices,
): ProjectorHandlerMap {
  return {
    "payments.payment-created": async (event) => {
      const data = event.data as {
        paymentId: string;
        buyerAccountId: string;
        orderIds: string[];
        amount: string;
        balanceCreditAmount?: string;
        processorAmount?: string;
        currencyCode: string;
        processorName: string;
        processorPaymentReference: string;
        processorStatus: string;
        createdAt: string;
      };

      await db.query(
        `INSERT INTO settlement_payment_sources (
           payment_id,
           buyer_account_id,
           order_ids,
           amount,
           balance_credit_amount,
           processor_amount,
           currency_code,
           processor_name,
           processor_payment_reference,
           processor_status,
           status,
           failure_code,
           failure_message,
           created_at,
           updated_at,
           captured_at,
           failed_at,
           cancelled_at,
           last_stream_version
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending-confirmation', NULL, NULL, $11, $11, NULL, NULL, NULL, $12
         )
         ON CONFLICT (payment_id) DO UPDATE
         SET buyer_account_id = EXCLUDED.buyer_account_id,
             order_ids = EXCLUDED.order_ids,
             amount = EXCLUDED.amount,
             balance_credit_amount = EXCLUDED.balance_credit_amount,
             processor_amount = EXCLUDED.processor_amount,
             currency_code = EXCLUDED.currency_code,
             processor_name = EXCLUDED.processor_name,
             processor_payment_reference = EXCLUDED.processor_payment_reference,
             processor_status = EXCLUDED.processor_status,
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE settlement_payment_sources.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.paymentId,
          data.buyerAccountId,
          JSON.stringify(data.orderIds),
          data.amount,
          data.balanceCreditAmount ?? "0.00",
          data.processorAmount ?? data.amount,
          data.currencyCode,
          data.processorName,
          data.processorPaymentReference,
          data.processorStatus,
          data.createdAt,
          event.streamVersion,
        ],
      );
    },
    "payments.payment-authorized": async (event) => {
      const data = event.data as {
        paymentId: string;
        processorStatus: string;
        authorizedAt: string;
      };

      await db.query(
        `UPDATE settlement_payment_sources
         SET processor_status = $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE payment_id = $1
           AND last_stream_version < $4`,
        [data.paymentId, data.processorStatus, data.authorizedAt, event.streamVersion],
      );
    },
    "payments.payment-captured": async (event) => {
      const data = event.data as {
        paymentId: string;
        buyerAccountId: string;
        balanceCreditAmount?: string;
        currencyCode?: string;
        processorStatus: string;
        capturedAt: string;
      };

      await db.query(
        `UPDATE settlement_payment_sources
         SET processor_status = $2,
             status = 'captured',
             failure_code = NULL,
             failure_message = NULL,
             captured_at = $3,
             updated_at = $3,
             last_stream_version = $4
         WHERE payment_id = $1
           AND last_stream_version < $4`,
        [data.paymentId, data.processorStatus, data.capturedAt, event.streamVersion],
      );

      await debitAppliedBalanceCredit(
        wallets,
        {
          paymentId: data.paymentId,
          buyerAccountId: data.buyerAccountId,
          amount: data.balanceCreditAmount ?? "0.00",
          currencyCode: data.currencyCode ?? "usd",
          capturedAt: data.capturedAt,
        },
        event,
      );
    },
    "payments.payment-failed": async (event) => {
      const data = event.data as {
        paymentId: string;
        processorStatus: string;
        failureCode: string | null;
        failureMessage: string | null;
        failedAt: string;
      };

      await db.query(
        `UPDATE settlement_payment_sources
         SET processor_status = $2,
             status = 'failed',
             failure_code = $3,
             failure_message = $4,
             failed_at = $5,
             updated_at = $5,
             last_stream_version = $6
         WHERE payment_id = $1
           AND last_stream_version < $6`,
        [
          data.paymentId,
          data.processorStatus,
          data.failureCode,
          data.failureMessage,
          data.failedAt,
          event.streamVersion,
        ],
      );
    },
    "payments.payment-cancelled": async (event) => {
      const data = event.data as {
        paymentId: string;
        cancelledAt: string;
      };

      await db.query(
        `UPDATE settlement_payment_sources
         SET status = 'cancelled',
             cancelled_at = $2,
             updated_at = $2,
             last_stream_version = $3
         WHERE payment_id = $1
           AND last_stream_version < $3`,
        [data.paymentId, data.cancelledAt, event.streamVersion],
      );
    },
    "payments.refund-requested": async (event) => {
      const data = event.data as {
        refundId: string;
        paymentId: string;
        orderIds: string[];
        amount: string;
        currencyCode: string;
        reason: string;
        processorName: string;
        requestedAt: string;
      };

      await db.query(
        `INSERT INTO settlement_refund_sources (
           refund_id,
           payment_id,
           order_ids,
           amount,
           currency_code,
           reason,
           processor_name,
           processor_status,
           processor_refund_reference,
           status,
           failure_code,
           failure_message,
           requested_at,
           updated_at,
           issued_at,
           failed_at,
           last_stream_version
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'requested', NULL, 'requested', NULL, NULL, $8, $8, NULL, NULL, $9
         )
         ON CONFLICT (refund_id) DO UPDATE
         SET payment_id = EXCLUDED.payment_id,
             order_ids = EXCLUDED.order_ids,
             amount = EXCLUDED.amount,
             currency_code = EXCLUDED.currency_code,
             reason = EXCLUDED.reason,
             processor_name = EXCLUDED.processor_name,
             processor_status = EXCLUDED.processor_status,
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE settlement_refund_sources.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.refundId,
          data.paymentId,
          JSON.stringify(data.orderIds),
          data.amount,
          data.currencyCode,
          data.reason,
          data.processorName,
          data.requestedAt,
          event.streamVersion,
        ],
      );
    },
    "payments.refund-issued": async (event) => {
      const data = event.data as {
        refundId: string;
        processorStatus: string;
        processorRefundReference: string;
        issuedAt: string;
      };

      await db.query(
        `UPDATE settlement_refund_sources
         SET processor_status = $2,
             processor_refund_reference = $3,
             status = 'issued',
             failure_code = NULL,
             failure_message = NULL,
             issued_at = $4,
             updated_at = $4,
             last_stream_version = $5
         WHERE refund_id = $1
           AND last_stream_version < $5`,
        [
          data.refundId,
          data.processorStatus,
          data.processorRefundReference,
          data.issuedAt,
          event.streamVersion,
        ],
      );
    },
    "payments.refund-failed": async (event) => {
      const data = event.data as {
        refundId: string;
        processorStatus: string;
        failureCode: string | null;
        failureMessage: string | null;
        failedAt: string;
      };

      await db.query(
        `UPDATE settlement_refund_sources
         SET processor_status = $2,
             status = 'failed',
             failure_code = $3,
             failure_message = $4,
             failed_at = $5,
             updated_at = $5,
             last_stream_version = $6
         WHERE refund_id = $1
           AND last_stream_version < $6`,
        [
          data.refundId,
          data.processorStatus,
          data.failureCode,
          data.failureMessage,
          data.failedAt,
          event.streamVersion,
        ],
      );
    },
  };
}
