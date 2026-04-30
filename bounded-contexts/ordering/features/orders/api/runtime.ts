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
import type { AccountId, OrderId } from "@chase-sets/primitives/typed-ids";
import {
  OrderingDomainError,
  buildDemandSignature,
  moneyToNumber,
  normalizeMoneyAmount,
  numberToMoneyAmount,
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
import type { CommercialTermsResolver } from "../../../api";
import {
  decideOrderingOrder,
  evolveOrderingOrder,
  initialOrderingOrderState,
  type OrderingOrderCommand,
  type OrderingOrderEvent,
  type OrderingOrderState,
} from "../domain/domain";

type OrderRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  commercialTermsResolver: CommercialTermsResolver;
  shippingQuotePolicy: ShippingQuotePolicy;
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
}>;

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
  sourceType: OrderSourceType;
  sourceReferenceId: string | null;
  shippingOption: ShippingOption;
  itemSubtotalAmount: string;
  shippingBaseAmount: string;
  shippingDiscountAmount: string;
  shippingChargeAmount: string;
  totalAmount: string;
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
      lines: readonly CheckoutOrderLineSnapshot[];
      orderIdsOverride?: readonly OrderId[];
    }>,
    context: EventStoreContext,
  ) => Promise<{ orderIds: readonly OrderId[] }>;
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
      quantityRequested: number;
      orderIdsOverride?: readonly OrderId[];
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

function quotePlan(
  demandPlans: readonly DemandPlan[],
  shippingOption: ShippingOption,
  shippingQuotePolicy: ShippingQuotePolicy,
  priceOverrideAmount?: string,
  sourceType: OrderSourceType = "cart-checkout",
  sourceReferenceId: string | null = null,
): CheckoutPlan {
  const groupedBySeller = new Map<
    string,
    {
      lines: Array<SellerOrderDraft["lines"][number]>;
      reservations: Array<SellerOrderDraft["reservations"][number]>;
      subtotal: number;
      listingIds: Set<string>;
      quantity: number;
    }
  >();

  for (const demandPlan of demandPlans) {
    for (const allocation of demandPlan.allocations) {
      const sellerDraft =
        groupedBySeller.get(allocation.candidate.sellerAccountId) ??
        {
          lines: [],
          reservations: [],
          subtotal: 0,
          listingIds: new Set<string>(),
          quantity: 0,
        };
      const unitPriceAmount = priceOverrideAmount ?? allocation.candidate.priceAmount;
      const lineTotalAmount = numberToMoneyAmount(
        moneyToNumber(unitPriceAmount) * allocation.quantity,
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
      });
      sellerDraft.reservations.push({
        reservationRequestId: createId("rsv"),
        inventoryItemId: allocation.candidate.inventoryItemId,
        quantity: allocation.quantity,
      });
      sellerDraft.subtotal += moneyToNumber(lineTotalAmount);
      sellerDraft.listingIds.add(allocation.candidate.listingId);
      sellerDraft.quantity += allocation.quantity;
      groupedBySeller.set(allocation.candidate.sellerAccountId, sellerDraft);
    }
  }

  const orderDrafts: SellerOrderDraft[] = [];
  let totalAmount = 0;
  let itemSubtotalAmount = 0;

  for (const [sellerAccountId, draft] of groupedBySeller.entries()) {
    const quote = shippingQuotePolicy.quote({
      sellerAccountId,
      shippingOption,
      itemSubtotalAmount: numberToMoneyAmount(draft.subtotal),
      quantity: draft.quantity,
      listingCount: draft.listingIds.size,
    });
    const orderTotal = draft.subtotal + moneyToNumber(quote.chargeAmount);
    totalAmount += orderTotal;
    itemSubtotalAmount += draft.subtotal;

    orderDrafts.push({
      sellerAccountId,
      sourceType,
      sourceReferenceId,
      shippingOption,
      itemSubtotalAmount: numberToMoneyAmount(draft.subtotal),
      shippingBaseAmount: quote.baseAmount,
      shippingDiscountAmount: quote.discountAmount,
      shippingChargeAmount: quote.chargeAmount,
      totalAmount: numberToMoneyAmount(orderTotal),
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

function chooseBestPlan(
  demandOptions: readonly DemandPlan[][],
  shippingOption: ShippingOption,
  shippingQuotePolicy: ShippingQuotePolicy,
  priceOverrideAmount?: string,
  sourceType: OrderSourceType = "cart-checkout",
  sourceReferenceId: string | null = null,
) {
  let bestPlan: CheckoutPlan | null = null;
  const search = (index: number, chosen: DemandPlan[]) => {
    if (index >= demandOptions.length) {
      const plan = quotePlan(
        chosen,
        shippingOption,
        shippingQuotePolicy,
        priceOverrideAmount,
        sourceType,
        sourceReferenceId,
      );
      if (
        !bestPlan ||
        plan.totalAmount < bestPlan.totalAmount ||
        (plan.totalAmount === bestPlan.totalAmount &&
          plan.itemSubtotalAmount < bestPlan.itemSubtotalAmount) ||
        (plan.totalAmount === bestPlan.totalAmount &&
          plan.itemSubtotalAmount === bestPlan.itemSubtotalAmount &&
          plan.orderCount < bestPlan.orderCount)
      ) {
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

export function createOrderingOrderRuntime(
  deps: OrderRuntimeDeps,
): OrderingOrderServices {
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
      const commercialTerms = await deps.commercialTermsResolver.resolveOrderTerms({
        accountId: draft.sellerAccountId,
        amount: draft.itemSubtotalAmount,
      });
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
          shippingChargeAmount: draft.shippingChargeAmount,
          totalAmount: draft.totalAmount,
          commercialTermsSnapshot: {
            marketplaceFeeAmount: commercialTerms.marketplaceFeeAmount,
            paymentFeeAmount: commercialTerms.paymentFeeAmount,
            sellerNetAmount: commercialTerms.sellerNetAmount,
            termsScheduleId: commercialTerms.scheduleId,
            termsAgreementId: commercialTerms.agreementId,
            termsResolvedAt: commercialTerms.resolvedAt,
          },
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
      quantityRequested: number;
      orderIdsOverride?: readonly OrderId[];
    }>,
    context: EventStoreContext,
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
    const plan = chooseBestPlan(
      demandOptions,
      "standard",
      deps.shippingQuotePolicy,
      normalizeMoneyAmount(params.priceAmount, { fieldName: "Accepted offer price" }),
      "offer-acceptance",
      params.offerId,
    );
    const orderIds = await createOrdersFromPlan(
      params.buyerAccountId,
      plan,
      context,
      params.orderIdsOverride,
    );
    return { orderIds };
  };

  return {
    commandHandler,
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

      if (params.sourceType === "buy-now") {
        const line = params.lines[0]!;
        if (!line.listingId) {
          throw new OrderingDomainError("Buy now checkout must reference a listing.");
        }

        const candidate = await getOrderingSupplyCandidateByListingId(
          deps.db,
          line.listingId,
        );
        if (!candidate) {
          throw new OrderingDomainError("Listing is not available for buy now.");
        }
        if (candidate.productId !== line.productId.trim()) {
          throw new OrderingDomainError(
            "Buy now listing does not match the selected product.",
          );
        }
        assertSupplyAvailable(
          [candidate],
          line.quantity,
          `Not enough active supply is available for ${candidate.itemTitle}.`,
        );

        const demand: MarketplaceDemand & Readonly<{ quantity: number }> = {
          catalogItemId: candidate.catalogItemId,
          productId: candidate.productId,
          itemTitle: candidate.itemTitle,
          itemSubtitle: candidate.itemSubtitle,
          selectedOptions: candidate.selectedOptions,
          productSummary: candidate.productSummary,
          quantity: line.quantity,
        };
        const plan = quotePlan(
          [
            {
              demand,
              allocations: [{ candidate, quantity: line.quantity }],
            },
          ],
          params.shippingOption,
          deps.shippingQuotePolicy,
          undefined,
          "buy-now",
          params.checkoutSessionId,
        );
        const orderIds = await createOrdersFromPlan(
          params.buyerAccountId,
          plan,
          context,
          params.orderIdsOverride,
        );

        return { orderIds };
      }

      const demandGroups = groupDemands(params.lines);
      const demandOptions = await buildDemandOptions(deps.db, demandGroups);
      const plan = chooseBestPlan(
        demandOptions,
        params.shippingOption,
        deps.shippingQuotePolicy,
        undefined,
        "cart-checkout",
        params.checkoutSessionId,
      );
      const orderIds = await createOrdersFromPlan(
        params.buyerAccountId,
        plan,
        context,
        params.orderIdsOverride,
      );

      return { orderIds };
    },
    createOrdersFromAcceptedOffer,
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
