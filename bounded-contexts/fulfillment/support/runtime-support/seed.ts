import type { BcSeedAggregateStateReport } from "@chase-sets/bounded-context-module";
import {
  createSeedAggregateReconciler,
  loadSeedStreamEvents,
  reconcileSeedAggregates,
  type SeedAggregateReconciler,
} from "@chase-sets/bounded-context-runtime";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ShipmentLineId } from "../../features/shipments/domain/common";
import {
  decideFulfillmentShipment,
  evolveFulfillmentShipment,
  initialFulfillmentShipmentState,
  type FulfillmentShipmentCommand,
  type FulfillmentShipmentEvent,
  type FulfillmentShipmentState,
} from "../../features/shipments/domain/domain";
import { fulfillmentReservedSeedIds } from "@chase-sets/fulfillment/seed-support/ids";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { createFulfillmentServices, type FulfillmentServices } from "./services";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId, OrderId, ShipmentId, TenantId } from "@chase-sets/primitives/typed-ids";

type OrderSnapshot = Readonly<{
  order_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  shipping_option: string;
  shipping_destination_snapshot: AddressSnapshot;
  shipping_origin_snapshot: AddressSnapshot;
  lines: ReadonlyArray<{
    line_id: string;
    catalog_catalog_item_id: string;
    product_id: string;
    item_title: string;
    item_subtitle: string | null;
    product_summary: string | null;
    quantity: number;
  }>;
}>;

function createSeedContext(): EventStoreContext {
  return {
    tenantId: "tnt_seed_development" as TenantId,
    audit: {
      performedByUserId: identitySeedIds.demo.userId,
      forAccountId: identitySeedIds.demo.accountId,
    },
  };
}

type OrderSnapshotRow = Omit<OrderSnapshot, "lines">;

async function loadOrderLines(pool: PgTransactionalPool, orderId: string): Promise<OrderSnapshot["lines"]> {
  const linesResult = await pool.query<OrderSnapshot["lines"][number]>(
    `SELECT
       line_id,
       catalog_catalog_item_id,
       product_id,
       item_title,
       item_subtitle,
       product_summary,
       quantity
     FROM fulfillment_order_source_lines
     WHERE order_id = $1
     ORDER BY line_index ASC, line_id ASC`,
    [orderId],
  );

  return linesResult.rows;
}

// Seeded accepted-offer orders can carry generated ids (the offer-acceptance
// projection creates them before the ordering seed pins reserved ids), so seed
// order identity keys off ready_for_fulfillment_at, which the payments seed
// fixes via payment-capture timestamps: the earliest-ready order is the
// reference order (it receives the support-request seeds), and the
// latest-ready order stays support-free so its review eligibility survives
// for the marketplace reviews seed.
async function loadSeedOrders(
  pool: PgTransactionalPool,
): Promise<Readonly<{ referenceOrder: OrderSnapshot; reviewEligibleOrder: OrderSnapshot }> | null> {
  const orderResult = await pool.query<OrderSnapshotRow>(
    `SELECT
       order_id,
       buyer_account_id,
       seller_account_id,
       shipping_option,
       shipping_destination_snapshot,
       shipping_origin_snapshot
     FROM fulfillment_order_sources
     WHERE status = 'ready-for-fulfillment'
     ORDER BY ready_for_fulfillment_at ASC NULLS LAST, order_id ASC
     LIMIT 2`,
  );
  const [referenceOrder, reviewEligibleOrder] = orderResult.rows;
  if (!referenceOrder || !reviewEligibleOrder) {
    console.log("Fulfillment seed is waiting for two ready-for-fulfillment orders. Skipping shipments for this pass.");
    return null;
  }

  return {
    referenceOrder: { ...referenceOrder, lines: await loadOrderLines(pool, referenceOrder.order_id) },
    reviewEligibleOrder: { ...reviewEligibleOrder, lines: await loadOrderLines(pool, reviewEligibleOrder.order_id) },
  };
}

const FULFILLMENT_BOOTSTRAP_LABEL = "Fulfillment seed bootstrap";

const shipmentStreamId = (shipmentId: string) => `fulfillment.shipment-${shipmentId}`;

type SeedShipmentTarget = "awaiting-label" | "label-attached" | "dispatched" | "delivered" | "returned" | "exception";

type SeedShipmentPlan = Readonly<{
  shipmentId: string;
  order: "reference" | "review-eligible";
  createdAt: string;
  labelReference: string;
  trackingIdentifier: string;
  target: SeedShipmentTarget;
}>;

// One plan per reserved seed shipment. Each plan is the full ordered command
// sequence for its own `fulfillment.shipment-*` stream, so a shipment
// interrupted part way through packing resumes from exactly where its stream
// stops instead of being re-created or mistaken for finished.
const seedShipmentPlans: readonly SeedShipmentPlan[] = [
  {
    shipmentId: fulfillmentReservedSeedIds.shipments.awaitingLabel,
    order: "reference",
    createdAt: "2026-03-22T10:00:00.000Z",
    labelReference: "lbl_seed_awaiting_label",
    trackingIdentifier: "1ZSEEDAWAITINGLABEL",
    target: "awaiting-label",
  },
  {
    shipmentId: fulfillmentReservedSeedIds.shipments.labelAttached,
    order: "reference",
    createdAt: "2026-03-22T10:10:00.000Z",
    labelReference: "lbl_seed_label_attached",
    trackingIdentifier: "1ZSEEDLABELATTACHED",
    target: "label-attached",
  },
  {
    shipmentId: fulfillmentReservedSeedIds.shipments.dispatchedShipment,
    order: "reference",
    createdAt: "2026-03-22T10:20:00.000Z",
    labelReference: "lbl_seed_dispatched",
    trackingIdentifier: "1ZSEEDDISPATCHED",
    target: "dispatched",
  },
  {
    shipmentId: fulfillmentReservedSeedIds.shipments.demoCharizardShipment,
    order: "reference",
    createdAt: "2026-03-22T10:30:00.000Z",
    labelReference: "lbl_seed_demo_charizard",
    trackingIdentifier: "1ZSEEDDELIVERED",
    target: "delivered",
  },
  {
    shipmentId: fulfillmentReservedSeedIds.shipments.returnedShipment,
    order: "reference",
    createdAt: "2026-03-22T10:40:00.000Z",
    labelReference: "lbl_seed_returned",
    trackingIdentifier: "1ZSEEDRETURNED",
    target: "returned",
  },
  {
    shipmentId: fulfillmentReservedSeedIds.shipments.exceptionShipment,
    order: "reference",
    createdAt: "2026-03-22T10:50:00.000Z",
    labelReference: "lbl_seed_exception",
    trackingIdentifier: "1ZSEEDEXCEPTION",
    target: "exception",
  },
  // The review-eligible order ships and delivers without a support request, so
  // its review eligibility survives for the marketplace reviews seed.
  {
    shipmentId: fulfillmentReservedSeedIds.shipments.reviewEligibleDelivered,
    order: "review-eligible",
    createdAt: "2026-03-22T11:00:00.000Z",
    labelReference: "lbl_seed_review_eligible",
    trackingIdentifier: "1ZSEEDREVIEWELIGIBLE",
    target: "delivered",
  },
];

const SEED_SHIPMENT_STAGE_AT = "2026-03-22T12:00:00.000Z";

function buildSeedShipmentSteps(plan: SeedShipmentPlan, order: OrderSnapshot): readonly FulfillmentShipmentCommand[] {
  const steps: FulfillmentShipmentCommand[] = [
    {
      type: "CreateShipment",
      shipmentId: plan.shipmentId as ShipmentId,
      orderId: order.order_id as OrderId,
      buyerAccountId: order.buyer_account_id as AccountId,
      sellerAccountId: order.seller_account_id as AccountId,
      shippingOption: order.shipping_option,
      shippingDestinationSnapshot: order.shipping_destination_snapshot,
      shippingOriginSnapshot: order.shipping_origin_snapshot,
      lines: order.lines.map((line, index) => ({
        lineId: `spl_seed_${plan.shipmentId}_${index}` as ShipmentLineId,
        orderLineId: line.line_id,
        catalogItemId: line.catalog_catalog_item_id as CatalogItemId,
        productId: line.product_id as ProductKey,
        itemTitle: line.item_title,
        itemSubtitle: line.item_subtitle,
        productSummary: line.product_summary,
        quantity: line.quantity,
      })),
      createdAt: plan.createdAt,
    },
    { type: "StartShipmentPacking", startedAt: SEED_SHIPMENT_STAGE_AT },
    ...order.lines.map(
      (_line, index): FulfillmentShipmentCommand => ({
        type: "ConfirmShipmentPackingLine",
        lineId: `spl_seed_${plan.shipmentId}_${index}` as ShipmentLineId,
        confirmedAt: SEED_SHIPMENT_STAGE_AT,
      }),
    ),
    { type: "PrepareShipmentPackage", packageCount: 1, preparedAt: SEED_SHIPMENT_STAGE_AT },
  ];

  if (plan.target === "awaiting-label") {
    return steps;
  }

  steps.push({
    type: "AttachShipmentLabel",
    shippingMethod: "standard",
    carrierName: "UPS",
    labelReference: plan.labelReference,
    trackingIdentifier: plan.trackingIdentifier,
    postageAmountCents: 599,
    postageCurrency: "USD",
    attachedAt: SEED_SHIPMENT_STAGE_AT,
  });
  if (plan.target === "label-attached") {
    return steps;
  }

  steps.push({ type: "DispatchShipment", dispatchedAt: SEED_SHIPMENT_STAGE_AT });
  switch (plan.target) {
    case "dispatched":
      return steps;
    case "delivered":
      steps.push({ type: "RecordShipmentDelivery", deliveredAt: SEED_SHIPMENT_STAGE_AT });
      return steps;
    case "returned":
      steps.push({
        type: "ReturnShipment",
        reason: "Carrier return to sender",
        returnedAt: SEED_SHIPMENT_STAGE_AT,
      });
      return steps;
    case "exception":
      steps.push({
        type: "RaiseShipmentException",
        exceptionType: "carrier-delay",
        notes: "Missed origin scan handoff.",
        raisedAt: SEED_SHIPMENT_STAGE_AT,
      });
      return steps;
  }
}

function buildSeedShipmentReconcilers(
  services: FulfillmentServices,
  context: EventStoreContext,
  seedOrders: Readonly<{ referenceOrder: OrderSnapshot; reviewEligibleOrder: OrderSnapshot }>,
): readonly SeedAggregateReconciler[] {
  return seedShipmentPlans.map((plan) => {
    const order = plan.order === "reference" ? seedOrders.referenceOrder : seedOrders.reviewEligibleOrder;
    return createSeedAggregateReconciler<
      FulfillmentShipmentState,
      FulfillmentShipmentCommand,
      FulfillmentShipmentEvent
    >({
      db: services.db,
      contextName: "fulfillment",
      bootstrapLabel: FULFILLMENT_BOOTSTRAP_LABEL,
      aggregateName: "Shipment",
      id: plan.shipmentId,
      key: plan.trackingIdentifier,
      streamId: shipmentStreamId(plan.shipmentId),
      initialState: initialFulfillmentShipmentState,
      decide: decideFulfillmentShipment,
      evolve: evolveFulfillmentShipment,
      steps: buildSeedShipmentSteps(plan, order),
      send: (streamId, command) => services.shipments.commandHandler({ streamId, command, context }),
    });
  });
}

async function loadSeedShipmentState(db: PgQueryable, shipmentId: string) {
  const committed = await loadSeedStreamEvents<FulfillmentShipmentEvent>(db, shipmentStreamId(shipmentId));
  return { committed, state: committed.reduce(evolveFulfillmentShipment, initialFulfillmentShipmentState) };
}

/**
 * Reports the Fulfillment seed's shipment state from the authoritative
 * `fulfillment.shipment-*` streams.
 *
 * `fulfillment_shipment_pages` is UNLOGGED, so PostgreSQL truncates it on crash
 * recovery while the logged streams survive; the projection-sourced guard this
 * replaced then read zero rows and replayed `CreateShipment` into an existing
 * aggregate. State is folded from each shipment's own stream, so it never
 * depends on the upstream order projection being current.
 */
export async function inspectFulfillmentSeedState(
  pool: PgTransactionalPool,
): Promise<readonly BcSeedAggregateStateReport[]> {
  const reports: BcSeedAggregateStateReport[] = [];

  for (const plan of seedShipmentPlans) {
    const { committed, state } = await loadSeedShipmentState(pool, plan.shipmentId);
    reports.push({
      contextName: "fulfillment",
      aggregateName: "Shipment",
      id: plan.shipmentId,
      key: plan.trackingIdentifier,
      streamId: shipmentStreamId(plan.shipmentId),
      kind: state.shipmentId === null ? "absent" : state.status === plan.target ? "active" : "draft",
      status: state.shipmentId === null ? null : String(state.status),
      eventCount: committed.length,
    });
  }

  return reports;
}

async function everySeedShipmentComplete(db: PgQueryable): Promise<boolean> {
  for (const plan of seedShipmentPlans) {
    const { state } = await loadSeedShipmentState(db, plan.shipmentId);
    if (state.status !== plan.target) {
      return false;
    }
  }
  return true;
}

export async function seedFulfillmentDatabase(pool: PgTransactionalPool) {
  const services = createFulfillmentServices(pool);

  // The upstream order snapshot is a precondition only for shipments this seed
  // has still to author. Requiring it unconditionally would leave the seed
  // reporting "waiting" forever once delivered shipments move their orders past
  // `ready-for-fulfillment`.
  if (await everySeedShipmentComplete(services.db)) {
    return;
  }

  const seedOrders = await loadSeedOrders(pool);
  if (!seedOrders) {
    return;
  }

  await reconcileSeedAggregates(buildSeedShipmentReconcilers(services, createSeedContext(), seedOrders), true);
}
