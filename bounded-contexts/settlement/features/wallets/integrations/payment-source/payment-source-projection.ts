import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId, LedgerEntryId, OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";
import {
  allocateMoneyByLargestRemainder,
  centsToMoneyAmount,
  moneyToCents,
  roundRational,
} from "@chase-sets/primitives/money";
import type { WalletServices } from "../../api/runtime";
import { compareMoney, normalizeCurrencyCode, SettlementDomainError } from "../../../../support/runtime-support/common";

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
    if (error instanceof SettlementDomainError && error.message === "Ledger entry has already been posted.") {
      return;
    }
    throw error;
  }
}

type SellerPayoutComponent = Readonly<{
  orderId: string;
  sellerAccountId: string;
  sellerItemNetAmount: string;
  shippingAllowanceAmount: string;
  sellerShippingPayoutAmount: string;
  sellerPayoutAmount: string;
}>;

function normalizeSellerPayoutComponents(value: unknown): SellerPayoutComponent[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((component) => {
    if (!component || typeof component !== "object") {
      return [];
    }
    const candidate = component as Partial<SellerPayoutComponent>;
    if (typeof candidate.orderId !== "string" || typeof candidate.sellerAccountId !== "string") {
      return [];
    }
    return [
      {
        orderId: candidate.orderId,
        sellerAccountId: candidate.sellerAccountId,
        sellerItemNetAmount: candidate.sellerItemNetAmount ?? "0.00",
        shippingAllowanceAmount: candidate.shippingAllowanceAmount ?? "0.00",
        sellerShippingPayoutAmount: candidate.sellerShippingPayoutAmount ?? candidate.shippingAllowanceAmount ?? "0.00",
        sellerPayoutAmount: candidate.sellerPayoutAmount ?? "0.00",
      },
    ];
  });
}

async function postWalletEntryIdempotently(
  wallets: WalletServices,
  params: Parameters<WalletServices["postEntry"]>[0],
  context: Parameters<WalletServices["postEntry"]>[1],
) {
  try {
    await wallets.postEntry(params, context);
  } catch (error) {
    if (error instanceof SettlementDomainError && error.message === "Ledger entry has already been posted.") {
      return;
    }
    throw error;
  }
}

async function creditSellerPayouts(
  wallets: WalletServices | undefined,
  data: Readonly<{
    paymentId: string;
    currencyCode: string;
    capturedAt: string;
    sellerPayouts: readonly SellerPayoutComponent[];
  }>,
  event: TransportEvent,
) {
  if (!wallets) {
    return;
  }

  const context = {
    tenantId: event.tenantId,
    audit: event.audit,
    trace: event.trace,
  };

  for (const payout of data.sellerPayouts) {
    const sellerAccountId = payout.sellerAccountId as AccountId;
    const paymentId = data.paymentId as PaymentId;

    if (compareMoney(payout.sellerItemNetAmount, "0.00") > 0) {
      await postWalletEntryIdempotently(
        wallets,
        {
          accountId: sellerAccountId,
          ledgerEntryId: `led_sale_${data.paymentId}_${payout.orderId}` as LedgerEntryId,
          kind: "sale",
          direction: "credit",
          amount: payout.sellerItemNetAmount,
          currencyCode: normalizeCurrencyCode(data.currencyCode),
          fundsStatus: "pending",
          orderId: payout.orderId as OrderId,
          paymentId,
          description: `Item sale proceeds for order ${payout.orderId}`,
          postedAt: data.capturedAt,
        },
        context,
      );
    }

    if (compareMoney(payout.sellerShippingPayoutAmount, "0.00") > 0) {
      await postWalletEntryIdempotently(
        wallets,
        {
          accountId: sellerAccountId,
          ledgerEntryId: `led_shipping_allowance_${data.paymentId}_${payout.orderId}` as LedgerEntryId,
          kind: "rebate",
          direction: "credit",
          amount: payout.sellerShippingPayoutAmount,
          currencyCode: normalizeCurrencyCode(data.currencyCode),
          fundsStatus: "pending",
          orderId: payout.orderId as OrderId,
          paymentId,
          description: `Shipping allowance for order ${payout.orderId}`,
          postedAt: data.capturedAt,
        },
        context,
      );
    }
  }
}

function allocateRefundDebitAmounts(
  debitAmount: string,
  paymentAmount: string,
  sellerPayouts: readonly SellerPayoutComponent[],
) {
  const debitCents = moneyToCents(debitAmount);
  const paymentCents = moneyToCents(paymentAmount);
  if (debitCents === 0n || paymentCents === 0n || sellerPayouts.length === 0) {
    return sellerPayouts.map(() => "0.00");
  }

  const weights = sellerPayouts.map((payout) => moneyToCents(payout.sellerPayoutAmount));
  const sellerExposureCents = weights.reduce((sum, weight) => sum + weight, 0n);
  if (sellerExposureCents === 0n) {
    return sellerPayouts.map(() => "0.00");
  }

  const proratedDebitCents = roundRational(sellerExposureCents * debitCents, paymentCents, "nearest");
  const cappedDebitCents = [proratedDebitCents, sellerExposureCents, debitCents].reduce((minimum, value) =>
    value < minimum ? value : minimum,
  );

  return allocateMoneyByLargestRemainder(centsToMoneyAmount(cappedDebitCents), weights);
}

async function debitSellerRefunds(
  wallets: WalletServices | undefined,
  data: Readonly<{
    paymentId: string;
    paymentAmount: string;
    refundAmount: string;
    currencyCode: string;
    refundedAt: string;
    sellerPayouts: readonly SellerPayoutComponent[];
  }>,
  event: TransportEvent,
) {
  if (!wallets) {
    return;
  }

  const context = {
    tenantId: event.tenantId,
    audit: event.audit,
    trace: event.trace,
  };

  const debitAmounts = allocateRefundDebitAmounts(data.refundAmount, data.paymentAmount, data.sellerPayouts);

  for (const [index, payout] of data.sellerPayouts.entries()) {
    const debitAmount = debitAmounts[index] ?? "0.00";
    if (compareMoney(debitAmount, "0.00") <= 0) {
      continue;
    }

    await postWalletEntryIdempotently(
      wallets,
      {
        accountId: payout.sellerAccountId as AccountId,
        ledgerEntryId: `led_refund_${data.paymentId}_${payout.orderId}_${event.streamVersion}` as LedgerEntryId,
        kind: "refund",
        direction: "debit",
        amount: debitAmount,
        currencyCode: normalizeCurrencyCode(data.currencyCode),
        fundsStatus: "available",
        orderId: payout.orderId as OrderId,
        paymentId: data.paymentId as PaymentId,
        description: `Refund debit for payment ${data.paymentId}`,
        postedAt: data.refundedAt,
      },
      context,
    );
  }
}

function shouldReleaseDisputeHold(disputeStatus: string | null, disputeMessage: string | null) {
  const eventType = disputeStatus?.toLowerCase() ?? "";
  const providerStatus = disputeMessage?.toLowerCase() ?? "";
  return eventType.includes("closed") && (providerStatus === "won" || providerStatus === "warning_closed");
}

async function postSellerDisputeLedgerEntries(
  wallets: WalletServices | undefined,
  data: Readonly<{
    paymentId: string;
    paymentAmount: string;
    disputeAmount: string;
    currencyCode: string;
    disputeStatus: string | null;
    disputeMessage: string | null;
    disputedAt: string;
    sellerPayouts: readonly SellerPayoutComponent[];
  }>,
  event: TransportEvent,
) {
  if (!wallets) {
    return;
  }

  const context = {
    tenantId: event.tenantId,
    audit: event.audit,
    trace: event.trace,
  };
  const releaseHold = shouldReleaseDisputeHold(data.disputeStatus, data.disputeMessage);

  const holdAmounts = allocateRefundDebitAmounts(data.disputeAmount, data.paymentAmount, data.sellerPayouts);

  for (const [index, payout] of data.sellerPayouts.entries()) {
    const holdAmount = holdAmounts[index] ?? "0.00";
    if (compareMoney(holdAmount, "0.00") <= 0) {
      continue;
    }

    const baseEntry = {
      accountId: payout.sellerAccountId as AccountId,
      amount: holdAmount,
      currencyCode: normalizeCurrencyCode(data.currencyCode),
      fundsStatus: "available" as const,
      orderId: payout.orderId as OrderId,
      paymentId: data.paymentId as PaymentId,
      postedAt: data.disputedAt,
    };

    await postWalletEntryIdempotently(
      wallets,
      {
        ...baseEntry,
        ledgerEntryId: `led_dispute_hold_${data.paymentId}_${payout.orderId}` as LedgerEntryId,
        kind: "adjustment",
        direction: "debit",
        description: `Dispute hold for payment ${data.paymentId}`,
      },
      context,
    );

    if (releaseHold) {
      await postWalletEntryIdempotently(
        wallets,
        {
          ...baseEntry,
          ledgerEntryId: `led_dispute_release_${data.paymentId}_${payout.orderId}` as LedgerEntryId,
          kind: "adjustment",
          direction: "credit",
          description: `Dispute hold released for payment ${data.paymentId}`,
        },
        context,
      );
    }
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
        sellerPayouts?: unknown;
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
           seller_payouts,
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
           refunded_at,
           disputed_at,
           last_stream_version
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending-confirmation', NULL, NULL, $12, $12, NULL, NULL, NULL, NULL, NULL, $13
         )
         ON CONFLICT (payment_id) DO UPDATE
         SET buyer_account_id = EXCLUDED.buyer_account_id,
             order_ids = EXCLUDED.order_ids,
             seller_payouts = EXCLUDED.seller_payouts,
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
          JSON.stringify(normalizeSellerPayoutComponents(data.sellerPayouts)),
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
        sellerPayouts?: unknown;
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
      await creditSellerPayouts(
        wallets,
        {
          paymentId: data.paymentId,
          currencyCode: data.currencyCode ?? "usd",
          capturedAt: data.capturedAt,
          sellerPayouts: normalizeSellerPayoutComponents(data.sellerPayouts),
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
    "payments.payment-refunded": async (event) => {
      const data = event.data as {
        paymentId: string;
        amount: string;
        currencyCode: string;
        processorStatus: string;
        refundedAmount?: string;
        sellerPayouts?: unknown;
        refundedAt: string;
      };

      const existing = await db.query<{
        amount: string;
        seller_payouts: unknown;
      }>(
        `SELECT amount::text AS amount, seller_payouts
         FROM settlement_payment_sources
         WHERE payment_id = $1`,
        [data.paymentId],
      );
      const paymentAmount = existing.rows[0]?.amount ?? data.amount;
      const paymentStatus =
        data.refundedAmount && compareMoney(data.refundedAmount, paymentAmount) < 0 ? "partially-refunded" : "refunded";
      const sellerPayouts = normalizeSellerPayoutComponents(data.sellerPayouts ?? existing.rows[0]?.seller_payouts);

      await db.query(
        `UPDATE settlement_payment_sources
         SET processor_status = $2,
             status = $5,
             failure_code = NULL,
             failure_message = NULL,
             refunded_at = $3,
             updated_at = $3,
             last_stream_version = $4
         WHERE payment_id = $1
           AND last_stream_version < $4`,
        [data.paymentId, data.processorStatus, data.refundedAt, event.streamVersion, paymentStatus],
      );

      await debitSellerRefunds(
        wallets,
        {
          paymentId: data.paymentId,
          paymentAmount,
          refundAmount: data.amount,
          currencyCode: data.currencyCode,
          refundedAt: data.refundedAt,
          sellerPayouts,
        },
        event,
      );
    },
    "payments.payment-disputed": async (event) => {
      const data = event.data as {
        paymentId: string;
        amount: string;
        currencyCode: string;
        processorStatus: string;
        sellerPayouts?: unknown;
        disputeStatus: string | null;
        disputeMessage: string | null;
        disputedAt: string;
      };

      const existing = await db.query<{
        amount: string;
        seller_payouts: unknown;
      }>(
        `SELECT amount::text AS amount, seller_payouts
         FROM settlement_payment_sources
         WHERE payment_id = $1`,
        [data.paymentId],
      );
      const paymentAmount = existing.rows[0]?.amount ?? data.amount;
      const sellerPayouts = normalizeSellerPayoutComponents(data.sellerPayouts ?? existing.rows[0]?.seller_payouts);

      await db.query(
        `UPDATE settlement_payment_sources
         SET processor_status = $2,
             status = 'disputed',
             failure_code = $3,
             failure_message = $4,
             disputed_at = $5,
             updated_at = $5,
             last_stream_version = $6
         WHERE payment_id = $1
           AND last_stream_version < $6`,
        [
          data.paymentId,
          data.processorStatus,
          data.disputeStatus,
          data.disputeMessage,
          data.disputedAt,
          event.streamVersion,
        ],
      );

      await postSellerDisputeLedgerEntries(
        wallets,
        {
          paymentId: data.paymentId,
          paymentAmount,
          disputeAmount: data.amount,
          currencyCode: data.currencyCode,
          disputeStatus: data.disputeStatus,
          disputeMessage: data.disputeMessage,
          disputedAt: data.disputedAt,
          sellerPayouts,
        },
        event,
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
        [data.refundId, data.processorStatus, data.processorRefundReference, data.issuedAt, event.streamVersion],
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
