import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  normalizeAddressSnapshot,
  type AddressSnapshot,
} from "@chase-sets/primitives/address-snapshot";
import type { AccountId, OrderId } from "@chase-sets/primitives/typed-ids";
import {
  OrderingDomainError,
  buildDemandSignature,
  moneyToNumber,
  normalizeMoneyAmount,
  numberToMoneyAmount,
  numberToMoneyAmountRoundDown,
  type OrderLineId,
  type OrderSourceType,
  type OrderStatus,
  type ShippingOption,
} from "../domain/common";
import {
  assertSupplyAvailable,
  type MarketplaceDemand,
  type MarketplaceSupplyCandidate,
  type ShippingQuotePolicy,
} from "../domain/policies";
import {
  getPurchase,
  getSale,
  listOrderIdsForSource,
  listPurchases,
  listSales,
} from "../read-model/queries";
import { buildOrderingOrderProjectionHandlers } from "../read-model/projection";
import { listOrderingSupplyCandidates } from "../integrations/supply/supply-queries";
import { getOrderingSupplyCandidateByListingId } from "../integrations/supply/supply-queries";
import {
  decideOrderingOrder,
  evolveOrderingOrder,
  initialOrderingOrderState,
  type OrderingOrderCommand,
  type OrderingOrderEvent,
  type OrderingOrderState,
} from "../domain/domain";

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
  quoteTax(input: Readonly<{
    buyerAccountId: string;
    sellerAccountId: string;
    currencyCode: "usd";
    destinationAddress: TaxDestinationAddress;
    itemSubtotalAmount: string;
    shippingAmount: string;
    marketplaceCheckoutFeeAmount?: string | null;
  }>): Promise<TaxQuote>;
}>;

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

type OrderRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  shippingQuotePolicy: ShippingQuotePolicy;
  taxQuoteResolver?: TaxQuoteResolver;
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
  salesTaxAmount: string;
  totalAmount: string;
  taxQuote: TaxQuote;
  shippingOriginSnapshot: AddressSnapshot;
  lines: ReadonlyArray<{
    lineId: OrderLineId;
    listingId: string;
    inventoryItemId: string;
    catalogItemId: string;
    productId: string;
    itemTitle: string;
    itemSubtitle: string | null;
    selectedOptions: { dimensionId: string; optionId: string }[];
    productSummary: string | null;
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
  }>;
}>;

type CheckoutPlan = Readonly<{
  orderDrafts: readonly SellerOrderDraft[];
  totalAmount: number;
  itemSubtotalAmount: number;
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
    lines: readonly Readonly<{
      lineKey: string;
      listingId: string;
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
}>;

export type OrderingOrderServices = Readonly<{
  commandHandler: CommandHandler<
    OrderingOrderCommand,
    OrderingOrderState,
    OrderingOrderEvent
  >;
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
      orderIdsOverride?: readonly OrderId[];
    }>,
    context: EventStoreContext,
  ) => Promise<{ orderIds: readonly OrderId[] }>;
  previewCheckoutFulfillment: (
    params: Readonly<{
      buyerAccountId: AccountId;
      checkoutSessionId: string;
      sourceType: "cart-checkout" | "buy-now";
      shippingOption: ShippingOption;
      shippingAddress?: CheckoutShippingAddressSnapshot | null;
      lines: readonly CheckoutOrderLineSnapshot[];
      optimizationGoal?: "lowest-total" | "fewest-shipments";
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
  ) => Promise<{ orderIds: readonly OrderId[] }>;
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
  listPurchases: (
    params: Parameters<typeof listPurchases>[1],
  ) => ReturnType<typeof listPurchases>;
  getPurchase: (
    orderId: string,
    buyerAccountId: string,
  ) => ReturnType<typeof getPurchase>;
  listSales: (
    params: Parameters<typeof listSales>[1],
  ) => ReturnType<typeof listSales>;
  getSale: (
    orderId: string,
    sellerAccountId: string,
  ) => ReturnType<typeof getSale>;
  projectors: readonly Projector[];
}>;

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
      catalogItemId: line.catalogItemId,
      productId: line.productId,
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
  return (
    line.fulfillmentMode === "locked-listing" ||
    Boolean((line.lockedListingId ?? line.listingId)?.trim())
  );
}

function enumerateDemandAllocations(
  demand: MarketplaceDemand,
  candidates: readonly MarketplaceSupplyCandidate[],
) {
  assertSupplyAvailable(
    candidates,
    demand.quantity,
    `Not enough active supply is available for ${demand.itemTitle}.`,
  );

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
    throw new OrderingDomainError(
      `Not enough active supply is available for ${demand.itemTitle}.`,
    );
  }

  return results;
}

function planShippingAllowanceBps(lines: SellerOrderDraft["lines"]) {
  const values = lines.map((line) => line.shippingAllowancePercentageBps);
  const unique = [...new Set(values)];
  if (values.length === 0) {
    return 500;
  }
  return unique.length === 1 ? unique[0] ?? 500 : Math.min(...values);
}

function calculateShippingIncentive(params: Readonly<{
  sourceType: OrderSourceType;
  itemSubtotalAmount: string;
  shippingBaseAmount: string;
  shippingAllowancePercentageBps: number;
}>) {
  const shippingBaseAmount = normalizeMoneyAmount(params.shippingBaseAmount, {
    fieldName: "Shipping base amount",
    allowZero: true,
  });
  const earnedAmount = numberToMoneyAmount(
    Math.min(
      moneyToNumber(shippingBaseAmount),
      moneyToNumber(
        numberToMoneyAmountRoundDown(
          moneyToNumber(params.itemSubtotalAmount) *
            (params.shippingAllowancePercentageBps / 10_000),
        ),
      ),
    ),
  );

  if (params.sourceType === "offer-acceptance") {
    return {
      shippingBaseAmount,
      shippingDiscountAmount: "0.00",
      shippingAllowanceAmount: earnedAmount,
      shippingOverageAmount: numberToMoneyAmount(
        Math.max(0, moneyToNumber(shippingBaseAmount) - moneyToNumber(earnedAmount)),
      ),
      sellerShippingPayoutAmount: earnedAmount,
      shippingChargeAmount: earnedAmount,
    };
  }

  const shippingChargeAmount = numberToMoneyAmount(
    Math.max(0, moneyToNumber(shippingBaseAmount) - moneyToNumber(earnedAmount)),
  );
  return {
    shippingBaseAmount,
    shippingDiscountAmount: earnedAmount,
    shippingAllowanceAmount: earnedAmount,
    shippingOverageAmount: "0.00",
    sellerShippingPayoutAmount: shippingChargeAmount,
    shippingChargeAmount,
  };
}

function quotePlan(
  demandPlans: readonly DemandPlan[],
  shippingOption: ShippingOption,
  shippingQuotePolicy: ShippingQuotePolicy,
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
): CheckoutPlan {
  const groupedBySellerAndOrigin = new Map<
    string,
    {
      sellerAccountId: string;
      lines: Array<SellerOrderDraft["lines"][number]>;
      reservations: Array<SellerOrderDraft["reservations"][number]>;
      sellerDisplayName: string | null;
      shippingOriginSnapshot: AddressSnapshot;
      subtotal: number;
      listingIds: Set<string>;
      quantity: number;
    }
  >();

  for (const demandPlan of demandPlans) {
    for (const allocation of demandPlan.allocations) {
      const shippingOriginSnapshot = normalizeAddressSnapshot(
        allocation.candidate.shipFromAddress,
        "Shipping origin",
      );
      const sellerGroupKey = [
        allocation.candidate.sellerAccountId,
        JSON.stringify(shippingOriginSnapshot),
      ].join("|");
      const sellerDraft =
        groupedBySellerAndOrigin.get(sellerGroupKey) ??
        {
          sellerAccountId: allocation.candidate.sellerAccountId,
          lines: [],
          reservations: [],
          sellerDisplayName: allocation.candidate.sellerDisplayName,
          shippingOriginSnapshot,
          subtotal: 0,
          listingIds: new Set<string>(),
          quantity: 0,
        };
      const unitPriceAmount = priceOverrideAmount ?? allocation.candidate.priceAmount;
      const lineTotalAmount = numberToMoneyAmount(
        moneyToNumber(unitPriceAmount) * allocation.quantity,
      );
      const marketplaceSalesFeeUnitAmount =
        feeOverride?.marketplaceSalesFeeUnitAmount ?? allocation.candidate.marketplaceSalesFeeUnitAmount;
      const sellerNetUnitAmount =
        feeOverride?.sellerNetUnitAmount ?? allocation.candidate.sellerNetUnitAmount;
      const shippingAllowancePercentageBps =
        feeOverride?.shippingAllowancePercentageBps ??
        allocation.candidate.shippingAllowancePercentageBps;
      const marketplaceSalesFeeTotalAmount = numberToMoneyAmount(
        moneyToNumber(marketplaceSalesFeeUnitAmount) * allocation.quantity,
      );
      const sellerNetTotalAmount = numberToMoneyAmount(
        moneyToNumber(sellerNetUnitAmount) * allocation.quantity,
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
        unitPriceAmount,
        quantity: allocation.quantity,
        lineTotalAmount,
        marketplaceSalesFeeUnitAmount,
        marketplaceSalesFeeTotalAmount,
        sellerNetUnitAmount,
        sellerNetTotalAmount,
        termsScheduleId: feeOverride?.termsScheduleId ?? allocation.candidate.termsScheduleId,
        termsAgreementId: feeOverride?.termsAgreementId ?? allocation.candidate.termsAgreementId,
        termsResolvedAt: feeOverride?.termsResolvedAt ?? allocation.candidate.termsResolvedAt,
        shippingAllowancePercentageBps,
      });
      sellerDraft.reservations.push({
        reservationRequestId: createId("rsv"),
        inventoryItemId: allocation.candidate.inventoryItemId,
        quantity: allocation.quantity,
      });
      sellerDraft.sellerDisplayName =
        sellerDraft.sellerDisplayName ?? allocation.candidate.sellerDisplayName;
      sellerDraft.subtotal += moneyToNumber(lineTotalAmount);
      sellerDraft.listingIds.add(allocation.candidate.listingId);
      sellerDraft.quantity += allocation.quantity;
      groupedBySellerAndOrigin.set(sellerGroupKey, sellerDraft);
    }
  }

  const orderDrafts: SellerOrderDraft[] = [];
  let totalAmount = 0;
  let itemSubtotalAmount = 0;

  for (const draft of groupedBySellerAndOrigin.values()) {
    const shippingAllowancePercentageBps = planShippingAllowanceBps(draft.lines);
    const quote = shippingQuotePolicy.quote({
      sellerAccountId: draft.sellerAccountId,
      shippingOption,
      itemSubtotalAmount: numberToMoneyAmount(draft.subtotal),
      quantity: draft.quantity,
      listingCount: draft.listingIds.size,
    });
    const shippingEconomics = calculateShippingIncentive({
      sourceType,
      itemSubtotalAmount: numberToMoneyAmount(draft.subtotal),
      shippingBaseAmount: quote.baseAmount,
      shippingAllowancePercentageBps,
    });
    const orderTotal = draft.subtotal + moneyToNumber(shippingEconomics.shippingChargeAmount);
    totalAmount += orderTotal;
    itemSubtotalAmount += draft.subtotal;

    orderDrafts.push({
      sellerAccountId: draft.sellerAccountId,
      sellerDisplayName: draft.sellerDisplayName,
      sourceType,
      sourceReferenceId,
      shippingOption,
      itemSubtotalAmount: numberToMoneyAmount(draft.subtotal),
      shippingBaseAmount: shippingEconomics.shippingBaseAmount,
      shippingDiscountAmount: shippingEconomics.shippingDiscountAmount,
      shippingAllowanceAmount: shippingEconomics.shippingAllowanceAmount,
      shippingOverageAmount: shippingEconomics.shippingOverageAmount,
      sellerShippingPayoutAmount: shippingEconomics.sellerShippingPayoutAmount,
      shippingChargeAmount: shippingEconomics.shippingChargeAmount,
      salesTaxAmount: "0.00",
      totalAmount: numberToMoneyAmount(orderTotal),
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
    orderDrafts: orderDrafts.sort((left, right) =>
      left.sellerAccountId.localeCompare(right.sellerAccountId),
    ),
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
  let totalAmount = 0;

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
    const orderTotal = numberToMoneyAmount(
      moneyToNumber(draft.itemSubtotalAmount) +
        moneyToNumber(draft.shippingChargeAmount) +
        moneyToNumber(salesTaxAmount),
    );
    totalAmount += moneyToNumber(orderTotal);
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
) {
  let bestPlan: CheckoutPlan | null = null;
  const search = (index: number, chosen: DemandPlan[]) => {
    if (index >= demandOptions.length) {
      const plan = quotePlan(
        chosen,
        shippingOption,
        shippingQuotePolicy,
        priceOverrideAmount,
        feeOverride,
        sourceType,
        sourceReferenceId,
      );
      const isBetter =
        optimizationGoal === "fewest-shipments"
          ? !bestPlan ||
            plan.orderCount < bestPlan.orderCount ||
            (plan.orderCount === bestPlan.orderCount &&
              plan.totalAmount < bestPlan.totalAmount)
          : !bestPlan ||
            plan.totalAmount < bestPlan.totalAmount ||
            (plan.totalAmount === bestPlan.totalAmount &&
              plan.itemSubtotalAmount < bestPlan.itemSubtotalAmount) ||
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
  demandGroups: readonly MarketplaceDemand[],
  sellerAccountId?: string,
) {
  const options: DemandPlan[][] = [];

  for (const demand of demandGroups) {
    const candidates = await listOrderingSupplyCandidates(db, {
      ...demand,
      sellerAccountId,
    });
    options.push(enumerateDemandAllocations(demand, candidates));
  }

  return options;
}

async function buildCheckoutDemandOptions(
  db: PgQueryable,
  lines: readonly CheckoutOrderLineSnapshot[],
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
    assertSupplyAvailable(
      [candidate],
      line.quantity,
      `Not enough active supply is available for ${candidate.itemTitle}.`,
    );
    options.push([
      {
        demand: {
          catalogItemId: candidate.catalogItemId,
          productId: candidate.productId,
          itemTitle: candidate.itemTitle,
          itemSubtitle: candidate.itemSubtitle,
          selectedOptions: candidate.selectedOptions,
          productSummary: candidate.productSummary,
          quantity: line.quantity,
        },
        allocations: [{ candidate, quantity: line.quantity }],
      },
    ]);
  }

  if (optimizedLines.length > 0) {
    options.push(...await buildDemandOptions(db, groupDemands(optimizedLines)));
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
  ].join("#");
}

function planToPreview(params: Readonly<{
  plan: CheckoutPlan;
  sourceLines: readonly CheckoutOrderLineSnapshot[];
  optimizationGoal: "lowest-total" | "fewest-shipments";
  unavailableLines: CheckoutFulfillmentPreview["unavailableLines"];
}>): CheckoutFulfillmentPreview {
  const lineKeysByDemand = new Map<string, string[]>();
  params.sourceLines.forEach((line, index) => {
    const key = buildDemandSignature(line.productId);
    lineKeysByDemand.set(key, [
      ...(lineKeysByDemand.get(key) ?? []),
      checkoutLineKey(line, index),
    ]);
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
    lines: draft.lines.map((line) => {
      const demandKey = buildDemandSignature(line.productId);
      const lineKey = lineKeysByDemand.get(demandKey)?.shift() ?? line.listingId;
      const sourceLine = params.sourceLines.find((source, index) =>
        checkoutLineKey(source, index) === lineKey,
      );
      const locked = sourceLine ? isLockedCheckoutLine(sourceLine) : false;
      return {
        lineKey,
        listingId: line.listingId,
        catalogItemId: line.catalogItemId,
        productId: line.productId,
        itemTitle: line.itemTitle,
        productSummary: line.productSummary,
        quantity: line.quantity,
        estimatedUnitPriceAmount: line.unitPriceAmount,
        estimatedLineTotalAmount: line.lineTotalAmount,
        priceState: locked ? "locked" as const : "available" as const,
        materialChangeReasons: [] as string[],
      };
    }),
  }));
  const shippingAmount = params.plan.orderDrafts.reduce(
    (sum, draft) => sum + moneyToNumber(draft.shippingChargeAmount),
    0,
  );
  const salesTaxAmount = params.plan.orderDrafts.reduce(
    (sum, draft) => sum + moneyToNumber(draft.salesTaxAmount),
    0,
  );
  const materialChangeReasons = sellerGroups.flatMap((group) =>
    group.lines.flatMap((line) => line.materialChangeReasons),
  );
  const withoutRevision = {
    optimizationGoal: params.optimizationGoal,
    readyLineKeys,
    unavailableLineKeys: params.unavailableLines.map((line) => line.lineKey),
    sellerGroups,
    totals: {
      itemSubtotalAmount: numberToMoneyAmount(params.plan.itemSubtotalAmount),
      shippingAmount: numberToMoneyAmount(shippingAmount),
      salesTaxAmount: numberToMoneyAmount(salesTaxAmount),
      totalAmount: numberToMoneyAmount(params.plan.totalAmount),
      packageCount: params.plan.orderCount,
    },
    unavailableLines: params.unavailableLines,
    materialChangeReasons,
  };

  return {
    ...withoutRevision,
    revision: previewRevision(withoutRevision),
  };
}

export function createOrderingOrderRuntime(
  deps: OrderRuntimeDeps,
): OrderingOrderServices {
  const taxQuoteResolver = deps.taxQuoteResolver ?? zeroTaxQuoteResolver;
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<OrderingOrderEvent>(),
      initialState: () => initialOrderingOrderState,
      evolve: evolveOrderingOrder,
    }),
    evolve: evolveOrderingOrder,
    decide: decideOrderingOrder,
  });

  const createOrdersFromPlan = async (
    buyerAccountId: AccountId,
    plan: CheckoutPlan,
    shippingDestinationSnapshot: AddressSnapshot,
    context: EventStoreContext,
    orderIdsOverride?: readonly OrderId[],
  ) => {
    if (
      orderIdsOverride &&
      orderIdsOverride.length !== plan.orderDrafts.length
    ) {
      throw new OrderingDomainError(
        "Order seed overrides must match the number of generated seller orders.",
      );
    }

    const orderIds: OrderId[] = [];

    for (const [draftIndex, draft] of plan.orderDrafts.entries()) {
      const marketplaceSalesFeeAmount = numberToMoneyAmount(
        draft.lines.reduce((sum, line) => sum + moneyToNumber(line.marketplaceSalesFeeTotalAmount), 0),
      );
      const sellerNetAmount = numberToMoneyAmount(
        draft.lines.reduce((sum, line) => sum + moneyToNumber(line.sellerNetTotalAmount), 0),
      );
      const sellerPayoutAmount = numberToMoneyAmount(
        moneyToNumber(sellerNetAmount) + moneyToNumber(draft.sellerShippingPayoutAmount),
      );
      const shippingAllowancePercentageBps = planShippingAllowanceBps(draft.lines);
      const firstLine = draft.lines[0];
      const termsScheduleId = firstLine
        ? planTermsForLines(draft.lines, "termsScheduleId")
        : null;
      const termsAgreementId = firstLine
        ? planTermsForLines(draft.lines, "termsAgreementId")
        : null;
      const termsResolvedAt = firstLine
        ? planTermsForLines(draft.lines, "termsResolvedAt") ?? new Date().toISOString()
        : new Date().toISOString();
      const orderId =
        orderIdsOverride?.[draftIndex] ?? (createId("ord") as OrderId);
      await commandHandler({
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
          salesTaxAmount: draft.salesTaxAmount,
          totalAmount: draft.totalAmount,
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
          })),
        },
        context,
      });

      orderIds.push(orderId);
    }

    return orderIds;
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
        catalogItemId: params.catalogItemId,
        productId: params.productId,
        itemTitle: params.itemTitle,
        itemSubtitle: params.itemSubtitle,
        selectedOptions: params.selectedOptions,
        productSummary: params.productSummary,
        quantity: params.quantityRequested,
      },
    ];
    const demandOptions = await buildDemandOptions(
      deps.db,
      demandGroups,
      params.sellerAccountId,
    );
    const acceptedOfferPriceAmount = normalizeMoneyAmount(params.priceAmount, {
      fieldName: "Accepted offer price",
    });
    const plan = chooseBestPlan(
      demandOptions,
      "standard",
      deps.shippingQuotePolicy,
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
      normalizeAddressSnapshot(
        params.shippingDestinationSnapshot,
        "Shipping destination",
      ),
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
    const orderIds = await createOrdersFromPlan(
      params.buyerAccountId,
      taxAdjustedPlan,
      normalizeAddressSnapshot(
        params.shippingDestinationSnapshot,
        "Shipping destination",
      ),
      context,
      params.orderIdsOverride,
    );
    return { orderIds };
  };

  const createOrdersFromAcceptedOfferBatch: OrderingOrderServices["createOrdersFromAcceptedOfferBatch"] =
    async (params, context) => {
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
          const groupKey = [
            offer.buyerAccountId,
            JSON.stringify(shippingDestinationSnapshot),
          ].join("|");
          const group =
            groupedByBuyerAndDestination.get(groupKey) ?? {
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
          const sellerOriginKey = [
            draft.sellerAccountId,
            JSON.stringify(draft.shippingOriginSnapshot),
          ].join("|");
          const existing = mergedBySeller.get(sellerOriginKey);
          if (!existing) {
            mergedBySeller.set(sellerOriginKey, draft);
            continue;
          }

          const lines = [...existing.lines, ...draft.lines];
          const reservations = [...existing.reservations, ...draft.reservations];
          const itemSubtotalAmount = numberToMoneyAmount(
            moneyToNumber(existing.itemSubtotalAmount) + moneyToNumber(draft.itemSubtotalAmount),
          );
          const listingIds = new Set(lines.map((line) => line.listingId));
          const quantity = lines.reduce((sum, line) => sum + line.quantity, 0);
          const quote = deps.shippingQuotePolicy.quote({
            sellerAccountId: draft.sellerAccountId,
            shippingOption: draft.shippingOption,
            itemSubtotalAmount,
            quantity,
            listingCount: listingIds.size,
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
            salesTaxAmount: "0.00",
            totalAmount: numberToMoneyAmount(
              moneyToNumber(itemSubtotalAmount) +
                moneyToNumber(shippingEconomics.shippingChargeAmount),
            ),
            lines,
            reservations,
          });
        }

        const taxAdjustedPlan = await applyTaxToPlan(
          {
            orderDrafts: [...mergedBySeller.values()],
            totalAmount: 0,
            itemSubtotalAmount: 0,
            orderCount: mergedBySeller.size,
          },
          group.buyerAccountId,
          group.shippingDestinationSnapshot,
          taxQuoteResolver,
        );
        const buyerOrderIds = await createOrdersFromPlan(
          group.buyerAccountId,
          taxAdjustedPlan,
          group.shippingDestinationSnapshot,
          context,
        );
        orderIds.push(...buyerOrderIds);
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
                catalogItemId: line.catalogItemId,
                productId: line.productId,
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
          } else {
            const candidates = await listOrderingSupplyCandidates(deps.db, {
              catalogItemId: line.catalogItemId,
              productId: line.productId,
              itemTitle: line.itemTitle,
              itemSubtitle: line.itemSubtitle,
              selectedOptions: line.selectedOptions,
              productSummary: line.productSummary,
              quantity: line.quantity,
            });
            const availableQuantity = candidates.reduce(
              (sum, candidate) => sum + candidate.availableQuantity,
              0,
            );
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
        };
        return {
          ...withoutRevision,
          revision: previewRevision(withoutRevision),
        };
      }

      const demandOptions = await buildCheckoutDemandOptions(deps.db, readyLines);
      const plan = chooseBestPlan(
        demandOptions,
        params.shippingOption,
        deps.shippingQuotePolicy,
        undefined,
        undefined,
        params.sourceType,
        params.checkoutSessionId,
        optimizationGoal,
      );
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

      return planToPreview({
        plan: taxAdjustedPlan,
        sourceLines: readyLines,
        optimizationGoal,
        unavailableLines,
      });
    },
    createOrdersFromCheckout: async (params, context) => {
      const existingOrderIds = await listOrderIdsForSource(
        deps.db,
        params.sourceType,
        params.checkoutSessionId,
      );
      if (existingOrderIds.length > 0) {
        return { orderIds: existingOrderIds as OrderId[] };
      }

      if (params.lines.length === 0) {
        throw new OrderingDomainError("Checkout must contain at least one line.");
      }

      const preview = await createOrderingOrderRuntime(deps).previewCheckoutFulfillment(params);
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
      const demandOptions = await buildCheckoutDemandOptions(deps.db, readyLines);
      const plan = chooseBestPlan(
        demandOptions,
        params.shippingOption,
        deps.shippingQuotePolicy,
        undefined,
        undefined,
        params.sourceType,
        params.checkoutSessionId,
        params.optimizationGoal ?? "lowest-total",
      );
      const taxAdjustedPlan = await applyTaxToPlan(
        plan,
        params.buyerAccountId,
        normalizeAddressSnapshot(params.shippingAddress, "Shipping destination"),
        taxQuoteResolver,
      );
      const orderIds = await createOrdersFromPlan(
        params.buyerAccountId,
        taxAdjustedPlan,
        normalizeAddressSnapshot(params.shippingAddress, "Shipping destination"),
        context,
        params.orderIdsOverride,
      );

      return { orderIds };
    },
    createOrdersFromAcceptedOffer,
    createOrdersFromAcceptedOfferBatch,
    cancelPurchase: async (params, context) => {
      const order = await getPurchase(deps.db, params.orderId, params.buyerAccountId);
      if (!order) {
        throw new OrderingDomainError("Purchase not found.");
      }
      if (!isCancelableOrderStatus(order.status)) {
        throw new OrderingDomainError("Only pending purchases can be cancelled.");
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

      return { orderId: params.orderId, version: result.version };
    },
    listPurchases: (params) => listPurchases(deps.db, params),
    getPurchase: (orderId, buyerAccountId) =>
      getPurchase(deps.db, orderId, buyerAccountId),
    listSales: (params) => listSales(deps.db, params),
    getSale: (orderId, sellerAccountId) =>
      getSale(deps.db, orderId, sellerAccountId),
    projectors: [
      createProjector({
        projectorName: "ordering-order-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildOrderingOrderProjectionHandlers(deps.db),
      }),
    ],
  };
}

function isCancelableOrderStatus(status: OrderStatus | string) {
  return status === "pending-payment" || status === "pending-reservation";
}
