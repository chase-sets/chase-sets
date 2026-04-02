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
import type { CatalogVersionKey } from "@chase-sets/sellable-units";
import {
  OrderingDomainError,
  buildDemandSignature,
  moneyToNumber,
  normalizeMoneyAmount,
  numberToMoneyAmount,
  type OrderLineId,
  type ShippingOption,
} from "../common";
import type { OrderingCartLineRow } from "../cart/queries";
import type { OrderingCartServices } from "../cart/runtime";
import {
  assertSupplyAvailable,
  type InventoryReservationGateway,
  type MarketplaceDemand,
  type MarketplaceSupplyCandidate,
  type MarketplaceSupplyResolver,
  type ShippingQuotePolicy,
} from "../policies";
import {
  getBuyerOrder,
  getSellerOrder,
  listBuyerOrders,
  listSellerOrders,
} from "./queries";
import { buildOrderingOrderProjectionHandlers } from "./projection";
import {
  decideOrderingOrder,
  evolveOrderingOrder,
  initialOrderingOrderState,
  type OrderingOrderCommand,
  type OrderingOrderEvent,
  type OrderingOrderState,
} from "./domain";

type OrderRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  carts: OrderingCartServices;
  supplyResolver: MarketplaceSupplyResolver;
  shippingQuotePolicy: ShippingQuotePolicy;
  inventoryReservations: InventoryReservationGateway;
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
  sourceType: "cart-checkout" | "offer-acceptance";
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
    inventoryRecordId: string;
    catalogItemId: string;
    catalogVersionKey: CatalogVersionKey;
    itemTitle: string;
    itemSubtitle: string | null;
    versionSelection: { dimensionId: string; choiceId: string }[];
    versionSummary: string | null;
    unitPriceAmount: string;
    quantity: number;
    lineTotalAmount: string;
  }>;
  reservations: ReadonlyArray<{
    inventoryRecordId: string;
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
  checkoutCart: (
    params: Readonly<{
      buyerAccountId: AccountId;
      shippingOption: ShippingOption;
    }>,
    context: EventStoreContext,
  ) => Promise<{ orderIds: readonly OrderId[] }>;
  createOrdersFromAcceptedOffer: (
    params: Readonly<{
      offerId: string;
      buyerAccountId: AccountId;
      sellerAccountId: AccountId;
      catalogItemId: string;
      catalogVersionKey: CatalogVersionKey;
      itemTitle: string;
      itemSubtitle: string | null;
      versionSelection: { dimensionId: string; choiceId: string }[];
      versionSummary: string | null;
      priceAmount: string;
      quantityRequested: number;
    }>,
    context: EventStoreContext,
  ) => Promise<{ orderIds: readonly OrderId[] }>;
  cancelBuyerOrder: (
    params: Readonly<{ orderId: string; buyerAccountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ orderId: string; version: number }>;
  cancelSellerOrder: (
    params: Readonly<{ orderId: string; sellerAccountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ orderId: string; version: number }>;
  listBuyerOrders: (
    params: Parameters<typeof listBuyerOrders>[1],
  ) => ReturnType<typeof listBuyerOrders>;
  getBuyerOrder: (
    orderId: string,
    buyerAccountId: string,
  ) => ReturnType<typeof getBuyerOrder>;
  listSellerOrders: (
    params: Parameters<typeof listSellerOrders>[1],
  ) => ReturnType<typeof listSellerOrders>;
  getSellerOrder: (
    orderId: string,
    sellerAccountId: string,
  ) => ReturnType<typeof getSellerOrder>;
  projectors: readonly Projector[];
}>;

function groupDemands(cartLines: readonly OrderingCartLineRow[]) {
  const grouped = new Map<string, MarketplaceDemand & Readonly<{ quantity: number }>>();

  for (const line of cartLines) {
    const key = buildDemandSignature(line.catalog_version_key);
    const existing = grouped.get(key);

    if (existing) {
      grouped.set(key, { ...existing, quantity: existing.quantity + line.quantity });
      continue;
    }

    grouped.set(key, {
      catalogItemId: line.catalog_item_id,
      catalogVersionKey: line.catalog_version_key as CatalogVersionKey,
      itemTitle: line.item_title,
      itemSubtitle: line.item_subtitle,
      versionSelection: line.version_selection,
      versionSummary: line.version_summary,
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
  sourceType: "cart-checkout" | "offer-acceptance" = "cart-checkout",
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
        inventoryRecordId: allocation.candidate.inventoryRecordId,
        catalogItemId: allocation.candidate.catalogItemId,
        catalogVersionKey: allocation.candidate.catalogVersionKey,
        itemTitle: allocation.candidate.itemTitle,
        itemSubtitle: allocation.candidate.itemSubtitle,
        versionSelection: [...allocation.candidate.versionSelection],
        versionSummary: allocation.candidate.versionSummary,
        unitPriceAmount,
        quantity: allocation.quantity,
        lineTotalAmount,
      });
      sellerDraft.reservations.push({
        inventoryRecordId: allocation.candidate.inventoryRecordId,
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
  sourceType: "cart-checkout" | "offer-acceptance" = "cart-checkout",
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
  demandGroups: readonly MarketplaceDemand[],
  supplyResolver: MarketplaceSupplyResolver,
  sellerAccountId?: string,
) {
  const options: DemandPlan[][] = [];

  for (const demand of demandGroups) {
    const candidates = await supplyResolver.resolveCandidates({
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
  ) => {
    const orderIds: OrderId[] = [];

    for (const draft of plan.orderDrafts) {
      const orderId = createId("ord") as OrderId;
      const reservations = [];

      for (const reservation of draft.reservations) {
        const hold = await deps.inventoryReservations.createReservation({
          sellerAccountId: draft.sellerAccountId as AccountId,
          inventoryRecordId: reservation.inventoryRecordId,
          quantity: reservation.quantity,
          reason: "Ordering commitment",
          notes: `Order ${orderId}`,
          context,
        });
        reservations.push(hold);
      }

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
          lines: [...draft.lines],
          inventoryReservations: reservations.map((reservation) => ({
            holdId: reservation.holdId,
            inventoryRecordId: reservation.inventoryRecordId,
            sellerAccountId: reservation.sellerAccountId,
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
      catalogVersionKey: CatalogVersionKey;
      itemTitle: string;
      itemSubtitle: string | null;
      versionSelection: { dimensionId: string; choiceId: string }[];
      versionSummary: string | null;
      priceAmount: string;
      quantityRequested: number;
    }>,
    context: EventStoreContext,
  ) => {
    const demandGroups: MarketplaceDemand[] = [
      {
        catalogItemId: params.catalogItemId,
        catalogVersionKey: params.catalogVersionKey,
        itemTitle: params.itemTitle,
        itemSubtitle: params.itemSubtitle,
        versionSelection: params.versionSelection,
        versionSummary: params.versionSummary,
        quantity: params.quantityRequested,
      },
    ];
    const demandOptions = await buildDemandOptions(
      demandGroups,
      deps.supplyResolver,
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
    const orderIds = await createOrdersFromPlan(params.buyerAccountId, plan, context);
    return { orderIds };
  };

  return {
    commandHandler,
    checkoutCart: async (params, context) => {
      const cartLines = await deps.carts.listCartLines(params.buyerAccountId);
      if (cartLines.length === 0) {
        throw new OrderingDomainError("Cart must contain at least one line.");
      }

      const demandGroups = groupDemands(cartLines);
      const demandOptions = await buildDemandOptions(demandGroups, deps.supplyResolver);
      const plan = chooseBestPlan(
        demandOptions,
        params.shippingOption,
        deps.shippingQuotePolicy,
      );
      const orderIds = await createOrdersFromPlan(params.buyerAccountId, plan, context);
      await deps.carts.checkout(params.buyerAccountId, context);

      return { orderIds };
    },
    createOrdersFromAcceptedOffer,
    cancelBuyerOrder: async (params, context) => {
      const order = await getBuyerOrder(deps.db, params.orderId, params.buyerAccountId);
      if (!order) {
        throw new OrderingDomainError("Order not found.");
      }
      if (order.status !== "pending-payment") {
        throw new OrderingDomainError("Only pending orders can be cancelled.");
      }

      for (const hold of order.inventory_holds) {
        if (hold.status === "active") {
          await deps.inventoryReservations.releaseReservation({
            sellerAccountId: hold.seller_account_id,
            holdId: hold.hold_id,
            context,
          });
        }
      }

      const result = await commandHandler({
        streamId: `ordering.order-${params.orderId}`,
        command: {
          type: "CancelOrder",
          cancelledAt: new Date().toISOString(),
        },
        context,
      });

      return { orderId: params.orderId, version: result.version };
    },
    cancelSellerOrder: async (params, context) => {
      const order = await getSellerOrder(deps.db, params.orderId, params.sellerAccountId);
      if (!order) {
        throw new OrderingDomainError("Order not found.");
      }
      if (order.status !== "pending-payment") {
        throw new OrderingDomainError("Only pending orders can be cancelled.");
      }

      for (const hold of order.inventory_holds) {
        if (hold.status === "active") {
          await deps.inventoryReservations.releaseReservation({
            sellerAccountId: hold.seller_account_id,
            holdId: hold.hold_id,
            context,
          });
        }
      }

      const result = await commandHandler({
        streamId: `ordering.order-${params.orderId}`,
        command: {
          type: "CancelOrder",
          cancelledAt: new Date().toISOString(),
        },
        context,
      });

      return { orderId: params.orderId, version: result.version };
    },
    listBuyerOrders: (params) => listBuyerOrders(deps.db, params),
    getBuyerOrder: (orderId, buyerAccountId) =>
      getBuyerOrder(deps.db, orderId, buyerAccountId),
    listSellerOrders: (params) => listSellerOrders(deps.db, params),
    getSellerOrder: (orderId, sellerAccountId) =>
      getSellerOrder(deps.db, orderId, sellerAccountId),
    projectors: [
      createProjector({
        projectorName: "ordering-order-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildOrderingOrderProjectionHandlers(deps.db),
      }),
      createProjector({
        projectorName: "ordering-marketplace-offer-acceptance",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: {
          "marketplace.offer.accepted": async (event) => {
            const data = event.data as unknown as {
              offerId: string;
              buyerAccountId: AccountId;
              sellerAccountId: AccountId;
              catalogItemId: string;
              catalogVersionKey: CatalogVersionKey;
              itemTitle: string;
              itemSubtitle: string | null;
              versionSelection: { dimensionId: string; choiceId: string }[];
              versionSummary: string | null;
              priceAmount: string;
              quantityRequested: number;
            };

            await createOrdersFromAcceptedOffer(data, {
              tenantId: event.tenantId,
              audit: event.audit,
              trace: event.trace,
            } as EventStoreContext);
          },
        },
      }),
      createProjector({
        projectorName: "ordering-payment-capture",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: {
          "payments.payment-captured": async (event) => {
            const data = event.data as {
              orderIds: string[];
              capturedAt: string;
            };

            for (const orderId of data.orderIds ?? []) {
              await commandHandler({
                streamId: `ordering.order-${orderId}`,
                command: {
                  type: "MarkReadyForFulfillment",
                  readyForFulfillmentAt: data.capturedAt,
                },
                context: {
                  tenantId: event.tenantId,
                  audit: event.audit,
                  trace: event.trace,
                } as EventStoreContext,
              });
            }
          },
        },
      }),
    ],
  };
}
