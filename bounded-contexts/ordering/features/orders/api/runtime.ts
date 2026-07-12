import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { SourceCommitPosition } from "@chase-sets/http/responses";
import { createNoopNotificationOutbox, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import {
  buildPackagePlan,
  defaultPostagePolicy,
  type PackagePlan,
  type PostagePolicy,
  type ProductMeasureSnapshot,
} from "@chase-sets/product-measures";
import { createId } from "@chase-sets/primitives/typed-ids";
import { normalizeAddressSnapshot, type AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId, OrderId } from "@chase-sets/primitives/typed-ids";
import {
  addMoneyAmounts,
  applyBasisPointsToMoneyAmount,
  centsToMoneyAmount,
  moneyToCents,
  subtractNonNegativeMoneyAmounts,
  sumMoneyAmounts,
} from "@chase-sets/primitives/money";
import {
  OrderingDomainError,
  buildDemandSignature,
  normalizeMoneyAmount,
  type OrderLineId,
  type OrderSourceType,
  type OrderStatus,
  type ShippingOption,
} from "../domain/common";
import {
  assertSupplyAvailable,
  defaultOrderPaymentDeadlinePolicy,
  resolveOrderPaymentDeadline,
  resolveTerminalPaymentFailureDeadline,
  type OrderPaymentDeadlinePolicy,
  type MarketplaceDemand,
  type MarketplaceSupplyCandidate,
  type MarketplaceSupplyFeeLock,
  type ShippingQuotePolicy,
} from "../domain/policies";
import {
  getPurchase,
  getPurchaseListSummary,
  getSale,
  getSaleListSummary,
  listOrderIdsForSource,
  listPendingPaymentOrdersPastDeadline,
  listPurchases,
  listSales,
} from "../read-model/queries";
import { buildOrderingOrderProjectionHandlers } from "../read-model/projection";
import { buildOrderingReputationProjectionHandlers } from "../integrations/reputation/reputation-projection";
import { getOrderingOrderReviewOpportunity } from "../integrations/reputation/reputation-queries";
import {
  buildOrderingTransactionalEmailProjectionHandlers,
  ORDERING_TRANSACTIONAL_EMAIL_PROJECTION,
} from "../integrations/transactional-email/transactional-email-projector";
import { listOrderingSupplyCandidates } from "../integrations/supply/supply-queries";
import { getOrderingSupplyCandidateByListingId } from "../integrations/supply/supply-queries";
import {
  applyPurchaseLimitAvailability,
  assertPlanPurchaseLimits,
  claimPlanPurchaseLimitUsage,
  listingPurchaseLimitReachedReason,
  planHasAccountScopedPurchaseLimits,
  releasePurchaseLimitClaimsForOrder,
} from "./purchase-limits";
import {
  decideOrderingOrder,
  evolveOrderingOrder,
  initialOrderingOrderState,
  type OrderingOrderCommand,
  type OrderingOrderEvent,
  type OrderingOrderState,
} from "../domain/domain";
import { createFulfillmentDeliveryPromise } from "../domain/fulfillment-delivery-promise";
import { quoteAuthenticityCheckFee, type AuthenticityCheckFeeQuote } from "../domain/authenticity-check-fee";
import type { AuthenticityFeePolicyResolver } from "./authenticity-fee-policy-resolver";

export type TaxDestinationAddress = AddressSnapshot;

export type TaxQuote = Readonly<{
  taxableAmount: string;
  taxAmount: string;
  jurisdictionCountry: string;
  jurisdictionState: string | null;
  rateBps: number;
  itemTaxable: boolean;
  shippingTaxable: boolean;
  marketplaceCheckoutFeeTaxable: boolean;
  providerName: string;
  providerQuoteReference: string | null;
  quotedAt: string;
}>;

export type TaxQuoteResolver = Readonly<{
  quoteTax(
    input: Readonly<{
      buyerAccountId: string;
      sellerAccountId: string;
      currencyCode: "usd";
      destinationAddress: TaxDestinationAddress;
      itemSubtotalAmount: string;
      shippingAmount: string;
      marketplaceCheckoutFeeAmount?: string | null;
    }>,
  ): Promise<TaxQuote>;
}>;

export type PostagePolicyResolver = (effectiveAt?: string) => Promise<PostagePolicy>;

const defaultPostagePolicyResolver: PostagePolicyResolver = async () => defaultPostagePolicy;

const zeroTaxQuoteResolver: TaxQuoteResolver = {
  async quoteTax(input) {
    return {
      taxableAmount: "0.00",
      taxAmount: "0.00",
      jurisdictionCountry: input.destinationAddress.country.trim().toUpperCase(),
      jurisdictionState: input.destinationAddress.state.trim().toUpperCase() || null,
      rateBps: 0,
      itemTaxable: false,
      shippingTaxable: false,
      marketplaceCheckoutFeeTaxable: false,
      providerName: "ordering-zero-tax",
      providerQuoteReference: null,
      quotedAt: new Date().toISOString(),
    };
  },
};

function normalizeSweepNow(now?: string | Date) {
  if (!now) {
    return new Date().toISOString();
  }
  return typeof now === "string" ? now : now.toISOString();
}

function isPaymentDeadlineRaceProgression(error: unknown) {
  return (
    error instanceof OrderingDomainError &&
    error.message === "Payment-deadline cancellation requires a pending-payment order."
  );
}

async function getOrderPurchaseLimitReleaseInput(db: PgTransactionalPool, orderId: string) {
  const [orderResult, linesResult] = await Promise.all([
    db.query<{
      source_type: string;
      source_reference_id: string | null;
      buyer_account_id: string;
    }>(
      `SELECT source_type, source_reference_id, buyer_account_id
       FROM ordering_order_pages
       WHERE order_id = $1`,
      [orderId],
    ),
    db.query<{ listing_id: string }>(
      `SELECT listing_id
       FROM ordering_order_line_pages
       WHERE order_id = $1`,
      [orderId],
    ),
  ]);
  const order = orderResult.rows[0];
  if (!order) {
    return null;
  }

  return {
    ...order,
    lines: linesResult.rows,
  };
}

type OrderRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgTransactionalPool;
  shippingQuotePolicy: ShippingQuotePolicy;
  paymentDeadlinePolicy?: OrderPaymentDeadlinePolicy;
  postagePolicyResolver?: PostagePolicyResolver;
  taxQuoteResolver?: TaxQuoteResolver;
  notificationOutbox?: NotificationOutbox;
  authenticityFeePolicyResolver?: AuthenticityFeePolicyResolver;
}>;

export type CheckoutOrderLineSnapshot = Readonly<{
  listingId: string | null;
  cartLineId: string | null;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  quantity: number;
  fulfillmentMode?: "optimize" | "locked-listing";
  lockedListingId?: string | null;
  sellerPreferenceId?: string | null;
  availabilityState?: "available" | "unavailable" | "changed" | "waiting-for-supply";
}>;

export type CheckoutInventoryReservationInput = Readonly<{
  holdId: string;
  sellerAccountId: string;
  inventoryItemId: string;
  quantity: number;
}>;

export type CheckoutShippingAddressSnapshot = TaxDestinationAddress;

type DemandAllocation = Readonly<{
  candidate: MarketplaceSupplyCandidate;
  quantity: number;
}>;

type DemandPlan = Readonly<{
  demand: MarketplaceDemand;
  allocations: readonly DemandAllocation[];
}>;

type SellerOrderDraft = Readonly<{
  sellerAccountId: string;
  sellerDisplayName: string | null;
  sourceType: OrderSourceType;
  sourceReferenceId: string | null;
  shippingOption: ShippingOption;
  itemSubtotalAmount: string;
  shippingBaseAmount: string;
  shippingDiscountAmount: string;
  shippingAllowanceAmount: string;
  shippingOverageAmount: string;
  sellerShippingPayoutAmount: string;
  shippingChargeAmount: string;
  shippingPlanSnapshot: PackagePlan;
  salesTaxAmount: string;
  totalAmount: string;
  taxQuote: TaxQuote;
  shippingOriginSnapshot: AddressSnapshot;
  lines: ReadonlyArray<{
    lineId: OrderLineId;
    listingId: string;
    inventoryItemId: string;
    catalogItemId: CatalogItemId;
    productId: ProductKey;
    itemTitle: string;
    itemSubtitle: string | null;
    selectedOptions: { dimensionId: string; optionId: string }[];
    productSummary: string | null;
    productMeasureSnapshot: ProductMeasureSnapshot | null;
    gradedCard: MarketplaceSupplyCandidate["gradedCard"];
    unitPriceAmount: string;
    quantity: number;
    lineTotalAmount: string;
    marketplaceSalesFeeUnitAmount: string;
    marketplaceSalesFeeTotalAmount: string;
    sellerNetUnitAmount: string;
    sellerNetTotalAmount: string;
    termsScheduleId: string | null;
    termsAgreementId: string | null;
    termsResolvedAt: string;
    shippingAllowancePercentageBps: number;
  }>;
  reservations: ReadonlyArray<{
    reservationRequestId: string;
    inventoryItemId: string;
    quantity: number;
    holdId?: string | null;
  }>;
}>;

type CheckoutPlan = Readonly<{
  orderDrafts: readonly SellerOrderDraft[];
  totalAmount: bigint;
  itemSubtotalAmount: bigint;
  orderCount: number;
}>;

export type CheckoutFulfillmentPreview = Readonly<{
  revision: string;
  optimizationGoal: "lowest-total" | "fewest-shipments";
  readyLineKeys: readonly string[];
  unavailableLineKeys: readonly string[];
  sellerGroups: readonly Readonly<{
    sellerAccountId: string;
    sellerDisplayName: string | null;
    itemSubtotalAmount: string;
    shippingChargeAmount: string;
    salesTaxAmount: string;
    totalAmount: string;
    postageRequirements: Readonly<{
      policyVersion: string;
      parcelRequired: boolean;
      parcelReasons: readonly string[];
      signatureRequired: boolean;
      signatureReasons: readonly string[];
      insuranceRequired: boolean;
      insuranceReasons: readonly string[];
      insuredValueAmount: string | null;
      shippingEvidenceTier: string;
    }>;
    deliveryEstimate: Readonly<{
      earliestDate: string;
      latestDate: string;
      minimumTransitDays: number;
      maximumTransitDays: number;
      handlingDays: number;
      packageCount: number;
      shipFromRegion: string;
      serviceLevel: string;
      promiseOwner: "fulfillment";
      promiseSource: "fulfillment-promise-policy";
      promiseConfidence: "estimated";
      cutoffTimeLocal: string;
      packingStartDate: string;
      carrierHandoffDate: string;
      basis: string;
    }>;
    lines: readonly Readonly<{
      lineKey: string;
      listingId: string;
      sellerAccountId: string;
      inventoryItemId: string;
      catalogItemId: string;
      productId: string;
      itemTitle: string;
      productSummary: string | null;
      quantity: number;
      estimatedUnitPriceAmount: string;
      estimatedLineTotalAmount: string;
      priceState: "available" | "changed" | "unavailable" | "locked";
      materialChangeReasons: readonly string[];
    }>[];
  }>[];
  totals: Readonly<{
    itemSubtotalAmount: string;
    shippingAmount: string;
    salesTaxAmount: string;
    totalAmount: string;
    packageCount: number;
  }>;
  unavailableLines: readonly Readonly<{
    lineKey: string;
    catalogItemId: string;
    productId: string;
    itemTitle: string;
    productSummary: string | null;
    quantity: number;
    reason: string;
  }>[];
  materialChangeReasons: readonly string[];
  /**
   * The authenticity-check opt-in offer (m109): null when the
   * checkout has more than one seller group (single-seller only in v1) or
   * the policy resolver is not wired; otherwise a quote that may itself be
   * `eligible: false` when the order value is below the opt-in threshold.
   */
  authenticityCheckOffer: AuthenticityCheckFeeQuote | null;
}>;

type OrderingCommitMetadata = Readonly<{
  commitPosition?: string;
  commitEventIds?: readonly string[];
  commitPositions?: readonly SourceCommitPosition[];
}>;

export type OrderingOrderCreationResult = Readonly<{
  orderIds: readonly OrderId[];
}> &
  OrderingCommitMetadata;

export type OrderingOrderServices = Readonly<{
  commandHandler: CommandHandler<OrderingOrderCommand, OrderingOrderState, OrderingOrderEvent>;
  createOrdersFromCheckout: (
    params: Readonly<{
      buyerAccountId: AccountId;
      checkoutSessionId: string;
      sourceType: "cart-checkout" | "buy-now";
      shippingOption: ShippingOption;
      shippingAddress: CheckoutShippingAddressSnapshot;
      lines: readonly CheckoutOrderLineSnapshot[];
      optimizationGoal?: "lowest-total" | "fewest-shipments";
      fulfillmentPreviewRevision?: string | null;
      acknowledgedMaterialChanges?: boolean;
      checkoutReservations?: readonly CheckoutInventoryReservationInput[];
      customerAccountIsGuest?: boolean;
      orderIdsOverride?: readonly OrderId[];
      /**
       * The buyer's authenticity-check opt-in (m109), carrying the
       * quote fingerprint they last saw at checkout. Ordering
       * re-resolves the policy and recomputes the fee live against the
       * actual committed order value; a fingerprint mismatch rejects the
       * whole checkout submission with `authenticity_fee_quote_stale`
       * rather than silently freezing a different amount.
       */
      authenticityCheckOptIn?: Readonly<{ selected: true; quoteFingerprint: string }> | null;
    }>,
    context: EventStoreContext,
  ) => Promise<OrderingOrderCreationResult>;
  previewCheckoutFulfillment: (
    params: Readonly<{
      buyerAccountId: AccountId;
      checkoutSessionId: string;
      sourceType: "cart-checkout" | "buy-now";
      shippingOption: ShippingOption;
      shippingAddress?: CheckoutShippingAddressSnapshot | null;
      lines: readonly CheckoutOrderLineSnapshot[];
      optimizationGoal?: "lowest-total" | "fewest-shipments";
      /** When true, the delivery estimate reflects the facility inspection allowance (m109). */
      authenticityCheckOptIn?: boolean;
    }>,
  ) => Promise<CheckoutFulfillmentPreview>;
  createOrdersFromAcceptedOffer: (
    params: Readonly<{
      offerId: string;
      buyerAccountId: AccountId;
      sellerAccountId: AccountId;
      catalogItemId: string;
      productId: string;
      itemTitle: string;
      itemSubtitle: string | null;
      selectedOptions: { dimensionId: string; optionId: string }[];
      productSummary: string | null;
      priceAmount: string;
      marketplaceSalesFeeUnitAmount: string;
      sellerNetUnitAmount: string;
      termsScheduleId: string | null;
      termsAgreementId: string | null;
      termsResolvedAt: string;
      shippingAllowancePercentageBps?: number;
      shippingDestinationSnapshot: AddressSnapshot;
      quantityRequested: number;
      orderIdsOverride?: readonly OrderId[];
    }>,
    context: EventStoreContext,
  ) => Promise<OrderingOrderCreationResult>;
  createOrdersFromAcceptedOfferBatch: (
    params: Readonly<{
      acceptanceBatchId: string;
      offers: readonly Readonly<{
        offerId: string;
        buyerAccountId: AccountId;
        sellerAccountId: AccountId;
        catalogItemId: string;
        productId: string;
        itemTitle: string;
        itemSubtitle: string | null;
        selectedOptions: { dimensionId: string; optionId: string }[];
        productSummary: string | null;
        priceAmount: string;
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        shippingAllowancePercentageBps?: number;
        shippingDestinationSnapshot: AddressSnapshot;
        termsScheduleId: string | null;
        termsAgreementId: string | null;
        termsResolvedAt: string;
        quantityRequested: number;
      }>[];
    }>,
    context: EventStoreContext,
  ) => Promise<{ orderIds: readonly OrderId[] }>;
  cancelPurchase: (
    params: Readonly<{ orderId: string; buyerAccountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ orderId: string; version: number }>;
  cancelSale: (
    params: Readonly<{ orderId: string; sellerAccountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ orderId: string; version: number }>;
  recordPaymentDeadlineStarted: (
    params: Readonly<{
      paymentId: string;
      orderIds: readonly string[];
      paymentMethodCategory?: string | null;
      paymentStartedAt: string;
    }>,
  ) => Promise<number>;
  recordTerminalPaymentFailureDeadline: (
    params: Readonly<{
      paymentId: string;
      orderIds: readonly string[];
      failedAt: string;
      failureCode?: string | null;
    }>,
  ) => Promise<number>;
  sweepBreachedPaymentDeadlines: (
    params: Readonly<{ now?: string | Date; limit?: number }> | undefined,
    context: EventStoreContext,
  ) => Promise<{ checked: number; cancelled: number; progressed: number; failed: number }>;
  listPurchases: (params: Parameters<typeof listPurchases>[1]) => ReturnType<typeof listPurchases>;
  getPurchase: (orderId: string, buyerAccountId: string) => ReturnType<typeof getPurchase>;
  getPurchaseListSummary: (buyerAccountId: string) => ReturnType<typeof getPurchaseListSummary>;
  listSales: (params: Parameters<typeof listSales>[1]) => ReturnType<typeof listSales>;
  getSale: (orderId: string, sellerAccountId: string) => ReturnType<typeof getSale>;
  getSaleListSummary: (sellerAccountId: string) => ReturnType<typeof getSaleListSummary>;
  getOrderReviewOpportunity: (
    orderId: string,
    authorAccountId: string,
  ) => ReturnType<typeof getOrderingOrderReviewOpportunity>;
  projectors: readonly ProjectionHandlerSet[];
}>;

function maxCommitPosition(left: string | undefined, right: string | undefined) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return BigInt(right) > BigInt(left) ? right : left;
}

function orderingCommitMetadataFromStoredEvents(storedEvents: readonly StoredEvent[]): OrderingCommitMetadata {
  const commitEventIds = storedEvents.map((event) => String(event.eventId)).filter(Boolean);
  const maxGlobalPosition = storedEvents.reduce<string | undefined>(
    (current, event) => maxCommitPosition(current, String(event.globalPosition)),
    undefined,
  );

  if (!maxGlobalPosition) {
    return {};
  }

  return {
    commitPosition: maxGlobalPosition,
    commitEventIds,
    commitPositions: [
      {
        sourceContextName: "ordering",
        maxGlobalPosition,
        eventIds: commitEventIds,
      },
    ],
  };
}

function groupDemands(cartLines: readonly CheckoutOrderLineSnapshot[]) {
  const grouped = new Map<string, MarketplaceDemand & Readonly<{ quantity: number }>>();

  for (const line of cartLines) {
    const key = buildDemandSignature(line.productId);
    const existing = grouped.get(key);

    if (existing) {
      grouped.set(key, { ...existing, quantity: existing.quantity + line.quantity });
      continue;
    }

    grouped.set(key, {
      catalogItemId: line.catalogItemId as CatalogItemId,
      productId: line.productId as ProductKey,
      itemTitle: line.itemTitle,
      itemSubtitle: line.itemSubtitle,
      selectedOptions: line.selectedOptions,
      productSummary: line.productSummary,
      quantity: line.quantity,
    });
  }

  return [...grouped.values()];
}

function checkoutLineKey(line: CheckoutOrderLineSnapshot, index: number) {
  return line.cartLineId ?? line.lockedListingId ?? line.listingId ?? `${line.productId}:${index}`;
}

function isLockedCheckoutLine(line: CheckoutOrderLineSnapshot) {
  return line.fulfillmentMode === "locked-listing" || Boolean((line.lockedListingId ?? line.listingId)?.trim());
}

function enumerateDemandAllocations(demand: MarketplaceDemand, candidates: readonly MarketplaceSupplyCandidate[]) {
  assertSupplyAvailable(candidates, demand.quantity, `Not enough active supply is available for ${demand.itemTitle}.`);

  const results: DemandPlan[] = [];
  const search = (index: number, remaining: number, chosen: DemandAllocation[]) => {
    if (remaining === 0) {
      results.push({ demand, allocations: [...chosen] });
      return;
    }
    if (index >= candidates.length) {
      return;
    }

    const candidate = candidates[index]!;
    const maxQuantity = Math.min(candidate.availableQuantity, remaining);

    for (let quantity = maxQuantity; quantity >= 0; quantity -= 1) {
      if (quantity > 0) {
        chosen.push({ candidate, quantity });
      }
      search(index + 1, remaining - quantity, chosen);
      if (quantity > 0) {
        chosen.pop();
      }
    }
  };

  search(0, demand.quantity, []);

  if (results.length === 0) {
    throw new OrderingDomainError(`Not enough active supply is available for ${demand.itemTitle}.`);
  }

  return results;
}

function planShippingAllowanceBps(lines: SellerOrderDraft["lines"]) {
  const values = lines.map((line) => line.shippingAllowancePercentageBps);
  const unique = [...new Set(values)];
  if (values.length === 0) {
    return 500;
  }
  return unique.length === 1 ? (unique[0] ?? 500) : Math.min(...values);
}

function calculateShippingIncentive(
  params: Readonly<{
    sourceType: OrderSourceType;
    itemSubtotalAmount: string;
    shippingBaseAmount: string;
    shippingAllowancePercentageBps: number;
  }>,
) {
  const shippingBaseAmount = normalizeMoneyAmount(params.shippingBaseAmount, {
    fieldName: "Shipping base amount",
    allowZero: true,
  });
  const allowedAmount = applyBasisPointsToMoneyAmount(
    params.itemSubtotalAmount,
    params.shippingAllowancePercentageBps,
    "floor",
  );
  const earnedAmount =
    moneyToCents(shippingBaseAmount) <= moneyToCents(allowedAmount) ? shippingBaseAmount : allowedAmount;

  if (params.sourceType === "offer-acceptance") {
    return {
      shippingBaseAmount,
      shippingDiscountAmount: "0.00",
      shippingAllowanceAmount: earnedAmount,
      shippingOverageAmount: subtractNonNegativeMoneyAmounts(shippingBaseAmount, earnedAmount),
      sellerShippingPayoutAmount: earnedAmount,
      shippingChargeAmount: earnedAmount,
    };
  }

  const shippingChargeAmount = subtractNonNegativeMoneyAmounts(shippingBaseAmount, earnedAmount);
  return {
    shippingBaseAmount,
    shippingDiscountAmount: earnedAmount,
    shippingAllowanceAmount: earnedAmount,
    shippingOverageAmount: "0.00",
    sellerShippingPayoutAmount: shippingChargeAmount,
    shippingChargeAmount,
  };
}

function checkoutReservationKey(input: Pick<CheckoutInventoryReservationInput, "sellerAccountId" | "inventoryItemId">) {
  return `${input.sellerAccountId.trim()}|${input.inventoryItemId.trim()}`;
}

function checkoutReservationMap(reservations: readonly CheckoutInventoryReservationInput[] = []) {
  const map = new Map<string, CheckoutInventoryReservationInput[]>();
  for (const reservation of reservations) {
    const key = checkoutReservationKey(reservation);
    const existing = map.get(key) ?? [];
    existing.push(reservation);
    map.set(key, existing);
  }
  return map;
}

function consumeCheckoutReservationHoldId(
  reservations: Map<string, CheckoutInventoryReservationInput[]>,
  allocation: DemandAllocation,
) {
  const key = checkoutReservationKey({
    sellerAccountId: allocation.candidate.sellerAccountId,
    inventoryItemId: allocation.candidate.inventoryItemId,
  });
  const candidates = reservations.get(key);
  const index = candidates?.findIndex((reservation) => reservation.quantity === allocation.quantity) ?? -1;
  if (!candidates || index < 0) {
    return null;
  }

  const [reservation] = candidates.splice(index, 1);
  if (candidates.length === 0) {
    reservations.delete(key);
  }
  return reservation?.holdId ?? null;
}

function allocateCandidateFeeLocks(candidate: MarketplaceSupplyCandidate, quantity: number) {
  let remaining = quantity;
  const allocations: MarketplaceSupplyFeeLock[] = [];
  const feeLocks = candidate.feeLocks?.length
    ? candidate.feeLocks
    : [
        {
          unitCount: candidate.availableQuantity,
          marketplaceSalesFeeUnitAmount: candidate.marketplaceSalesFeeUnitAmount,
          sellerNetUnitAmount: candidate.sellerNetUnitAmount,
          shippingAllowancePercentageBps: candidate.shippingAllowancePercentageBps,
          termsScheduleId: candidate.termsScheduleId,
          termsAgreementId: candidate.termsAgreementId,
          termsResolvedAt: candidate.termsResolvedAt,
        },
      ];
  for (const lock of feeLocks) {
    if (remaining <= 0) break;
    const unitCount = Math.min(lock.unitCount, remaining);
    if (unitCount > 0) allocations.push({ ...lock, unitCount });
    remaining -= unitCount;
  }
  if (remaining !== 0) {
    throw new OrderingDomainError(`Listing ${candidate.listingId} does not have enough fee-locked units.`);
  }
  return allocations;
}

function quotePlan(
  demandPlans: readonly DemandPlan[],
  shippingOption: ShippingOption,
  shippingQuotePolicy: ShippingQuotePolicy,
  postagePolicy: PostagePolicy,
  priceOverrideAmount?: string,
  feeOverride?: Readonly<{
    marketplaceSalesFeeUnitAmount: string;
    sellerNetUnitAmount: string;
    termsScheduleId: string | null;
    termsAgreementId: string | null;
    termsResolvedAt: string;
    shippingAllowancePercentageBps?: number;
  }>,
  sourceType: OrderSourceType = "cart-checkout",
  sourceReferenceId: string | null = null,
  checkoutReservations: readonly CheckoutInventoryReservationInput[] = [],
): CheckoutPlan {
  const availableCheckoutReservations = checkoutReservationMap(checkoutReservations);
  const groupedBySellerAndOrigin = new Map<
    string,
    {
      sellerAccountId: string;
      lines: Array<SellerOrderDraft["lines"][number]>;
      reservations: Array<SellerOrderDraft["reservations"][number]>;
      sellerDisplayName: string | null;
      shippingOriginSnapshot: AddressSnapshot;
      subtotalCents: bigint;
      listingIds: Set<string>;
      quantity: number;
    }
  >();

  for (const demandPlan of demandPlans) {
    for (const allocation of demandPlan.allocations) {
      const shippingOriginSnapshot = normalizeAddressSnapshot(allocation.candidate.shipFromAddress, "Shipping origin");
      const sellerGroupKey = [allocation.candidate.sellerAccountId, JSON.stringify(shippingOriginSnapshot)].join("|");
      const sellerDraft = groupedBySellerAndOrigin.get(sellerGroupKey) ?? {
        sellerAccountId: allocation.candidate.sellerAccountId,
        lines: [],
        reservations: [],
        sellerDisplayName: allocation.candidate.sellerDisplayName,
        shippingOriginSnapshot,
        subtotalCents: 0n,
        listingIds: new Set<string>(),
        quantity: 0,
      };
      const unitPriceAmount = priceOverrideAmount ?? allocation.candidate.priceAmount;
      const feeAllocations = feeOverride
        ? [
            {
              unitCount: allocation.quantity,
              marketplaceSalesFeeUnitAmount: feeOverride.marketplaceSalesFeeUnitAmount,
              sellerNetUnitAmount: feeOverride.sellerNetUnitAmount,
              shippingAllowancePercentageBps:
                feeOverride.shippingAllowancePercentageBps ?? allocation.candidate.shippingAllowancePercentageBps,
              termsScheduleId: feeOverride.termsScheduleId,
              termsAgreementId: feeOverride.termsAgreementId,
              termsResolvedAt: feeOverride.termsResolvedAt,
            },
          ]
        : allocateCandidateFeeLocks(allocation.candidate, allocation.quantity);
      for (const feeAllocation of feeAllocations) {
        const lineTotalAmount = centsToMoneyAmount(moneyToCents(unitPriceAmount) * BigInt(feeAllocation.unitCount));
        const marketplaceSalesFeeTotalAmount = centsToMoneyAmount(
          moneyToCents(feeAllocation.marketplaceSalesFeeUnitAmount) * BigInt(feeAllocation.unitCount),
        );
        const sellerNetTotalAmount = centsToMoneyAmount(
          moneyToCents(feeAllocation.sellerNetUnitAmount) * BigInt(feeAllocation.unitCount),
        );
        sellerDraft.lines.push({
          lineId: createId("oli") as OrderLineId,
          listingId: allocation.candidate.listingId,
          inventoryItemId: allocation.candidate.inventoryItemId,
          catalogItemId: allocation.candidate.catalogItemId,
          productId: allocation.candidate.productId,
          itemTitle: allocation.candidate.itemTitle,
          itemSubtitle: allocation.candidate.itemSubtitle,
          selectedOptions: [...allocation.candidate.selectedOptions],
          productSummary: allocation.candidate.productSummary,
          productMeasureSnapshot: allocation.candidate.productMeasureSnapshot,
          gradedCard: allocation.candidate.gradedCard,
          unitPriceAmount,
          quantity: feeAllocation.unitCount,
          lineTotalAmount,
          marketplaceSalesFeeUnitAmount: feeAllocation.marketplaceSalesFeeUnitAmount,
          marketplaceSalesFeeTotalAmount,
          sellerNetUnitAmount: feeAllocation.sellerNetUnitAmount,
          sellerNetTotalAmount,
          termsScheduleId: feeAllocation.termsScheduleId,
          termsAgreementId: feeAllocation.termsAgreementId,
          termsResolvedAt: feeAllocation.termsResolvedAt,
          shippingAllowancePercentageBps: feeAllocation.shippingAllowancePercentageBps,
        });
        sellerDraft.subtotalCents += moneyToCents(lineTotalAmount);
      }
      sellerDraft.reservations.push({
        reservationRequestId: createId("rsv"),
        inventoryItemId: allocation.candidate.inventoryItemId,
        quantity: allocation.quantity,
        holdId: consumeCheckoutReservationHoldId(availableCheckoutReservations, allocation),
      });
      sellerDraft.sellerDisplayName = sellerDraft.sellerDisplayName ?? allocation.candidate.sellerDisplayName;
      sellerDraft.listingIds.add(allocation.candidate.listingId);
      sellerDraft.quantity += allocation.quantity;
      groupedBySellerAndOrigin.set(sellerGroupKey, sellerDraft);
    }
  }

  const orderDrafts: SellerOrderDraft[] = [];
  let totalAmount = 0n;
  let itemSubtotalAmount = 0n;

  for (const draft of groupedBySellerAndOrigin.values()) {
    const shippingAllowancePercentageBps = planShippingAllowanceBps(draft.lines);
    const draftSubtotalAmount = centsToMoneyAmount(draft.subtotalCents);
    const packagePlan = buildPackagePlan({
      shippingOption,
      itemSubtotalAmount: draftSubtotalAmount,
      postagePolicy,
      lines: draft.lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        measure: line.productMeasureSnapshot,
      })),
    });
    if (packagePlan.missingProductIds.length > 0) {
      throw new OrderingDomainError("Product measurements are required before checkout can be confirmed.");
    }
    const quote = shippingQuotePolicy.quote({
      sellerAccountId: draft.sellerAccountId,
      shippingOption,
      itemSubtotalAmount: draftSubtotalAmount,
      quantity: draft.quantity,
      listingCount: draft.listingIds.size,
      packagePlan,
    });
    const shippingEconomics = calculateShippingIncentive({
      sourceType,
      itemSubtotalAmount: draftSubtotalAmount,
      shippingBaseAmount: quote.baseAmount,
      shippingAllowancePercentageBps,
    });
    const orderTotalCents = draft.subtotalCents + moneyToCents(shippingEconomics.shippingChargeAmount);
    totalAmount += orderTotalCents;
    itemSubtotalAmount += draft.subtotalCents;

    orderDrafts.push({
      sellerAccountId: draft.sellerAccountId,
      sellerDisplayName: draft.sellerDisplayName,
      sourceType,
      sourceReferenceId,
      shippingOption,
      itemSubtotalAmount: draftSubtotalAmount,
      shippingBaseAmount: shippingEconomics.shippingBaseAmount,
      shippingDiscountAmount: shippingEconomics.shippingDiscountAmount,
      shippingAllowanceAmount: shippingEconomics.shippingAllowanceAmount,
      shippingOverageAmount: shippingEconomics.shippingOverageAmount,
      sellerShippingPayoutAmount: shippingEconomics.sellerShippingPayoutAmount,
      shippingChargeAmount: shippingEconomics.shippingChargeAmount,
      shippingPlanSnapshot: quote.packagePlan ?? packagePlan,
      salesTaxAmount: "0.00",
      totalAmount: centsToMoneyAmount(orderTotalCents),
      taxQuote: {
        taxableAmount: "0.00",
        taxAmount: "0.00",
        jurisdictionCountry: "US",
        jurisdictionState: null,
        rateBps: 0,
        itemTaxable: false,
        shippingTaxable: false,
        marketplaceCheckoutFeeTaxable: false,
        providerName: "not-quoted",
        providerQuoteReference: null,
        quotedAt: new Date().toISOString(),
      },
      shippingOriginSnapshot: draft.shippingOriginSnapshot,
      lines: draft.lines,
      reservations: draft.reservations,
    });
  }

  return {
    orderDrafts: orderDrafts.sort((left, right) => left.sellerAccountId.localeCompare(right.sellerAccountId)),
    totalAmount,
    itemSubtotalAmount,
    orderCount: orderDrafts.length,
  };
}

async function applyTaxToPlan(
  plan: CheckoutPlan,
  buyerAccountId: AccountId,
  shippingAddress: CheckoutShippingAddressSnapshot,
  taxQuoteResolver: TaxQuoteResolver,
): Promise<CheckoutPlan> {
  const orderDrafts: SellerOrderDraft[] = [];
  let totalAmount = 0n;

  for (const draft of plan.orderDrafts) {
    const taxQuote = await taxQuoteResolver.quoteTax({
      buyerAccountId,
      sellerAccountId: draft.sellerAccountId,
      currencyCode: "usd",
      destinationAddress: shippingAddress,
      itemSubtotalAmount: draft.itemSubtotalAmount,
      shippingAmount: draft.shippingChargeAmount,
    });
    const salesTaxAmount = normalizeMoneyAmount(taxQuote.taxAmount, {
      fieldName: "Sales tax amount",
      allowZero: true,
    });
    const orderTotal = sumMoneyAmounts([draft.itemSubtotalAmount, draft.shippingChargeAmount, salesTaxAmount]);
    totalAmount += moneyToCents(orderTotal);
    orderDrafts.push({
      ...draft,
      salesTaxAmount,
      totalAmount: orderTotal,
      taxQuote,
    });
  }

  return {
    ...plan,
    totalAmount,
    orderDrafts,
  };
}

function chooseBestPlan(
  demandOptions: readonly DemandPlan[][],
  shippingOption: ShippingOption,
  shippingQuotePolicy: ShippingQuotePolicy,
  postagePolicy: PostagePolicy,
  priceOverrideAmount?: string,
  feeOverride?: Readonly<{
    marketplaceSalesFeeUnitAmount: string;
    sellerNetUnitAmount: string;
    termsScheduleId: string | null;
    termsAgreementId: string | null;
    termsResolvedAt: string;
    shippingAllowancePercentageBps?: number;
  }>,
  sourceType: OrderSourceType = "cart-checkout",
  sourceReferenceId: string | null = null,
  optimizationGoal: "lowest-total" | "fewest-shipments" = "lowest-total",
  checkoutReservations: readonly CheckoutInventoryReservationInput[] = [],
) {
  let bestPlan: CheckoutPlan | null = null;
  const search = (index: number, chosen: DemandPlan[]) => {
    if (index >= demandOptions.length) {
      const plan = quotePlan(
        chosen,
        shippingOption,
        shippingQuotePolicy,
        postagePolicy,
        priceOverrideAmount,
        feeOverride,
        sourceType,
        sourceReferenceId,
        checkoutReservations,
      );
      const isBetter =
        optimizationGoal === "fewest-shipments"
          ? !bestPlan ||
            plan.orderCount < bestPlan.orderCount ||
            (plan.orderCount === bestPlan.orderCount && plan.totalAmount < bestPlan.totalAmount)
          : !bestPlan ||
            plan.totalAmount < bestPlan.totalAmount ||
            (plan.totalAmount === bestPlan.totalAmount && plan.itemSubtotalAmount < bestPlan.itemSubtotalAmount) ||
            (plan.totalAmount === bestPlan.totalAmount &&
              plan.itemSubtotalAmount === bestPlan.itemSubtotalAmount &&
              plan.orderCount < bestPlan.orderCount);
      if (isBetter) {
        bestPlan = plan;
      }
      return;
    }

    for (const option of demandOptions[index] ?? []) {
      chosen.push(option);
      search(index + 1, chosen);
      chosen.pop();
    }
  };

  search(0, []);
  if (!bestPlan) {
    throw new OrderingDomainError("No valid checkout plan could be created.");
  }
  return bestPlan;
}

function planTermsForLines(
  lines: SellerOrderDraft["lines"],
  fieldName: "termsScheduleId" | "termsAgreementId" | "termsResolvedAt",
) {
  const values = [...new Set(lines.map((line) => line[fieldName]))];
  return values.length === 1 ? values[0] : null;
}

async function buildDemandOptions(
  db: PgQueryable,
  buyerAccountId: string | null,
  demandGroups: readonly MarketplaceDemand[],
  sellerAccountId?: string,
  sourceType: OrderSourceType = "cart-checkout",
  sourceReferenceId = "",
) {
  const options: DemandPlan[][] = [];

  for (const demand of demandGroups) {
    const rawCandidates = await listOrderingSupplyCandidates(db, {
      ...demand,
      sellerAccountId,
    });
    const candidates = buyerAccountId
      ? await applyPurchaseLimitAvailability(db, buyerAccountId, rawCandidates, sourceType, sourceReferenceId)
      : rawCandidates;
    options.push(enumerateDemandAllocations(demand, candidates));
  }

  return options;
}

async function buildCheckoutDemandOptions(
  db: PgQueryable,
  buyerAccountId: string,
  lines: readonly CheckoutOrderLineSnapshot[],
  sourceType: OrderSourceType = "cart-checkout",
  sourceReferenceId = "",
) {
  const optimizedLines = lines.filter((line) => !isLockedCheckoutLine(line));
  const options: DemandPlan[][] = [];

  for (const line of lines.filter(isLockedCheckoutLine)) {
    const lockedListingId = (line.lockedListingId ?? line.listingId ?? "").trim();
    if (!lockedListingId) {
      throw new OrderingDomainError("Locked checkout line must reference a listing.");
    }
    const candidate = await getOrderingSupplyCandidateByListingId(db, lockedListingId);
    if (!candidate) {
      throw new OrderingDomainError(`Locked listing is not available for ${line.itemTitle}.`);
    }
    if (candidate.productId !== line.productId.trim()) {
      throw new OrderingDomainError("Locked listing does not match the selected product.");
    }
    const limitedCandidates = await applyPurchaseLimitAvailability(
      db,
      buyerAccountId,
      [candidate],
      sourceType,
      sourceReferenceId,
    );
    const limitedCandidate = limitedCandidates[0] ?? candidate;
    assertSupplyAvailable(
      [limitedCandidate],
      line.quantity,
      `Not enough active supply is available for ${candidate.itemTitle}.`,
    );
    options.push([
      {
        demand: {
          catalogItemId: limitedCandidate.catalogItemId,
          productId: limitedCandidate.productId,
          itemTitle: limitedCandidate.itemTitle,
          itemSubtitle: limitedCandidate.itemSubtitle,
          selectedOptions: limitedCandidate.selectedOptions,
          productSummary: limitedCandidate.productSummary,
          quantity: line.quantity,
        },
        allocations: [{ candidate: limitedCandidate, quantity: line.quantity }],
      },
    ]);
  }

  if (optimizedLines.length > 0) {
    options.push(
      ...(await buildDemandOptions(
        db,
        buyerAccountId,
        groupDemands(optimizedLines),
        undefined,
        sourceType,
        sourceReferenceId,
      )),
    );
  }

  return options;
}

function previewRevision(preview: Omit<CheckoutFulfillmentPreview, "revision">) {
  return [
    preview.optimizationGoal,
    preview.readyLineKeys.join(","),
    preview.unavailableLineKeys.join(","),
    preview.sellerGroups
      .map((group) =>
        [
          group.sellerAccountId,
          group.sellerDisplayName ?? "",
          group.totalAmount,
          group.postageRequirements.policyVersion,
          group.postageRequirements.parcelRequired ? "parcel" : "letter-eligible",
          group.postageRequirements.parcelReasons.join("+"),
          group.postageRequirements.signatureRequired ? "signature" : "no-signature",
          group.postageRequirements.signatureReasons.join("+"),
          group.postageRequirements.insuranceRequired ? "insurance" : "no-insurance",
          group.postageRequirements.insuranceReasons.join("+"),
          group.postageRequirements.insuredValueAmount ?? "",
          group.postageRequirements.shippingEvidenceTier,
          group.deliveryEstimate.earliestDate,
          group.deliveryEstimate.latestDate,
          group.deliveryEstimate.basis,
          group.lines
            .map((line) =>
              [
                line.lineKey,
                line.listingId,
                line.quantity,
                line.estimatedUnitPriceAmount,
                line.priceState,
                line.materialChangeReasons.join("+"),
              ].join(":"),
            )
            .join("|"),
        ].join("="),
      )
      .join(";"),
    preview.totals.totalAmount,
    preview.authenticityCheckOffer?.quote_fingerprint ?? "no-authenticity-check-offer",
  ].join("#");
}

function fulfillmentDeliveryPromiseForDraft(
  draft: SellerOrderDraft,
  shippingDestinationSnapshot: CheckoutShippingAddressSnapshot | null | undefined,
  authenticityCheckSelected?: boolean,
) {
  const postagePolicySnapshot = requirePostagePolicySnapshot(draft);
  const serviceLevels = [
    ...draft.shippingPlanSnapshot.packages.map((pkg) => pkg.serviceLevel),
    ...(postagePolicySnapshot.signatureRequired ? ["signature-required"] : []),
    ...(postagePolicySnapshot.insuranceRequired ? ["insurance-required"] : []),
    postagePolicySnapshot.shippingEvidenceTier,
  ];

  return createFulfillmentDeliveryPromise({
    shippingOption: draft.shippingOption,
    packageCount: draft.shippingPlanSnapshot.packageCount,
    serviceLevels,
    shipFrom: draft.shippingOriginSnapshot,
    shipTo: shippingDestinationSnapshot,
    authenticityCheckSelected,
  });
}

/**
 * Resolves the authenticity-check opt-in offer (m109) for a checkout
 * plan: single-seller only in v1 (mirrors the issue's own "all lines are
 * eligible (single seller -- already the order shape)" simplification),
 * banded on the declared item subtotal of that one seller order. Returns
 * null when the plan spans more than one seller or the policy resolver
 * host port is not wired (feature effectively off), rather than an
 * ineligible quote, so callers can distinguish "not offered" from
 * "offered but below threshold."
 */
async function resolveAuthenticityCheckOffer(
  deps: Pick<OrderRuntimeDeps, "authenticityFeePolicyResolver">,
  plan: Pick<CheckoutPlan, "orderDrafts">,
): Promise<AuthenticityCheckFeeQuote | null> {
  if (!deps.authenticityFeePolicyResolver || plan.orderDrafts.length !== 1) {
    return null;
  }

  const draft = plan.orderDrafts[0]!;
  const resolved = await deps.authenticityFeePolicyResolver.resolveAuthenticityFeePolicy();
  return quoteAuthenticityCheckFee({ orderValueAmount: draft.itemSubtotalAmount, category: "any" }, resolved.value);
}

/**
 * Validates and freezes the buyer's authenticity-check opt-in at order
 * creation. Re-resolves the policy and recomputes the fee live against the
 * committed order value rather than trusting the client-supplied amount --
 * the buyer only supplies the fingerprint of the quote they saw at opt-in
 * time, which must match Ordering's authoritative recomputation exactly
 * (order value, category, and policy version) or the whole checkout
 * submission is rejected as stale (`authenticity_fee_quote_stale`),
 * mirroring the marketplace checkout fee's `fee_quote_stale` 409 pattern.
 */
async function resolveAuthenticityCheckOptIn(
  deps: Pick<OrderRuntimeDeps, "authenticityFeePolicyResolver">,
  plan: Pick<CheckoutPlan, "orderDrafts">,
  optIn: Readonly<{ selected: true; quoteFingerprint: string }> | null | undefined,
): Promise<AuthenticityCheckFeeQuote | null> {
  if (!optIn?.selected) {
    return null;
  }

  const offer = await resolveAuthenticityCheckOffer(deps, plan);
  if (!offer || !offer.eligible) {
    throw new OrderingDomainError("Authenticity check is no longer available for this order.");
  }
  if (offer.quote_fingerprint !== optIn.quoteFingerprint) {
    throw new OrderingDomainError(`authenticity_fee_quote_stale:${JSON.stringify(offer)}`);
  }

  return offer;
}

function requirePostagePolicySnapshot(draft: SellerOrderDraft) {
  const snapshot = draft.shippingPlanSnapshot.postagePolicySnapshot;
  if (!snapshot) {
    throw new OrderingDomainError("Shipping plan is missing a postage policy snapshot.");
  }
  return snapshot;
}

function postageRequirementsForDraft(draft: SellerOrderDraft) {
  const snapshot = requirePostagePolicySnapshot(draft);
  return {
    policyVersion: snapshot.policyVersion,
    parcelRequired: snapshot.parcelRequired,
    parcelReasons: snapshot.parcelReasons,
    signatureRequired: snapshot.signatureRequired,
    signatureReasons: snapshot.signatureReasons,
    insuranceRequired: snapshot.insuranceRequired,
    insuranceReasons: snapshot.insuranceReasons,
    insuredValueAmount: snapshot.insuredValueAmount,
    shippingEvidenceTier: snapshot.shippingEvidenceTier,
  };
}

function planToPreview(
  params: Readonly<{
    plan: CheckoutPlan;
    sourceLines: readonly CheckoutOrderLineSnapshot[];
    optimizationGoal: "lowest-total" | "fewest-shipments";
    shippingDestinationSnapshot?: CheckoutShippingAddressSnapshot | null;
    unavailableLines: CheckoutFulfillmentPreview["unavailableLines"];
    authenticityCheckOptIn?: boolean;
    authenticityCheckOffer?: AuthenticityCheckFeeQuote | null;
  }>,
): CheckoutFulfillmentPreview {
  const lineKeysByDemand = new Map<string, string[]>();
  params.sourceLines.forEach((line, index) => {
    const key = buildDemandSignature(line.productId);
    lineKeysByDemand.set(key, [...(lineKeysByDemand.get(key) ?? []), checkoutLineKey(line, index)]);
  });

  const readyLineKeys = params.sourceLines
    .map(checkoutLineKey)
    .filter((key) => !params.unavailableLines.some((line) => line.lineKey === key));
  const sellerGroups = params.plan.orderDrafts.map((draft) => ({
    sellerAccountId: draft.sellerAccountId,
    sellerDisplayName: draft.sellerDisplayName,
    itemSubtotalAmount: draft.itemSubtotalAmount,
    shippingChargeAmount: draft.shippingChargeAmount,
    salesTaxAmount: draft.salesTaxAmount,
    totalAmount: draft.totalAmount,
    postageRequirements: postageRequirementsForDraft(draft),
    deliveryEstimate: fulfillmentDeliveryPromiseForDraft(
      draft,
      params.shippingDestinationSnapshot,
      params.authenticityCheckOptIn,
    ),
    lines: draft.lines.map((line) => {
      const demandKey = buildDemandSignature(line.productId);
      const lineKey = lineKeysByDemand.get(demandKey)?.shift() ?? line.listingId;
      const sourceLine = params.sourceLines.find((source, index) => checkoutLineKey(source, index) === lineKey);
      const locked = sourceLine ? isLockedCheckoutLine(sourceLine) : false;
      return {
        lineKey,
        listingId: line.listingId,
        sellerAccountId: draft.sellerAccountId,
        inventoryItemId: line.inventoryItemId,
        catalogItemId: line.catalogItemId,
        productId: line.productId,
        itemTitle: line.itemTitle,
        productSummary: line.productSummary,
        quantity: line.quantity,
        estimatedUnitPriceAmount: line.unitPriceAmount,
        estimatedLineTotalAmount: line.lineTotalAmount,
        priceState: locked ? ("locked" as const) : ("available" as const),
        materialChangeReasons: [] as string[],
      };
    }),
  }));
  const shippingAmount = sumMoneyAmounts(params.plan.orderDrafts.map((draft) => draft.shippingChargeAmount));
  const salesTaxAmount = sumMoneyAmounts(params.plan.orderDrafts.map((draft) => draft.salesTaxAmount));
  const materialChangeReasons = sellerGroups.flatMap((group) =>
    group.lines.flatMap((line) => line.materialChangeReasons),
  );
  // The payable total reflects the authenticity check fee only once the
  // buyer has actually opted in (not merely because the order is
  // eligible) -- otherwise the preview would overstate the total for
  // buyers who never selected it.
  const authenticityCheckFeeAmount =
    params.authenticityCheckOptIn && params.authenticityCheckOffer?.eligible
      ? params.authenticityCheckOffer.fee_amount
      : "0.00";
  const withoutRevision = {
    optimizationGoal: params.optimizationGoal,
    readyLineKeys,
    unavailableLineKeys: params.unavailableLines.map((line) => line.lineKey),
    sellerGroups,
    totals: {
      itemSubtotalAmount: centsToMoneyAmount(params.plan.itemSubtotalAmount),
      shippingAmount,
      salesTaxAmount,
      totalAmount: addMoneyAmounts(centsToMoneyAmount(params.plan.totalAmount), authenticityCheckFeeAmount),
      packageCount: params.plan.orderCount,
    },
    unavailableLines: params.unavailableLines,
    materialChangeReasons,
    authenticityCheckOffer: params.authenticityCheckOffer ?? null,
  };

  return {
    ...withoutRevision,
    revision: previewRevision(withoutRevision),
  };
}

export function createOrderingOrderRuntime(deps: OrderRuntimeDeps): OrderingOrderServices {
  const taxQuoteResolver = deps.taxQuoteResolver ?? zeroTaxQuoteResolver;
  const postagePolicyResolver = deps.postagePolicyResolver ?? defaultPostagePolicyResolver;
  const paymentDeadlinePolicy = deps.paymentDeadlinePolicy ?? defaultOrderPaymentDeadlinePolicy;
  const notificationOutbox = deps.notificationOutbox ?? createNoopNotificationOutbox();
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<OrderingOrderEvent>(),
    initialState: () => initialOrderingOrderState,
    evolve: evolveOrderingOrder,
    decide: decideOrderingOrder,
  });

  const createOrdersFromPlan = async (
    buyerAccountId: AccountId,
    plan: CheckoutPlan,
    shippingDestinationSnapshot: AddressSnapshot,
    context: EventStoreContext,
    orderIdsOverride?: readonly OrderId[],
    authenticityPlan?: AuthenticityCheckFeeQuote | null,
  ) => {
    if (orderIdsOverride && orderIdsOverride.length !== plan.orderDrafts.length) {
      throw new OrderingDomainError("Order seed overrides must match the number of generated seller orders.");
    }
    if (authenticityPlan && plan.orderDrafts.length !== 1) {
      throw new OrderingDomainError("Authenticity check requires a single-seller order.");
    }

    const orderIds: OrderId[] = [];
    const storedEvents: StoredEvent[] = [];

    for (const [draftIndex, draft] of plan.orderDrafts.entries()) {
      const marketplaceSalesFeeAmount = sumMoneyAmounts(draft.lines.map((line) => line.marketplaceSalesFeeTotalAmount));
      const sellerNetAmount = sumMoneyAmounts(draft.lines.map((line) => line.sellerNetTotalAmount));
      const sellerPayoutAmount = addMoneyAmounts(sellerNetAmount, draft.sellerShippingPayoutAmount);
      const shippingAllowancePercentageBps = planShippingAllowanceBps(draft.lines);
      const firstLine = draft.lines[0];
      const termsScheduleId = firstLine ? planTermsForLines(draft.lines, "termsScheduleId") : null;
      const termsAgreementId = firstLine ? planTermsForLines(draft.lines, "termsAgreementId") : null;
      const termsResolvedAt = firstLine
        ? (planTermsForLines(draft.lines, "termsResolvedAt") ?? new Date().toISOString())
        : new Date().toISOString();
      const orderId = orderIdsOverride?.[draftIndex] ?? (createId("ord") as OrderId);
      // The authenticity fee is a buyer-charged addition to the order total
      // (like tax), applied to the sole seller order draft when the buyer
      // opted in -- v1 is single-seller only (asserted above).
      const authenticityFeeAmount = draftIndex === 0 ? (authenticityPlan?.fee_amount ?? null) : null;
      const totalAmount = authenticityFeeAmount
        ? addMoneyAmounts(draft.totalAmount, authenticityFeeAmount)
        : draft.totalAmount;
      const result = await commandHandler({
        streamId: `ordering.order-${orderId}`,
        command: {
          type: "CreateOrder",
          orderId,
          sourceType: draft.sourceType,
          sourceReferenceId: draft.sourceReferenceId,
          buyerAccountId,
          sellerAccountId: draft.sellerAccountId as AccountId,
          shippingOption: draft.shippingOption,
          itemSubtotalAmount: draft.itemSubtotalAmount,
          shippingBaseAmount: draft.shippingBaseAmount,
          shippingDiscountAmount: draft.shippingDiscountAmount,
          shippingAllowanceAmount: draft.shippingAllowanceAmount,
          shippingOverageAmount: draft.shippingOverageAmount,
          shippingChargeAmount: draft.shippingChargeAmount,
          shippingPlanSnapshot: draft.shippingPlanSnapshot,
          salesTaxAmount: draft.salesTaxAmount,
          totalAmount,
          authenticityPlanSnapshot:
            authenticityFeeAmount && authenticityPlan
              ? {
                  feeAmount: authenticityFeeAmount,
                  payer: "buyer",
                  policyVersion: authenticityPlan.policy_version,
                  category: authenticityPlan.category,
                  thresholdAmount: authenticityPlan.threshold_amount,
                  orderValueAmount: authenticityPlan.order_value_amount,
                  quotedAt: authenticityPlan.quoted_at,
                }
              : null,
          taxSnapshot: {
            taxableAmount: draft.taxQuote.taxableAmount,
            salesTaxAmount: draft.salesTaxAmount,
            jurisdictionCountry: draft.taxQuote.jurisdictionCountry,
            jurisdictionState: draft.taxQuote.jurisdictionState,
            rateBps: draft.taxQuote.rateBps,
            providerName: draft.taxQuote.providerName,
            providerQuoteReference: draft.taxQuote.providerQuoteReference,
            quotedAt: draft.taxQuote.quotedAt,
          },
          commercialTermsSnapshot: {
            marketplaceSalesFeeAmount,
            sellerNetAmount,
            sellerItemNetAmount: sellerNetAmount,
            shippingAllowanceAmount: draft.shippingAllowanceAmount,
            sellerShippingPayoutAmount: draft.sellerShippingPayoutAmount,
            sellerPayoutAmount,
            shippingAllowancePercentageBps,
            termsScheduleId,
            termsAgreementId,
            termsResolvedAt,
          },
          shippingDestinationSnapshot,
          shippingOriginSnapshot: draft.shippingOriginSnapshot,
          lines: [...draft.lines],
          reservationRequests: draft.reservations.map((reservation) => ({
            reservationRequestId: reservation.reservationRequestId,
            inventoryItemId: reservation.inventoryItemId,
            sellerAccountId: draft.sellerAccountId,
            quantity: reservation.quantity,
            holdId: reservation.holdId,
          })),
        },
        context,
      });
      storedEvents.push(...result.storedEvents);

      orderIds.push(orderId);
    }

    return {
      orderIds,
      ...orderingCommitMetadataFromStoredEvents(storedEvents),
    };
  };

  const buildAcceptedOfferPlan = async (
    params: Readonly<{
      offerId: string;
      buyerAccountId: AccountId;
      sellerAccountId: AccountId;
      catalogItemId: string;
      productId: string;
      itemTitle: string;
      itemSubtitle: string | null;
      selectedOptions: { dimensionId: string; optionId: string }[];
      productSummary: string | null;
      priceAmount: string;
      marketplaceSalesFeeUnitAmount: string;
      sellerNetUnitAmount: string;
      termsScheduleId: string | null;
      termsAgreementId: string | null;
      termsResolvedAt: string;
      shippingAllowancePercentageBps?: number;
      shippingDestinationSnapshot: AddressSnapshot;
      quantityRequested: number;
    }>,
  ) => {
    const demandGroups: MarketplaceDemand[] = [
      {
        catalogItemId: params.catalogItemId as CatalogItemId,
        productId: params.productId as ProductKey,
        itemTitle: params.itemTitle,
        itemSubtitle: params.itemSubtitle,
        selectedOptions: params.selectedOptions,
        productSummary: params.productSummary,
        quantity: params.quantityRequested,
      },
    ];
    const demandOptions = await buildDemandOptions(deps.db, null, demandGroups, params.sellerAccountId);
    const postagePolicy = await postagePolicyResolver();
    const acceptedOfferPriceAmount = normalizeMoneyAmount(params.priceAmount, {
      fieldName: "Accepted offer price",
    });
    const plan = chooseBestPlan(
      demandOptions,
      "standard",
      deps.shippingQuotePolicy,
      postagePolicy,
      acceptedOfferPriceAmount,
      {
        marketplaceSalesFeeUnitAmount: normalizeMoneyAmount(params.marketplaceSalesFeeUnitAmount, {
          fieldName: "Accepted offer marketplace sales fee",
          allowZero: true,
        }),
        sellerNetUnitAmount: normalizeMoneyAmount(params.sellerNetUnitAmount, {
          fieldName: "Accepted offer seller net",
          allowZero: true,
        }),
        termsScheduleId: params.termsScheduleId,
        termsAgreementId: params.termsAgreementId,
        termsResolvedAt: params.termsResolvedAt,
        shippingAllowancePercentageBps: params.shippingAllowancePercentageBps,
      },
      "offer-acceptance",
      params.offerId,
    );
    const taxAdjustedPlan = await applyTaxToPlan(
      plan,
      params.buyerAccountId,
      normalizeAddressSnapshot(params.shippingDestinationSnapshot, "Shipping destination"),
      taxQuoteResolver,
    );
    return taxAdjustedPlan;
  };

  const createOrdersFromAcceptedOffer = async (
    params: Readonly<{
      offerId: string;
      buyerAccountId: AccountId;
      sellerAccountId: AccountId;
      catalogItemId: string;
      productId: string;
      itemTitle: string;
      itemSubtitle: string | null;
      selectedOptions: { dimensionId: string; optionId: string }[];
      productSummary: string | null;
      priceAmount: string;
      marketplaceSalesFeeUnitAmount: string;
      sellerNetUnitAmount: string;
      termsScheduleId: string | null;
      termsAgreementId: string | null;
      termsResolvedAt: string;
      shippingAllowancePercentageBps?: number;
      shippingDestinationSnapshot: AddressSnapshot;
      quantityRequested: number;
      orderIdsOverride?: readonly OrderId[];
    }>,
    context: EventStoreContext,
  ) => {
    const taxAdjustedPlan = await buildAcceptedOfferPlan(params);
    const result = await createOrdersFromPlan(
      params.buyerAccountId,
      taxAdjustedPlan,
      normalizeAddressSnapshot(params.shippingDestinationSnapshot, "Shipping destination"),
      context,
      params.orderIdsOverride,
    );
    return result;
  };

  const createOrdersFromAcceptedOfferBatch: OrderingOrderServices["createOrdersFromAcceptedOfferBatch"] = async (
    params,
    context,
  ) => {
    const groupedByBuyerAndDestination = new Map<
      string,
      {
        buyerAccountId: AccountId;
        shippingDestinationSnapshot: AddressSnapshot;
        drafts: SellerOrderDraft[];
      }
    >();

    for (const offer of params.offers) {
      const shippingDestinationSnapshot = normalizeAddressSnapshot(
        offer.shippingDestinationSnapshot,
        "Shipping destination",
      );
      const plan = await buildAcceptedOfferPlan({
        ...offer,
        offerId: params.acceptanceBatchId,
      });
      for (const draft of plan.orderDrafts) {
        const groupKey = [offer.buyerAccountId, JSON.stringify(shippingDestinationSnapshot)].join("|");
        const group = groupedByBuyerAndDestination.get(groupKey) ?? {
          buyerAccountId: offer.buyerAccountId,
          shippingDestinationSnapshot,
          drafts: [],
        };
        const drafts = group.drafts;
        drafts.push({
          ...draft,
          sourceReferenceId: params.acceptanceBatchId,
        });
        groupedByBuyerAndDestination.set(groupKey, {
          ...group,
          drafts,
        });
      }
    }

    const orderIds: OrderId[] = [];
    for (const group of groupedByBuyerAndDestination.values()) {
      const mergedBySeller = new Map<string, SellerOrderDraft>();

      for (const draft of group.drafts) {
        const sellerOriginKey = [draft.sellerAccountId, JSON.stringify(draft.shippingOriginSnapshot)].join("|");
        const existing = mergedBySeller.get(sellerOriginKey);
        if (!existing) {
          mergedBySeller.set(sellerOriginKey, draft);
          continue;
        }

        const lines = [...existing.lines, ...draft.lines];
        const reservations = [...existing.reservations, ...draft.reservations];
        const itemSubtotalAmount = addMoneyAmounts(existing.itemSubtotalAmount, draft.itemSubtotalAmount);
        const listingIds = new Set(lines.map((line) => line.listingId));
        const quantity = lines.reduce((sum, line) => sum + line.quantity, 0);
        const postagePolicy = await postagePolicyResolver();
        const packagePlan = buildPackagePlan({
          shippingOption: draft.shippingOption,
          itemSubtotalAmount,
          postagePolicy,
          lines: lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            measure: line.productMeasureSnapshot,
          })),
        });
        if (packagePlan.missingProductIds.length > 0) {
          throw new OrderingDomainError("Product measurements are required before checkout can be confirmed.");
        }
        const quote = deps.shippingQuotePolicy.quote({
          sellerAccountId: draft.sellerAccountId,
          shippingOption: draft.shippingOption,
          itemSubtotalAmount,
          quantity,
          listingCount: listingIds.size,
          packagePlan,
        });
        const shippingAllowancePercentageBps = planShippingAllowanceBps(lines);
        const shippingEconomics = calculateShippingIncentive({
          sourceType: "offer-acceptance",
          itemSubtotalAmount,
          shippingBaseAmount: quote.baseAmount,
          shippingAllowancePercentageBps,
        });
        mergedBySeller.set(sellerOriginKey, {
          ...existing,
          itemSubtotalAmount,
          shippingBaseAmount: shippingEconomics.shippingBaseAmount,
          shippingDiscountAmount: shippingEconomics.shippingDiscountAmount,
          shippingAllowanceAmount: shippingEconomics.shippingAllowanceAmount,
          shippingOverageAmount: shippingEconomics.shippingOverageAmount,
          sellerShippingPayoutAmount: shippingEconomics.sellerShippingPayoutAmount,
          shippingChargeAmount: shippingEconomics.shippingChargeAmount,
          shippingPlanSnapshot: quote.packagePlan ?? packagePlan,
          salesTaxAmount: "0.00",
          totalAmount: addMoneyAmounts(itemSubtotalAmount, shippingEconomics.shippingChargeAmount),
          lines,
          reservations,
        });
      }

      const taxAdjustedPlan = await applyTaxToPlan(
        {
          orderDrafts: [...mergedBySeller.values()],
          totalAmount: 0n,
          itemSubtotalAmount: 0n,
          orderCount: mergedBySeller.size,
        },
        group.buyerAccountId,
        group.shippingDestinationSnapshot,
        taxQuoteResolver,
      );
      const buyerOrderResult = await createOrdersFromPlan(
        group.buyerAccountId,
        taxAdjustedPlan,
        group.shippingDestinationSnapshot,
        context,
      );
      orderIds.push(...buyerOrderResult.orderIds);
    }

    return { orderIds };
  };

  return {
    commandHandler,
    previewCheckoutFulfillment: async (params) => {
      const optimizationGoal = params.optimizationGoal ?? "lowest-total";
      const unavailableLines: Array<CheckoutFulfillmentPreview["unavailableLines"][number]> = [];
      const readyLines: CheckoutOrderLineSnapshot[] = [];

      for (const [index, line] of params.lines.entries()) {
        const lineKey = checkoutLineKey(line, index);
        try {
          if (isLockedCheckoutLine(line)) {
            const lockedListingId = (line.lockedListingId ?? line.listingId ?? "").trim();
            const candidate = lockedListingId
              ? await getOrderingSupplyCandidateByListingId(deps.db, lockedListingId)
              : null;
            if (!candidate) {
              unavailableLines.push({
                lineKey,
                catalogItemId: line.catalogItemId as CatalogItemId,
                productId: line.productId as ProductKey,
                itemTitle: line.itemTitle,
                productSummary: line.productSummary,
                quantity: line.quantity,
                reason: "Locked listing is unavailable.",
              });
              continue;
            }
            if (candidate.productId !== line.productId.trim()) {
              unavailableLines.push({
                lineKey,
                catalogItemId: line.catalogItemId,
                productId: line.productId,
                itemTitle: line.itemTitle,
                productSummary: line.productSummary,
                quantity: line.quantity,
                reason: "Locked listing does not match this product.",
              });
              continue;
            }
            if (candidate.availableQuantity < line.quantity) {
              unavailableLines.push({
                lineKey,
                catalogItemId: line.catalogItemId,
                productId: line.productId,
                itemTitle: line.itemTitle,
                productSummary: line.productSummary,
                quantity: line.quantity,
                reason: "Locked listing has insufficient quantity.",
              });
              continue;
            }
            const limitedCandidates = await applyPurchaseLimitAvailability(
              deps.db,
              params.buyerAccountId,
              [candidate],
              params.sourceType,
              params.checkoutSessionId,
            );
            const allowedQuantity = limitedCandidates[0]?.availableQuantity ?? candidate.availableQuantity;
            if (allowedQuantity < line.quantity) {
              unavailableLines.push({
                lineKey,
                catalogItemId: line.catalogItemId,
                productId: line.productId,
                itemTitle: line.itemTitle,
                productSummary: line.productSummary,
                quantity: line.quantity,
                reason: listingPurchaseLimitReachedReason,
              });
              continue;
            }
          } else {
            const candidates = await applyPurchaseLimitAvailability(
              deps.db,
              params.buyerAccountId,
              await listOrderingSupplyCandidates(deps.db, {
                catalogItemId: line.catalogItemId as CatalogItemId,
                productId: line.productId as ProductKey,
                itemTitle: line.itemTitle,
                itemSubtitle: line.itemSubtitle,
                selectedOptions: line.selectedOptions,
                productSummary: line.productSummary,
                quantity: line.quantity,
              }),
              params.sourceType,
              params.checkoutSessionId,
            );
            const availableQuantity = candidates.reduce((sum, candidate) => sum + candidate.availableQuantity, 0);
            if (availableQuantity < line.quantity) {
              unavailableLines.push({
                lineKey,
                catalogItemId: line.catalogItemId,
                productId: line.productId,
                itemTitle: line.itemTitle,
                productSummary: line.productSummary,
                quantity: line.quantity,
                reason: "No active supply can fulfill this product.",
              });
              continue;
            }
          }
          readyLines.push(line);
        } catch (error) {
          unavailableLines.push({
            lineKey,
            catalogItemId: line.catalogItemId,
            productId: line.productId,
            itemTitle: line.itemTitle,
            productSummary: line.productSummary,
            quantity: line.quantity,
            reason: error instanceof Error ? error.message : "This line cannot be fulfilled.",
          });
        }
      }

      if (readyLines.length === 0) {
        const withoutRevision = {
          optimizationGoal,
          readyLineKeys: [],
          unavailableLineKeys: unavailableLines.map((line) => line.lineKey),
          sellerGroups: [],
          totals: {
            itemSubtotalAmount: "0.00",
            shippingAmount: "0.00",
            salesTaxAmount: "0.00",
            totalAmount: "0.00",
            packageCount: 0,
          },
          unavailableLines,
          materialChangeReasons: ["unavailable-lines"],
          authenticityCheckOffer: null,
        };
        return {
          ...withoutRevision,
          revision: previewRevision(withoutRevision),
        };
      }

      const demandOptions = await buildCheckoutDemandOptions(
        deps.db,
        params.buyerAccountId,
        readyLines,
        params.sourceType,
        params.checkoutSessionId,
      );
      const postagePolicy = await postagePolicyResolver();
      const plan = chooseBestPlan(
        demandOptions,
        params.shippingOption,
        deps.shippingQuotePolicy,
        postagePolicy,
        undefined,
        undefined,
        params.sourceType,
        params.checkoutSessionId,
        optimizationGoal,
      );
      await assertPlanPurchaseLimits(deps.db, params.buyerAccountId, plan, params.sourceType, params.checkoutSessionId);
      const taxAdjustedPlan = await applyTaxToPlan(
        plan,
        params.buyerAccountId,
        params.shippingAddress ?? {
          name: "Checkout destination pending",
          line1: "Checkout preview destination pending",
          line2: null,
          city: "Unknown",
          state: "ZZ",
          postalCode: "00000",
          country: "US",
        },
        taxQuoteResolver,
      );

      const authenticityCheckOffer = await resolveAuthenticityCheckOffer(deps, taxAdjustedPlan);

      return planToPreview({
        plan: taxAdjustedPlan,
        sourceLines: readyLines,
        optimizationGoal,
        shippingDestinationSnapshot: params.shippingAddress ?? null,
        unavailableLines,
        authenticityCheckOptIn: params.authenticityCheckOptIn,
        authenticityCheckOffer,
      });
    },
    createOrdersFromCheckout: async (params, context) => {
      const existingOrderIds = await listOrderIdsForSource(deps.db, params.sourceType, params.checkoutSessionId);
      if (existingOrderIds.length > 0) {
        return { orderIds: existingOrderIds as OrderId[] };
      }

      if (params.lines.length === 0) {
        throw new OrderingDomainError("Checkout must contain at least one line.");
      }

      const preview = await createOrderingOrderRuntime(deps).previewCheckoutFulfillment({
        ...params,
        authenticityCheckOptIn: Boolean(params.authenticityCheckOptIn?.selected),
      });
      if (preview.readyLineKeys.length === 0) {
        throw new OrderingDomainError("No checkout lines are currently fulfillable.");
      }
      if (
        params.fulfillmentPreviewRevision &&
        params.fulfillmentPreviewRevision !== preview.revision &&
        !params.acknowledgedMaterialChanges
      ) {
        throw new OrderingDomainError("Fulfillment changed. Review the latest checkout preview before continuing.");
      }
      const readyLines = params.lines.filter((line, index) =>
        preview.readyLineKeys.includes(checkoutLineKey(line, index)),
      );
      const demandOptions = await buildCheckoutDemandOptions(
        deps.db,
        params.buyerAccountId,
        readyLines,
        params.sourceType,
        params.checkoutSessionId,
      );
      const postagePolicy = await postagePolicyResolver();
      const plan = chooseBestPlan(
        demandOptions,
        params.shippingOption,
        deps.shippingQuotePolicy,
        postagePolicy,
        undefined,
        undefined,
        params.sourceType,
        params.checkoutSessionId,
        params.optimizationGoal ?? "lowest-total",
        params.checkoutReservations ?? [],
      );
      await assertPlanPurchaseLimits(deps.db, params.buyerAccountId, plan, params.sourceType, params.checkoutSessionId);
      if (params.customerAccountIsGuest && (await planHasAccountScopedPurchaseLimits(deps.db, plan))) {
        throw new OrderingDomainError(
          "Sign in is required to confirm checkout for listings with daily or customer purchase limits.",
        );
      }
      await claimPlanPurchaseLimitUsage(deps.db, params.buyerAccountId, plan);
      const taxAdjustedPlan = await applyTaxToPlan(
        plan,
        params.buyerAccountId,
        normalizeAddressSnapshot(params.shippingAddress, "Shipping destination"),
        taxQuoteResolver,
      );
      const authenticityPlan = await resolveAuthenticityCheckOptIn(
        deps,
        taxAdjustedPlan,
        params.authenticityCheckOptIn,
      );
      const result = await createOrdersFromPlan(
        params.buyerAccountId,
        taxAdjustedPlan,
        normalizeAddressSnapshot(params.shippingAddress, "Shipping destination"),
        context,
        params.orderIdsOverride,
        authenticityPlan,
      );

      return result;
    },
    createOrdersFromAcceptedOffer,
    createOrdersFromAcceptedOfferBatch,
    cancelPurchase: async (params, context) => {
      const order = await getPurchase(deps.db, params.orderId, params.buyerAccountId);
      if (!order) {
        throw new OrderingDomainError("Purchase not found.");
      }
      if (!isCancelableOrderStatus(order.status) && !order.self_service_cancellation_available) {
        throw new OrderingDomainError(
          order.cancellation_unavailable_reason === "fulfillment-started"
            ? "Purchase cancellation is now handled through support because fulfillment has started."
            : "Only pending purchases can be cancelled.",
        );
      }

      const result = await commandHandler({
        streamId: `ordering.order-${params.orderId}`,
        command: {
          type: "CancelOrder",
          cancelledAt: new Date().toISOString(),
          reason: "buyer-cancelled",
        },
        context,
      });
      await releasePurchaseLimitClaimsForOrder(deps.db, order);

      return { orderId: params.orderId, version: result.version };
    },
    cancelSale: async (params, context) => {
      const order = await getSale(deps.db, params.orderId, params.sellerAccountId);
      if (!order) {
        throw new OrderingDomainError("Sale not found.");
      }
      if (!isCancelableOrderStatus(order.status)) {
        throw new OrderingDomainError("Only pending sales can be cancelled.");
      }

      const result = await commandHandler({
        streamId: `ordering.order-${params.orderId}`,
        command: {
          type: "CancelOrder",
          cancelledAt: new Date().toISOString(),
          reason: "seller-cancelled",
        },
        context,
      });
      await releasePurchaseLimitClaimsForOrder(deps.db, order);

      return { orderId: params.orderId, version: result.version };
    },
    recordPaymentDeadlineStarted: async (params) => {
      if (params.orderIds.length === 0) {
        return 0;
      }
      const startedOrders = await deps.db.query<{
        order_id: string;
        pending_payment_at: string;
      }>(
        `SELECT order_id, pending_payment_at::text AS pending_payment_at
         FROM ordering_order_pages
         WHERE order_id = ANY($1)
           AND pending_payment_at IS NOT NULL`,
        [params.orderIds],
      );
      let recorded = 0;

      for (const order of startedOrders.rows) {
        const deadline = resolveOrderPaymentDeadline(
          order.pending_payment_at,
          params.paymentMethodCategory,
          paymentDeadlinePolicy,
        );
        await deps.db.query(
          `INSERT INTO ordering_payment_deadline_inputs (
             order_id,
             payment_id,
             payment_method_category,
             payment_deadline_at,
             payment_deadline_policy,
             terminal_failure_at,
             failure_code,
             updated_at
           ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6)
           ON CONFLICT (order_id) DO UPDATE
           SET payment_id = EXCLUDED.payment_id,
               payment_method_category = EXCLUDED.payment_method_category,
               payment_deadline_at = EXCLUDED.payment_deadline_at,
               payment_deadline_policy = EXCLUDED.payment_deadline_policy,
               terminal_failure_at = NULL,
               failure_code = NULL,
               updated_at = EXCLUDED.updated_at`,
          [
            order.order_id,
            params.paymentId,
            params.paymentMethodCategory ?? null,
            deadline.paymentDeadlineAt,
            deadline.paymentDeadlinePolicy,
            params.paymentStartedAt,
          ],
        );
        recorded += 1;
      }

      return recorded;
    },
    recordTerminalPaymentFailureDeadline: async (params) => {
      if (params.orderIds.length === 0) {
        return 0;
      }
      const deadline = resolveTerminalPaymentFailureDeadline(params.failedAt, paymentDeadlinePolicy);
      const result = await deps.db.query(
        `INSERT INTO ordering_payment_deadline_inputs (
           order_id,
           payment_id,
           payment_method_category,
           payment_deadline_at,
           payment_deadline_policy,
           terminal_failure_at,
           failure_code,
           updated_at
         )
         SELECT
           order_id,
           $2,
           NULL,
           $3,
           $4,
           $5,
           $6,
           $5
         FROM unnest($1::text[]) AS order_id
         ON CONFLICT (order_id) DO UPDATE
         SET payment_id = EXCLUDED.payment_id,
             payment_deadline_at = EXCLUDED.payment_deadline_at,
             payment_deadline_policy = EXCLUDED.payment_deadline_policy,
             terminal_failure_at = EXCLUDED.terminal_failure_at,
             failure_code = EXCLUDED.failure_code,
             updated_at = EXCLUDED.updated_at`,
        [
          params.orderIds,
          params.paymentId,
          deadline.paymentDeadlineAt,
          deadline.paymentDeadlinePolicy,
          params.failedAt,
          params.failureCode ?? null,
        ],
      );

      return result.rowCount ?? params.orderIds.length;
    },
    sweepBreachedPaymentDeadlines: async (params, context) => {
      const now = normalizeSweepNow(params?.now);
      const candidates = await listPendingPaymentOrdersPastDeadline(deps.db, { now, limit: params?.limit });
      let cancelled = 0;
      let progressed = 0;
      let failed = 0;

      for (const candidate of candidates) {
        try {
          const result = await commandHandler({
            streamId: `ordering.order-${candidate.order_id}`,
            command: {
              type: "CancelOrder",
              cancelledAt: now,
              reason: "payment-deadline",
            },
            context,
          });
          if (result.storedEvents.length > 0) {
            cancelled += 1;
            const order = await getOrderPurchaseLimitReleaseInput(deps.db, candidate.order_id);
            if (order) {
              await releasePurchaseLimitClaimsForOrder(deps.db, order);
            }
          } else {
            progressed += 1;
          }
        } catch (error) {
          if (isPaymentDeadlineRaceProgression(error)) {
            progressed += 1;
            continue;
          }
          failed += 1;
        }
      }

      return { checked: candidates.length, cancelled, progressed, failed };
    },
    listPurchases: (params) => listPurchases(deps.db, params),
    getPurchase: (orderId, buyerAccountId) => getPurchase(deps.db, orderId, buyerAccountId),
    getPurchaseListSummary: (buyerAccountId) => getPurchaseListSummary(deps.db, buyerAccountId),
    listSales: (params) => listSales(deps.db, params),
    getSale: (orderId, sellerAccountId) => getSale(deps.db, orderId, sellerAccountId),
    getSaleListSummary: (sellerAccountId) => getSaleListSummary(deps.db, sellerAccountId),
    getOrderReviewOpportunity: (orderId, authorAccountId) =>
      getOrderingOrderReviewOpportunity(deps.db, { orderId, authorAccountId }),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "ordering-order-projection",
        handlers: buildOrderingOrderProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: "ordering-order-review-opportunity-projection",
        handlers: buildOrderingReputationProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: ORDERING_TRANSACTIONAL_EMAIL_PROJECTION,
        handlers: buildOrderingTransactionalEmailProjectionHandlers(
          notificationOutbox,
          ORDERING_TRANSACTIONAL_EMAIL_PROJECTION,
        ),
      }),
    ],
  };
}

function isCancelableOrderStatus(status: OrderStatus | string) {
  return status === "pending-payment" || status === "pending-reservation";
}
