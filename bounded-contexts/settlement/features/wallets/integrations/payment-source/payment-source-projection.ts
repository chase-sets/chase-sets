import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type {
  MarketplaceSalesFeeLineSnapshotPayload,
  PaymentCapturedPayload,
  PaymentCancelledPayload,
  PaymentCreatedPayload,
  PaymentFailedPayload,
} from "@chase-sets/event-core";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId, LedgerEntryId, OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";
import {
  allocateMoneyByLargestRemainder,
  addMoneyAmounts,
  applyBasisPointsToMoneyAmount,
  centsToMoneyAmount,
  centsToSignedMoneyAmount,
  moneyToCents,
  roundRational,
  trySignedMoneyToCents,
} from "@chase-sets/primitives/money";
import type { WalletServices } from "../../api/runtime";
import { compareMoney, normalizeCurrencyCode, SettlementDomainError } from "../../../../support/runtime-support/common";
import {
  decideRefundLiability,
  distributeSellerFundedPortion,
  type CoverageReservationState,
} from "../../../liability-allocation/domain/liability-allocation";
import {
  loadRefundAllocation,
  recordAuthorizedRefundAllocation,
  recordQuarantinedRefundLiability,
  recordReconciledRefundLiability,
} from "../../../liability-allocation/read-model/liability-allocation-store";
import type { ProtectionCoverageSettlementPort } from "../../../liability-allocation/api/ports";

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

/**
 * The well-known platform-revenue account the authenticity-check fee
 * (m109) is credited to on capture. `wallets.postEntry` opens this
 * wallet idempotently on first use (see `ensureWallet` in
 * `../../api/runtime.ts`), so no separate provisioning step is required.
 * Scoped to this one fee for now -- introducing a general platform
 * chart-of-accounts for every existing fee (e.g. the marketplace sales
 * fee, which today is not posted as an explicit ledger entry at all) is a
 * larger, separate reconciliation initiative and out of scope here.
 */
const AUTHENTICITY_FEE_PLATFORM_ACCOUNT_ID = "acc_platform_authenticity_fee_revenue" as AccountId;

async function creditAuthenticityFee(
  wallets: WalletServices | undefined,
  data: Readonly<{
    paymentId: string;
    amount: string;
    currencyCode: string;
    capturedAt: string;
  }>,
  event: TransportEvent,
) {
  if (!wallets || compareMoney(data.amount, "0.00") === 0) {
    return;
  }

  await postWalletEntryIdempotently(
    wallets,
    {
      accountId: AUTHENTICITY_FEE_PLATFORM_ACCOUNT_ID,
      ledgerEntryId: `led_authenticity_fee_${data.paymentId}` as LedgerEntryId,
      kind: "authenticity-fee",
      direction: "credit",
      amount: data.amount,
      currencyCode: normalizeCurrencyCode(data.currencyCode),
      fundsStatus: "available",
      paymentId: data.paymentId as PaymentId,
      description: `Authenticity check fee for payment ${data.paymentId}`,
      postedAt: data.capturedAt,
    },
    {
      tenantId: event.tenantId,
      audit: event.audit,
      trace: event.trace,
    },
  );
}

type SellerPayoutComponent = Readonly<{
  orderId: string;
  sellerAccountId: string;
  marketplaceSalesFeeAmount: string;
  marketplaceSalesFeeLines: readonly MarketplaceSalesFeeLineSnapshotPayload[];
  sellerItemNetAmount: string;
  shippingAllowanceAmount: string;
  sellerShippingPayoutAmount: string;
  protectionAmount: string;
  protectionAllowanceAmount: string;
  protectionOverageAmount: string;
  sellerPayoutAmount: string;
}>;

function moneyGreaterThanZero(value: string | null | undefined) {
  return compareMoney(value ?? "0.00", "0.00") > 0;
}

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
    const normalized = {
      orderId: candidate.orderId,
      sellerAccountId: candidate.sellerAccountId,
      marketplaceSalesFeeAmount: candidate.marketplaceSalesFeeAmount ?? "0.00",
      marketplaceSalesFeeLines: Array.isArray(candidate.marketplaceSalesFeeLines)
        ? candidate.marketplaceSalesFeeLines
        : [],
      sellerItemNetAmount: candidate.sellerItemNetAmount ?? "0.00",
      shippingAllowanceAmount: candidate.shippingAllowanceAmount ?? "0.00",
      sellerShippingPayoutAmount: candidate.sellerShippingPayoutAmount ?? candidate.shippingAllowanceAmount ?? "0.00",
      protectionAmount: candidate.protectionAmount ?? "0.00",
      protectionAllowanceAmount: candidate.protectionAllowanceAmount ?? "0.00",
      protectionOverageAmount: candidate.protectionOverageAmount ?? "0.00",
      sellerPayoutAmount: candidate.sellerPayoutAmount ?? "0.00",
    };
    if (
      moneyToCents(normalized.protectionAllowanceAmount) + moneyToCents(normalized.protectionOverageAmount) !==
      moneyToCents(normalized.protectionAmount)
    ) {
      throw new SettlementDomainError("Order Protection funding shares must equal the reserve contribution.");
    }
    if (moneyToCents(normalized.protectionAllowanceAmount) > moneyToCents(normalized.sellerItemNetAmount)) {
      throw new SettlementDomainError("Allowance-funded Order Protection cannot exceed seller item net.");
    }
    if (
      moneyToCents(normalized.sellerItemNetAmount) -
        moneyToCents(normalized.protectionAllowanceAmount) +
        moneyToCents(normalized.sellerShippingPayoutAmount) !==
      moneyToCents(normalized.sellerPayoutAmount)
    ) {
      throw new SettlementDomainError("Seller payout must reconcile after Order Protection funding.");
    }
    return [normalized];
  });
}

async function recordProtectionReserveContributions(
  db: PgQueryable,
  data: Readonly<{
    paymentId: string;
    capturedAt: string;
    sellerPayouts: readonly SellerPayoutComponent[];
  }>,
  event: TransportEvent,
) {
  for (const payout of data.sellerPayouts) {
    const protectionCents = moneyToCents(payout.protectionAmount);
    const allowanceCents = moneyToCents(payout.protectionAllowanceAmount);
    const overageCents = moneyToCents(payout.protectionOverageAmount);
    if (protectionCents === 0n) continue;
    if (allowanceCents + overageCents !== protectionCents) {
      throw new SettlementDomainError("Order Protection funding shares must equal the reserve contribution.");
    }
    await db.query(
      `INSERT INTO settlement_protection_reserve_facts (
         fact_id, fact_kind, order_id, payment_id, payment_stream_version,
         protection_amount, allowance_amount, overage_amount, recorded_at
       ) VALUES ($1, 'contribution', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (order_id) WHERE fact_kind = 'contribution' DO NOTHING`,
      [
        `protection_contribution_${data.paymentId}_${payout.orderId}`,
        payout.orderId,
        data.paymentId,
        event.streamVersion,
        payout.protectionAmount,
        payout.protectionAllowanceAmount,
        payout.protectionOverageAmount,
        data.capturedAt,
      ],
    );
  }
}

type OrderAmount = Readonly<{ orderId: string; amount: string }>;

function orderAmount(entries: readonly OrderAmount[] | undefined, orderId: string) {
  return entries?.find((entry) => entry.orderId === orderId)?.amount ?? "0.00";
}

function proportionalCents(totalCents: bigint, coveredCents: bigint, capCents: bigint) {
  if (totalCents === 0n || coveredCents === 0n || capCents === 0n) return 0n;
  return roundRational(totalCents * (coveredCents < capCents ? coveredCents : capCents), capCents, "nearest");
}

async function recordProtectionReserveReversals(
  db: PgQueryable,
  data: Readonly<{
    paymentId: string;
    refundedAt: string;
    sellerPayouts: readonly SellerPayoutComponent[];
    orderRefundAmounts?: readonly OrderAmount[];
    refundedOrderAmounts?: readonly OrderAmount[];
    orderRefundCaps?: readonly OrderAmount[];
  }>,
  event: TransportEvent,
) {
  for (const payout of data.sellerPayouts) {
    const capCents = moneyToCents(orderAmount(data.orderRefundCaps, payout.orderId));
    const deltaRefundCents = moneyToCents(orderAmount(data.orderRefundAmounts, payout.orderId));
    const cumulativeRefundCents = moneyToCents(orderAmount(data.refundedOrderAmounts, payout.orderId));
    if (capCents === 0n || deltaRefundCents === 0n) continue;
    const previousRefundCents =
      cumulativeRefundCents > deltaRefundCents ? cumulativeRefundCents - deltaRefundCents : 0n;
    const allowanceTotalCents = moneyToCents(payout.protectionAllowanceAmount);
    const overageTotalCents = moneyToCents(payout.protectionOverageAmount);
    const allowanceCents =
      proportionalCents(allowanceTotalCents, cumulativeRefundCents, capCents) -
      proportionalCents(allowanceTotalCents, previousRefundCents, capCents);
    const overageCents =
      proportionalCents(overageTotalCents, cumulativeRefundCents, capCents) -
      proportionalCents(overageTotalCents, previousRefundCents, capCents);
    const protectionCents = allowanceCents + overageCents;
    if (protectionCents === 0n) continue;
    await db.query(
      `INSERT INTO settlement_protection_reserve_facts (
         fact_id, fact_kind, order_id, payment_id, payment_stream_version,
         protection_amount, allowance_amount, overage_amount, recorded_at
       ) VALUES ($1, 'reversal', $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (fact_id) DO NOTHING`,
      [
        `protection_reversal_${data.paymentId}_${payout.orderId}_${event.streamVersion}`,
        payout.orderId,
        data.paymentId,
        event.streamVersion,
        centsToMoneyAmount(protectionCents),
        centsToMoneyAmount(allowanceCents),
        centsToMoneyAmount(overageCents),
        data.refundedAt,
      ],
    );
  }
}

function assertMarketplaceSalesFeeBreakdown(payout: SellerPayoutComponent) {
  if (payout.marketplaceSalesFeeLines.length === 0) {
    return;
  }
  let totalCents = 0n;
  let grossCents = 0n;
  for (const line of payout.marketplaceSalesFeeLines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new SettlementDomainError("Marketplace sales fee line quantity must be a positive whole number.");
    }
    const uncapped = addMoneyAmounts(
      applyBasisPointsToMoneyAmount(line.unitPriceAmount, line.marketplaceSalesFeePercentageBps, "ceil"),
      line.marketplaceSalesFeeFixedAmount,
    );
    const expectedUnitCents =
      line.marketplaceSalesFeeCapAmount === null
        ? moneyToCents(uncapped)
        : [moneyToCents(uncapped), moneyToCents(line.marketplaceSalesFeeCapAmount)].reduce((minimum, value) =>
            value < minimum ? value : minimum,
          );
    const expectedTotalCents = expectedUnitCents * BigInt(line.quantity);
    if (
      expectedUnitCents !== moneyToCents(line.marketplaceSalesFeeUnitAmount) ||
      expectedTotalCents !== moneyToCents(line.marketplaceSalesFeeTotalAmount)
    ) {
      throw new SettlementDomainError("Marketplace sales fee breakdown does not reproduce the snapshotted fee.");
    }
    totalCents += expectedTotalCents;
    grossCents += moneyToCents(line.unitPriceAmount) * BigInt(line.quantity);
  }
  if (totalCents !== moneyToCents(payout.marketplaceSalesFeeAmount)) {
    throw new SettlementDomainError("Marketplace sales fee breakdown does not sum to the seller payout fee amount.");
  }
  if (grossCents - totalCents !== moneyToCents(payout.sellerItemNetAmount)) {
    throw new SettlementDomainError("Marketplace sales fee breakdown does not reconcile to seller item net.");
  }
}

async function recordOrderTrustSignalSources(
  db: PgQueryable,
  data: Readonly<{
    sellerPayouts: readonly SellerPayoutComponent[];
    processorAmount: string;
    marketplaceSalesFeeAmount: string;
    updatedAt: string;
  }>,
) {
  const trustSignalEligible =
    moneyGreaterThanZero(data.processorAmount) && moneyGreaterThanZero(data.marketplaceSalesFeeAmount);

  for (const payout of data.sellerPayouts) {
    await db.query(
      `INSERT INTO settlement_order_trust_signal_sources (
         order_id,
         seller_account_id,
         trust_signal_eligible,
         updated_at
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (order_id) DO UPDATE SET
         seller_account_id = EXCLUDED.seller_account_id,
         trust_signal_eligible = EXCLUDED.trust_signal_eligible,
         updated_at = EXCLUDED.updated_at`,
      [payout.orderId, payout.sellerAccountId, trustSignalEligible, data.updatedAt],
    );
  }
}

async function refreshTrustSignalEligibleReviewCounts(
  db: PgQueryable,
  sellerAccountIds: readonly string[],
  updatedAt: string,
) {
  for (const sellerAccountId of [...new Set(sellerAccountIds)]) {
    await db.query(
      `INSERT INTO settlement_account_risk_sources (
         account_id,
         review_count,
         average_rating,
         updated_at
       )
       SELECT
         $1,
         COUNT(*)::integer,
         CASE WHEN COUNT(*) = 0 THEN NULL ELSE ROUND(AVG(rating)::numeric, 2) END,
         $2
       FROM settlement_account_review_sources
       INNER JOIN settlement_order_trust_signal_sources trust_source
         ON trust_source.order_id = settlement_account_review_sources.order_id
        AND trust_source.seller_account_id = settlement_account_review_sources.subject_account_id
        AND trust_source.trust_signal_eligible = TRUE
       WHERE subject_account_id = $1
         AND status = 'active'
       ON CONFLICT (account_id) DO UPDATE SET
         review_count = EXCLUDED.review_count,
         average_rating = EXCLUDED.average_rating,
         updated_at = EXCLUDED.updated_at`,
      [sellerAccountId, updatedAt],
    );
  }
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
  const walletServices = wallets;

  const context = {
    tenantId: event.tenantId,
    audit: event.audit,
    trace: event.trace,
  };
  const availableBalanceByAccount = new Map<string, string>();

  async function getAvailableBalanceAmount(accountId: AccountId) {
    const existing = availableBalanceByAccount.get(accountId);
    if (existing !== undefined) {
      return existing;
    }

    if (typeof walletServices.getWallet !== "function") {
      availableBalanceByAccount.set(accountId, "0.00");
      return "0.00";
    }

    const wallet = await walletServices.getWallet(accountId);
    availableBalanceByAccount.set(accountId, wallet.available_balance_amount);
    return wallet.available_balance_amount;
  }

  async function postSellerCredit(
    params: Readonly<{
      accountId: AccountId;
      ledgerEntryId: LedgerEntryId;
      kind: "sale" | "rebate";
      amount: string;
      orderId: OrderId;
      paymentId: PaymentId;
      pendingDescription: string;
      offsetDescription: string;
    }>,
  ) {
    const availableBalanceAmount = await getAvailableBalanceAmount(params.accountId);
    const availableBalanceCents = trySignedMoneyToCents(availableBalanceAmount) ?? 0n;
    const amountCents = moneyToCents(params.amount);
    const offsetCents =
      availableBalanceCents < 0n && amountCents > 0n
        ? amountCents < -availableBalanceCents
          ? amountCents
          : -availableBalanceCents
        : 0n;
    const remainingCents = amountCents - offsetCents;

    if (remainingCents > 0n) {
      await postWalletEntryIdempotently(
        walletServices,
        {
          accountId: params.accountId,
          ledgerEntryId: offsetCents > 0n ? (`${params.ledgerEntryId}_pending` as LedgerEntryId) : params.ledgerEntryId,
          kind: params.kind,
          direction: "credit",
          amount: centsToMoneyAmount(remainingCents),
          currencyCode: normalizeCurrencyCode(data.currencyCode),
          fundsStatus: "pending",
          orderId: params.orderId,
          paymentId: params.paymentId,
          description: params.pendingDescription,
          postedAt: data.capturedAt,
        },
        context,
      );
    }

    if (offsetCents > 0n) {
      const offsetAmount = centsToMoneyAmount(offsetCents);
      await postWalletEntryIdempotently(
        walletServices,
        {
          accountId: params.accountId,
          ledgerEntryId: params.ledgerEntryId,
          kind: params.kind,
          direction: "credit",
          amount: offsetAmount,
          currencyCode: normalizeCurrencyCode(data.currencyCode),
          fundsStatus: "available",
          orderId: params.orderId,
          paymentId: params.paymentId,
          description: params.offsetDescription,
          postedAt: data.capturedAt,
        },
        context,
      );
      availableBalanceByAccount.set(params.accountId, centsToSignedMoneyAmount(availableBalanceCents + offsetCents));
    }
  }

  for (const payout of data.sellerPayouts) {
    assertMarketplaceSalesFeeBreakdown(payout);
    const sellerAccountId = payout.sellerAccountId as AccountId;
    const paymentId = data.paymentId as PaymentId;

    const sellerItemCreditAmount = centsToMoneyAmount(
      moneyToCents(payout.sellerItemNetAmount) - moneyToCents(payout.protectionAllowanceAmount),
    );
    if (compareMoney(sellerItemCreditAmount, "0.00") > 0) {
      await postSellerCredit({
        accountId: sellerAccountId,
        ledgerEntryId: `led_sale_${data.paymentId}_${payout.orderId}` as LedgerEntryId,
        kind: "sale",
        amount: sellerItemCreditAmount,
        orderId: payout.orderId as OrderId,
        paymentId,
        pendingDescription: `Item sale proceeds for order ${payout.orderId}`,
        offsetDescription: `Negative balance offset from item sale proceeds for order ${payout.orderId}`,
      });
    }

    if (compareMoney(payout.sellerShippingPayoutAmount, "0.00") > 0) {
      await postSellerCredit({
        accountId: sellerAccountId,
        ledgerEntryId: `led_shipping_allowance_${data.paymentId}_${payout.orderId}` as LedgerEntryId,
        kind: "rebate",
        amount: payout.sellerShippingPayoutAmount,
        orderId: payout.orderId as OrderId,
        paymentId,
        pendingDescription: `Shipping allowance for order ${payout.orderId}`,
        offsetDescription: `Negative balance offset from shipping allowance for order ${payout.orderId}`,
      });
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

function ledgerIdPart(value: string) {
  return value.replaceAll(/[^a-zA-Z0-9_]+/g, "_").replaceAll(/^_+|_+$/g, "");
}

/**
 * Posts the per-payout seller refund debits for the amounts the caller already
 * decided (either the legacy proration for a seller-funded refund, or the exact
 * seller-funded portion of an authorized liability allocation). Idempotent by ledger
 * entry id, and returns the total posted so the reconciliation record reflects exactly
 * what hit the seller ledger.
 */
async function postSellerRefundDebits(
  wallets: WalletServices | undefined,
  data: Readonly<{
    paymentId: string;
    currencyCode: string;
    refundedAt: string;
    sellerPayouts: readonly SellerPayoutComponent[];
    debitAmounts: readonly string[];
  }>,
  event: TransportEvent,
): Promise<string> {
  if (!wallets) {
    return "0.00";
  }

  const context = {
    tenantId: event.tenantId,
    audit: event.audit,
    trace: event.trace,
  };

  let postedCents = 0n;
  for (const [index, payout] of data.sellerPayouts.entries()) {
    const debitAmount = data.debitAmounts[index] ?? "0.00";
    if (compareMoney(debitAmount, "0.00") <= 0) {
      continue;
    }
    postedCents += moneyToCents(debitAmount);

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
  return centsToMoneyAmount(postedCents);
}

/**
 * Records the authorized liability allocation carried by a Payments refund-causation
 * fact, keyed by the stable refund id, so that when the refund completes the
 * seller-vs-platform split is read from the authorization rather than inferred. A
 * seller-funded refund carries no causation and is never recorded here — its absence is
 * the documented compatibility default at completion time.
 */
async function recordRefundCausationAllocation(
  db: PgQueryable,
  data: Readonly<{
    refundId?: string | null;
    paymentId?: string | null;
    causation?: {
      remedyId?: string;
      coverageId?: string | null;
      allocation?: {
        sellerFundedAmount?: string;
        platformFundedAmount?: string;
        currencyCode?: string;
        fundingKind?: "seller-funded" | "platform-funded" | "split";
      };
    } | null;
  }>,
  event: TransportEvent,
) {
  const causation = data.causation;
  const allocation = causation?.allocation;
  if (!data.refundId || !causation?.remedyId || !allocation?.fundingKind) {
    return;
  }
  await recordAuthorizedRefundAllocation(db, {
    refundId: data.refundId,
    paymentId: data.paymentId ?? null,
    remedyId: causation.remedyId,
    coverageId: causation.coverageId ?? null,
    sellerFundedAmount: allocation.sellerFundedAmount ?? "0.00",
    platformFundedAmount: allocation.platformFundedAmount ?? "0.00",
    currencyCode: allocation.currencyCode ?? "usd",
    fundingKind: allocation.fundingKind,
    authorizedAt: event.timing?.occurredAt ?? new Date().toISOString(),
    streamVersion: event.streamVersion,
  });
}

/**
 * Allocation-aware settlement of a completed refund (ADR 0022). Instead of
 * unconditionally debiting the seller, Settlement follows the authorized
 * `LiabilityAllocation`: it posts the exact seller-funded portion to the seller ledger,
 * consumes the platform-funded portion from the reserved ProtectionCoverage exactly
 * once, and fails closed into an observable repair queue for any mismatch. A refund with
 * no authorized allocation preserves the legacy seller-funded proration.
 *
 * The seller portion is posted before the coverage is settled, so the durable
 * `settlement.protection-coverage.settled.v1` reconciliation fact the aggregate emits
 * only follows postings that are already committed.
 */
async function reconcileRefundLiability(
  db: PgQueryable,
  wallets: WalletServices | undefined,
  protectionCoverage: ProtectionCoverageSettlementPort | undefined,
  data: Readonly<{
    paymentId: string;
    refundId: string | null;
    paymentAmount: string;
    refundAmount: string;
    currencyCode: string;
    refundedAt: string;
    sellerPayouts: readonly SellerPayoutComponent[];
  }>,
  event: TransportEvent,
) {
  const allocationRow = data.refundId ? await loadRefundAllocation(db, data.refundId) : null;

  if (!allocationRow || !data.refundId) {
    // Documented compatibility default: no authorized allocation means a seller-funded
    // (or legacy) refund; preserve the existing prorated, capped seller debit.
    const debitAmounts = allocateRefundDebitAmounts(data.refundAmount, data.paymentAmount, data.sellerPayouts);
    await postSellerRefundDebits(
      wallets,
      {
        paymentId: data.paymentId,
        currencyCode: data.currencyCode,
        refundedAt: data.refundedAt,
        sellerPayouts: data.sellerPayouts,
        debitAmounts,
      },
      event,
    );
    return;
  }

  const refundId = data.refundId;
  const allocation = {
    refundId,
    remedyId: allocationRow.remedyId,
    coverageId: allocationRow.coverageId,
    sellerFundedAmount: allocationRow.sellerFundedAmount,
    platformFundedAmount: allocationRow.platformFundedAmount,
    currencyCode: allocationRow.currencyCode,
    fundingKind: allocationRow.fundingKind,
  };

  let reservation: CoverageReservationState | null = null;
  if (allocation.coverageId && protectionCoverage) {
    const coverageRow = await protectionCoverage.getCoverage(allocation.coverageId);
    reservation = coverageRow
      ? {
          reservedAmount: coverageRow.reserved_amount,
          status: coverageRow.status,
          refundId: coverageRow.refund_id,
          policyVersion: coverageRow.policy_version,
          currencyCode: coverageRow.currency_code,
          supportRequestId: coverageRow.support_request_id,
          remedyId: coverageRow.remedy_id,
        }
      : null;
  }

  const decision = decideRefundLiability({
    allocation,
    completedRefundAmount: data.refundAmount,
    completedCurrencyCode: data.currencyCode,
    reservation,
  });

  const base = {
    refundId,
    paymentId: data.paymentId,
    remedyId: allocation.remedyId,
    coverageId: allocation.coverageId,
    sellerFundedAmount: allocation.sellerFundedAmount,
    platformFundedAmount: allocation.platformFundedAmount,
    currencyCode: allocation.currencyCode,
    fundingKind: allocation.fundingKind,
    completedRefundAmount: data.refundAmount,
    streamVersion: event.streamVersion,
  };

  if (decision.outcome === "quarantined") {
    await recordQuarantinedRefundLiability(db, {
      ...base,
      reasonCode: decision.reasonCode,
      detail: decision.detail,
      quarantinedAt: data.refundedAt,
    });
    return;
  }
  if (decision.outcome !== "allocated") {
    // Unreachable: an authorized allocation is present, so the decision is allocated or
    // quarantined. Guarded to narrow the type and fail closed rather than mis-post.
    return;
  }

  const weights = data.sellerPayouts.map((payout) => ({
    orderId: payout.orderId,
    sellerAccountId: payout.sellerAccountId,
    weightAmount: payout.sellerPayoutAmount,
  }));
  const debitAmounts = distributeSellerFundedPortion(decision.sellerDebitAmount, weights);
  const distributedCents = debitAmounts.reduce((sum, amount) => sum + moneyToCents(amount), 0n);
  if (distributedCents !== moneyToCents(decision.sellerDebitAmount)) {
    // A positive seller-funded portion with no seller exposure to land on: fail closed.
    await recordQuarantinedRefundLiability(db, {
      ...base,
      reasonCode: "no-seller-exposure",
      detail: `Seller-funded portion ${decision.sellerDebitAmount} has no seller exposure to post against.`,
      quarantinedAt: data.refundedAt,
    });
    return;
  }

  const sellerPostedAmount = await postSellerRefundDebits(
    wallets,
    {
      paymentId: data.paymentId,
      currencyCode: data.currencyCode,
      refundedAt: data.refundedAt,
      sellerPayouts: data.sellerPayouts,
      debitAmounts,
    },
    event,
  );

  if (
    compareMoney(decision.platformSettleAmount, "0.00") > 0 &&
    !decision.alreadySettled &&
    decision.coverageId &&
    protectionCoverage &&
    reservation
  ) {
    await protectionCoverage.settle(
      {
        coverageId: decision.coverageId,
        currencyCode: data.currencyCode,
        refundId,
        platformFundedAmount: decision.platformSettleAmount,
        sellerFundedAmount: decision.sellerDebitAmount,
        policyVersion: reservation.policyVersion,
        causationId: event.id ?? null,
        occurredAt: data.refundedAt,
      },
      { tenantId: event.tenantId, audit: event.audit, trace: event.trace },
    );
  }

  await recordReconciledRefundLiability(db, {
    ...base,
    sellerPostedAmount,
    platformSettledAmount: decision.platformSettleAmount,
    reconciledAt: data.refundedAt,
  });
}

function shouldReleaseDisputeHold(
  disputeLifecycleState: string | null | undefined,
  disputeStatus: string | null,
  disputeMessage: string | null,
) {
  if (disputeLifecycleState === "won") {
    return true;
  }
  if (disputeLifecycleState === "lost") {
    return false;
  }
  const eventType = disputeStatus?.toLowerCase() ?? "";
  const providerStatus = disputeMessage?.toLowerCase() ?? "";
  return eventType.includes("closed") && (providerStatus === "won" || providerStatus === "warning_closed");
}

async function postSellerDisputeLedgerEntries(
  wallets: WalletServices | undefined,
  data: Readonly<{
    paymentId: string;
    providerDisputeId?: string | null;
    paymentAmount: string;
    disputeAmount: string;
    currencyCode: string;
    disputeStatus: string | null;
    disputeMessage: string | null;
    disputeLifecycleState?: string | null;
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
  const releaseHold = shouldReleaseDisputeHold(data.disputeLifecycleState, data.disputeStatus, data.disputeMessage);

  const holdAmounts = allocateRefundDebitAmounts(data.disputeAmount, data.paymentAmount, data.sellerPayouts);
  const disputeId = ledgerIdPart(data.providerDisputeId ?? data.paymentId);

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
        ledgerEntryId: `led_chargeback_${disputeId}_${ledgerIdPart(payout.orderId)}` as LedgerEntryId,
        kind: "adjustment",
        direction: "debit",
        description: `Chargeback clawback for payment ${data.paymentId}`,
        allowNegativeBalance: true,
      },
      context,
    );

    if (releaseHold) {
      await postWalletEntryIdempotently(
        wallets,
        {
          ...baseEntry,
          ledgerEntryId: `led_chargeback_release_${disputeId}_${ledgerIdPart(payout.orderId)}` as LedgerEntryId,
          kind: "adjustment",
          direction: "credit",
          description: `Chargeback hold released for payment ${data.paymentId}`,
        },
        context,
      );
    }
  }
}

export function buildSettlementPaymentInputProjectionHandlers(
  db: PgQueryable,
  wallets?: WalletServices,
  protectionCoverage?: ProtectionCoverageSettlementPort,
): ProjectorHandlerMap {
  return {
    "payments.payment-created": async (event) => {
      const data = event.data as PaymentCreatedPayload;

      const sellerPayouts = normalizeSellerPayoutComponents(data.sellerPayouts);

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
          JSON.stringify(sellerPayouts),
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
      await recordOrderTrustSignalSources(db, {
        sellerPayouts,
        processorAmount: data.processorAmount ?? data.amount,
        marketplaceSalesFeeAmount: data.marketplaceSalesFeeAmount ?? "0.00",
        updatedAt: data.createdAt,
      });
      await refreshTrustSignalEligibleReviewCounts(
        db,
        sellerPayouts.map((payout) => payout.sellerAccountId),
        data.createdAt,
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
      const data = event.data as PaymentCapturedPayload;

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
      const sellerPayouts = normalizeSellerPayoutComponents(data.sellerPayouts);
      await creditSellerPayouts(
        wallets,
        {
          paymentId: data.paymentId,
          currencyCode: data.currencyCode ?? "usd",
          capturedAt: data.capturedAt,
          sellerPayouts,
        },
        event,
      );
      await recordProtectionReserveContributions(
        db,
        { paymentId: data.paymentId, capturedAt: data.capturedAt, sellerPayouts },
        event,
      );
      await creditAuthenticityFee(
        wallets,
        {
          paymentId: data.paymentId,
          amount: data.authenticityFeeAmount ?? "0.00",
          currencyCode: data.currencyCode ?? "usd",
          capturedAt: data.capturedAt,
        },
        event,
      );
    },
    "payments.payment-failed": async (event) => {
      const data = event.data as PaymentFailedPayload;

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
      const data = event.data as PaymentCancelledPayload;

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
        refundId?: string | null;
        amount: string;
        currencyCode: string;
        processorStatus: string;
        refundedAmount?: string;
        sellerPayouts?: unknown;
        orderRefundAmounts?: readonly OrderAmount[];
        refundedOrderAmounts?: readonly OrderAmount[];
        orderRefundCaps?: readonly OrderAmount[];
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

      await reconcileRefundLiability(
        db,
        wallets,
        protectionCoverage,
        {
          paymentId: data.paymentId,
          refundId: data.refundId ?? null,
          paymentAmount,
          refundAmount: data.amount,
          currencyCode: data.currencyCode,
          refundedAt: data.refundedAt,
          sellerPayouts,
        },
        event,
      );
      await recordProtectionReserveReversals(
        db,
        {
          paymentId: data.paymentId,
          refundedAt: data.refundedAt,
          sellerPayouts,
          orderRefundAmounts: data.orderRefundAmounts,
          refundedOrderAmounts: data.refundedOrderAmounts,
          orderRefundCaps: data.orderRefundCaps,
        },
        event,
      );
    },
    "payments.payment-disputed": async (event) => {
      const data = event.data as {
        paymentId: string;
        providerDisputeId?: string | null;
        amount: string;
        currencyCode: string;
        processorStatus: string;
        sellerPayouts?: unknown;
        disputeStatus: string | null;
        disputeMessage: string | null;
        disputeLifecycleState?: string | null;
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
          providerDisputeId: data.providerDisputeId,
          paymentAmount,
          disputeAmount: data.amount,
          currencyCode: data.currencyCode,
          disputeStatus: data.disputeStatus,
          disputeMessage: data.disputeMessage,
          disputeLifecycleState: data.disputeLifecycleState,
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
        causation?: {
          remedyId?: string;
          coverageId?: string | null;
          allocation?: {
            sellerFundedAmount?: string;
            platformFundedAmount?: string;
            currencyCode?: string;
            fundingKind?: "seller-funded" | "platform-funded" | "split";
          };
        } | null;
        requestedAt: string;
      };

      await recordRefundCausationAllocation(
        db,
        { refundId: data.refundId, paymentId: data.paymentId, causation: data.causation },
        event,
      );

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
