import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createNoopNotificationOutbox, type NotificationOutbox } from "@chase-sets/notifications";
import {
  createNoopPostageProviderWebhookGateway,
  PostageLabelProviderError,
  type PostageAddress,
  type PostageLabelProvider,
  type PostagePackage,
  type PostageProviderWebhookEvent,
  type PostageProviderWebhookGateway,
  type PostageProviderWebhookInput,
} from "@chase-sets/postage-labels";
import {
  addressSnapshotsEqual,
  changedAddressSnapshotSide,
  normalizeAddressSnapshot,
  type AddressSnapshot,
} from "@chase-sets/primitives/address-snapshot";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, OrderId, ShipmentId } from "@chase-sets/primitives/typed-ids";
import type { PackagePlan } from "@chase-sets/product-measures";
import { FulfillmentDomainError } from "../domain/common";
import {
  getBuyerShipment,
  getSellerShipment,
  listSellerPackingSlips,
  listBuyerShipments,
  listSellerShipments,
  recordFulfillmentPostageLabelOperationFailed,
  recordFulfillmentPostageLabelOperationPending,
  recordFulfillmentPostageLabelOperationSucceeded,
} from "../read-model/queries";
import { buildFulfillmentShipmentProjectionHandlers } from "../read-model/projection";
import {
  buildFulfillmentTransactionalEmailProjectionHandlers,
  FULFILLMENT_TRANSACTIONAL_EMAIL_PROJECTION,
} from "../integrations/transactional-email/transactional-email-projector";
import {
  decideFulfillmentShipment,
  evolveFulfillmentShipment,
  initialFulfillmentShipmentState,
  type FulfillmentShipmentCommand,
  type FulfillmentShipmentEvent,
  type FulfillmentShipmentState,
} from "../domain/domain";

type ShipmentRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  postageLabelProvider?: PostageLabelProvider;
  postageWebhookGateway?: PostageProviderWebhookGateway;
  notificationOutbox?: NotificationOutbox;
}>;

type ShipmentForPostageProviderEvent = Readonly<{
  shipment_id: string;
  seller_account_id: string;
  status: string;
  tracking_identifier: string | null;
  postage_provider_shipment_id: string | null;
}>;

export type PostageProviderWebhookProcessingResult = Readonly<{
  status: "ignored" | "recorded" | "duplicate";
  providerEventId?: string;
  eventKind?: string;
  shipmentId?: string | null;
  processingResult?: string;
}>;

type ReadyOrderLineSnapshot = Readonly<{
  order_line_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  item_title: string;
  item_subtitle: string | null;
  product_summary: string | null;
  quantity: number;
}>;

type ReadyOrderSnapshot = Readonly<{
  order_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  shipping_option: string;
  shipping_destination_snapshot: AddressSnapshot;
  shipping_origin_snapshot: AddressSnapshot;
  shipping_plan_snapshot: PackagePlan | null;
  lines: readonly ReadyOrderLineSnapshot[];
}>;

export type FulfillmentShipmentServices = Readonly<{
  commandHandler: CommandHandler<FulfillmentShipmentCommand, FulfillmentShipmentState, FulfillmentShipmentEvent>;
  packShipment: (
    params: Readonly<{
      shipmentId: string;
      sellerAccountId: string;
      packageCount: number;
    }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  startPackingShipment: (
    params: Readonly<{ shipmentId: string; sellerAccountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  confirmPackingLine: (
    params: Readonly<{ shipmentId: string; sellerAccountId: string; lineId: string }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  unconfirmPackingLine: (
    params: Readonly<{ shipmentId: string; sellerAccountId: string; lineId: string }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  setPackingLineQuantity: (
    params: Readonly<{ shipmentId: string; sellerAccountId: string; lineId: string; confirmedQuantity: number }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  attachLabel: (
    params: Readonly<{
      shipmentId: string;
      sellerAccountId: string;
      shippingMethod: string;
      carrierName: string;
      labelReference: string;
      trackingIdentifier: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  purchaseUspsLabel: (
    params: Readonly<{
      shipmentId: string;
      sellerAccountId: string;
      serviceLevel: string;
      sender?: PostageAddress | null;
      recipient?: PostageAddress | null;
      overrideReason?: string | null;
      package?: PostagePackage | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number; trackingIdentifier: string }>;
  voidLabel: (
    params: Readonly<{ shipmentId: string; sellerAccountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  dispatchShipment: (
    params: Readonly<{ shipmentId: string; sellerAccountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  deliverShipment: (
    params: Readonly<{ shipmentId: string; sellerAccountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  returnShipment: (
    params: Readonly<{
      shipmentId: string;
      sellerAccountId: string;
      reason?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  raiseShipmentException: (
    params: Readonly<{
      shipmentId: string;
      sellerAccountId: string;
      exceptionType: string;
      notes?: string | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  processPostageProviderWebhook: (
    input: PostageProviderWebhookInput,
    context: EventStoreContext,
  ) => Promise<PostageProviderWebhookProcessingResult>;
  cancelShipmentForCancelledOrder: (params: {
    orderId: string;
    cancelledAt: string;
    context: EventStoreContext;
  }) => Promise<{ shipmentId: ShipmentId | null }>;
  listBuyerShipments: (params: Parameters<typeof listBuyerShipments>[1]) => ReturnType<typeof listBuyerShipments>;
  getBuyerShipment: (shipmentId: string, buyerAccountId: string) => ReturnType<typeof getBuyerShipment>;
  listSellerShipments: (params: Parameters<typeof listSellerShipments>[1]) => ReturnType<typeof listSellerShipments>;
  getSellerShipment: (shipmentId: string, sellerAccountId: string) => ReturnType<typeof getSellerShipment>;
  listSellerPackingSlips: (
    params: Parameters<typeof listSellerPackingSlips>[1],
  ) => ReturnType<typeof listSellerPackingSlips>;
  createShipmentForReadyOrder: (params: {
    orderId: string;
    readyForFulfillmentAt: string;
    context: EventStoreContext;
  }) => Promise<{ shipmentId: ShipmentId | null }>;
  projectors: readonly ProjectionHandlerSet[];
}>;

async function findExistingShipmentIdForOrder(db: PgQueryable, orderId: string): Promise<string | null> {
  const result = await db.query<{ shipment_id: string }>(
    `SELECT shipment_id
     FROM fulfillment_shipment_pages
     WHERE order_id = $1
     ORDER BY created_at ASC, shipment_id ASC
     LIMIT 1`,
    [orderId],
  );

  return result.rows[0]?.shipment_id ?? null;
}

async function loadReadyOrderSnapshot(db: PgQueryable, orderId: string): Promise<ReadyOrderSnapshot | null> {
  const orderResult = await db.query<{
    order_id: string;
    buyer_account_id: string;
    seller_account_id: string;
    shipping_option: string;
    shipping_destination_snapshot: AddressSnapshot;
    shipping_origin_snapshot: AddressSnapshot;
    shipping_plan_snapshot: PackagePlan | null;
    status: string;
  }>(
    `SELECT
       order_id,
       buyer_account_id,
       seller_account_id,
       shipping_option,
       shipping_destination_snapshot,
       shipping_origin_snapshot,
       shipping_plan_snapshot,
       status
     FROM fulfillment_order_sources
     WHERE order_id = $1`,
    [orderId],
  );

  const order = orderResult.rows[0];
  if (!order || order.status !== "ready-for-fulfillment") {
    return null;
  }

  const linesResult = await db.query<ReadyOrderLineSnapshot>(
    `SELECT
       line_id AS order_line_id,
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

  return {
    order_id: order.order_id,
    buyer_account_id: order.buyer_account_id,
    seller_account_id: order.seller_account_id,
    shipping_option: order.shipping_option,
    shipping_destination_snapshot: order.shipping_destination_snapshot,
    shipping_origin_snapshot: order.shipping_origin_snapshot,
    shipping_plan_snapshot: normalizePackagePlanSnapshot(order.shipping_plan_snapshot),
    lines: linesResult.rows,
  };
}

type CancellableShipmentSnapshot = Readonly<{
  shipment_id: string;
  status: string;
  package_status: string;
}>;

async function loadCancellableShipmentForOrder(
  db: PgQueryable,
  orderId: string,
): Promise<CancellableShipmentSnapshot | null> {
  const result = await db.query<CancellableShipmentSnapshot>(
    `SELECT shipment_id, status, package_status
     FROM fulfillment_shipment_pages
     WHERE order_id = $1
     ORDER BY created_at ASC, shipment_id ASC
     LIMIT 1`,
    [orderId],
  );

  return result.rows[0] ?? null;
}

async function findShipmentForPostageProviderEvent(
  db: PgQueryable,
  event: PostageProviderWebhookEvent,
): Promise<ShipmentForPostageProviderEvent | null> {
  const trackingIdentifier = event.trackingIdentifier?.trim() || null;
  const providerShipmentId = event.providerShipmentId?.trim() || null;
  if (!trackingIdentifier && !providerShipmentId) {
    return null;
  }

  const result = await db.query<ShipmentForPostageProviderEvent>(
    `SELECT
       shipment_id,
       seller_account_id,
       status,
       tracking_identifier,
       postage_provider_shipment_id
     FROM fulfillment_shipment_pages
     WHERE ($1::text IS NOT NULL AND tracking_identifier = $1)
        OR ($2::text IS NOT NULL AND postage_provider_shipment_id = $2)
     ORDER BY updated_at DESC, shipment_id DESC
     LIMIT 1`,
    [trackingIdentifier, providerShipmentId],
  );

  return result.rows[0] ?? null;
}

async function reservePostageProviderEvent(
  db: PgQueryable,
  event: PostageProviderWebhookEvent,
  shipment: ShipmentForPostageProviderEvent | null,
) {
  const result = await db.query<{ provider_event_id: string }>(
    `INSERT INTO fulfillment_postage_provider_events (
       provider_event_id,
       provider_name,
       provider_mode,
       event_kind,
       provider_object_reference,
       shipment_id,
       tracking_identifier,
       status,
       status_detail,
       occurred_at,
       received_at,
       processing_result,
       payload_json
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, 'received', $12::jsonb)
     ON CONFLICT (provider_event_id) DO NOTHING
     RETURNING provider_event_id`,
    [
      event.providerEventId,
      event.providerName,
      event.providerMode,
      event.eventKind,
      event.providerObjectReference,
      shipment?.shipment_id ?? null,
      event.trackingIdentifier ?? shipment?.tracking_identifier ?? null,
      event.status ?? null,
      event.statusDetail ?? null,
      event.occurredAt,
      event.receivedAt ?? new Date().toISOString(),
      JSON.stringify(event.payload ?? {}),
    ],
  );

  return result.rows.length > 0 || (result.rowCount ?? 0) > 0;
}

async function markPostageProviderEventProcessed(db: PgQueryable, providerEventId: string, processingResult: string) {
  await db.query(
    `UPDATE fulfillment_postage_provider_events
     SET processing_result = $2
     WHERE provider_event_id = $1`,
    [providerEventId, processingResult],
  );
}

async function applyPostageProviderTrackingEvent(
  commandHandler: CommandHandler<FulfillmentShipmentCommand, FulfillmentShipmentState, FulfillmentShipmentEvent>,
  event: PostageProviderWebhookEvent,
  shipment: ShipmentForPostageProviderEvent,
  context: EventStoreContext,
) {
  const status = (event.status ?? "").trim().toLowerCase();
  const detail = (event.statusDetail ?? "").trim().toLowerCase();
  const occurredAt = event.occurredAt;
  const streamId = `fulfillment.shipment-${shipment.shipment_id}`;
  let shipmentStatus = shipment.status;

  async function dispatchIfNeeded() {
    if (shipmentStatus !== "label-attached") {
      return false;
    }

    await commandHandler({
      streamId,
      command: {
        type: "DispatchShipment",
        dispatchedAt: occurredAt,
      },
      context,
    });
    shipmentStatus = "dispatched";
    return true;
  }

  if (status === "delivered") {
    await dispatchIfNeeded();
    if (shipmentStatus === "dispatched" || shipmentStatus === "exception") {
      await commandHandler({
        streamId,
        command: {
          type: "RecordShipmentDelivery",
          deliveredAt: occurredAt,
        },
        context,
      });
      return "delivered";
    }
    return "recorded";
  }

  if (status === "return_to_sender") {
    await dispatchIfNeeded();
    if (shipmentStatus === "dispatched" || shipmentStatus === "exception") {
      await commandHandler({
        streamId,
        command: {
          type: "ReturnShipment",
          reason: event.statusDetail ?? event.message ?? "Carrier marked the shipment return to sender.",
          returnedAt: occurredAt,
        },
        context,
      });
      return "returned";
    }
    return "recorded";
  }

  if (status === "in_transit" || status === "out_for_delivery" || status === "available_for_pickup") {
    return (await dispatchIfNeeded()) ? "dispatched" : "recorded";
  }

  if (isExceptionTrackingStatus(status, detail)) {
    if (shipmentStatus === "delivered" || shipmentStatus === "returned" || shipmentStatus === "cancelled") {
      return "recorded";
    }

    await commandHandler({
      streamId,
      command: {
        type: "RaiseShipmentException",
        exceptionType: classifyShipmentException(status, detail),
        notes: event.statusDetail ?? event.message ?? event.status ?? null,
        raisedAt: occurredAt,
      },
      context,
    });
    return "exception-raised";
  }

  return "recorded";
}

function isExceptionTrackingStatus(status: string, detail: string) {
  return (
    status === "failure" ||
    status === "error" ||
    detail.includes("lost") ||
    detail.includes("damage") ||
    detail.includes("exception") ||
    detail.includes("unable") ||
    detail.includes("delayed") ||
    detail.includes("held")
  );
}

function classifyShipmentException(status: string, detail: string) {
  if (status === "return_to_sender" || detail.includes("return")) {
    return "return-to-sender" as const;
  }
  if (detail.includes("lost")) {
    return "lost-in-transit" as const;
  }
  if (detail.includes("damage")) {
    return "damaged-package" as const;
  }
  if (detail.includes("delay") || detail.includes("held")) {
    return "carrier-delay" as const;
  }
  return "other" as const;
}

function postageAddressFromSnapshot(address: AddressSnapshot): PostageAddress {
  return {
    name: address.name,
    company: address.company ?? null,
    street1: address.line1,
    street2: address.line2 ?? null,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
    phone: address.phone ?? null,
    email: address.email ?? null,
  };
}

function addressSnapshotFromPostage(address: PostageAddress): AddressSnapshot {
  return normalizeAddressSnapshot({
    name: address.name,
    company: address.company ?? null,
    line1: address.street1,
    line2: address.street2 ?? null,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
    phone: address.phone ?? null,
    email: address.email ?? null,
  });
}

function normalizePackagePlanSnapshot(value: PackagePlan | null | undefined) {
  if (!value || typeof value !== "object" || !Array.isArray(value.packages) || value.packages.length === 0) {
    return null;
  }
  return value;
}

function postagePackageFromShippingPlan(plan: PackagePlan | null): PostagePackage {
  const selectedPackage =
    plan?.packages.find((candidate) => candidate.mailpieceClass === "parcel") ?? plan?.packages[0] ?? null;
  if (!selectedPackage) {
    throw new FulfillmentDomainError("Shipment does not have a package plan for label purchase.");
  }
  if (selectedPackage.mailpieceClass === "letter") {
    return {
      mailpieceClass: "letter",
      lengthInches: 9.5,
      widthInches: 4.125,
      heightInches: 0.25,
      weightOunces: selectedPackage.weightOunces,
    };
  }
  return {
    mailpieceClass: selectedPackage.mailpieceClass,
    lengthInches: selectedPackage.lengthInches,
    widthInches: selectedPackage.widthInches,
    heightInches: selectedPackage.heightInches,
    weightOunces: selectedPackage.weightOunces,
  };
}

function postageLabelSizeFromPackage(pkg: PostagePackage) {
  if (pkg.mailpieceClass === "letter") {
    return "7x3" as const;
  }
  return null;
}

function postageDeliveryConfirmationFromShippingPlan(plan: PackagePlan | null | undefined) {
  return plan?.postagePolicySnapshot?.signatureRequired ? ("signature" as const) : null;
}

function postageProviderErrorCode(error: unknown) {
  if (error instanceof PostageLabelProviderError) {
    return error.name;
  }
  return error instanceof Error ? error.name : "postage_error";
}

function postageLabelFailureErrorCode(error: unknown) {
  if (error instanceof FulfillmentDomainError) {
    return "postage_policy_validation_failed";
  }
  return postageProviderErrorCode(error);
}

function isLetterMailServiceLevel(serviceLevel: string) {
  return ["first", "letter", "usps_first", "usps_first_class_mail"].includes(serviceLevel.trim().toLowerCase());
}

function assertPostagePolicyCompliance(
  plan: PackagePlan | null | undefined,
  pkg: PostagePackage,
  serviceLevel: string,
) {
  const snapshot = plan?.postagePolicySnapshot;
  if (!snapshot?.parcelRequired) {
    return;
  }

  if (pkg.mailpieceClass === "letter" || pkg.mailpieceClass === "flat" || isLetterMailServiceLevel(serviceLevel)) {
    throw new FulfillmentDomainError(
      "Parcel postage is required by the committed postage policy snapshot for this shipment.",
    );
  }
}

function postageLabelOperationRequest(
  input: Readonly<{
    shipmentId: string;
    orderId: string;
    serviceLevel: string;
    deliveryConfirmation: "signature" | null;
    labelPackage: PostagePackage;
    labelSize: "7x3" | null;
    addressOverrideAudit: {
      changedSide: string;
      reason: string;
      actor: string;
      timestamp: string;
    } | null;
    shippingPlanSnapshot: PackagePlan | null;
  }>,
) {
  const policySnapshot = input.shippingPlanSnapshot?.postagePolicySnapshot ?? null;
  return {
    shipmentId: input.shipmentId,
    orderId: input.orderId,
    serviceLevel: input.serviceLevel,
    deliveryConfirmation: input.deliveryConfirmation,
    labelSize: input.labelSize,
    package: input.labelPackage,
    addressOverride: input.addressOverrideAudit,
    postagePolicySnapshot: policySnapshot
      ? {
          policyVersion: policySnapshot.policyVersion,
          parcelRequired: policySnapshot.parcelRequired,
          parcelReasons: policySnapshot.parcelReasons,
          signatureRequired: policySnapshot.signatureRequired,
          signatureReasons: policySnapshot.signatureReasons,
        }
      : null,
  };
}

export function createFulfillmentShipmentRuntime(deps: ShipmentRuntimeDeps): FulfillmentShipmentServices {
  const postageLabelProvider = deps.postageLabelProvider ?? createUnconfiguredPostageLabelProvider();
  const postageWebhookGateway = deps.postageWebhookGateway ?? createNoopPostageProviderWebhookGateway();
  const notificationOutbox = deps.notificationOutbox ?? createNoopNotificationOutbox();
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<FulfillmentShipmentEvent>(),
      initialState: () => initialFulfillmentShipmentState,
      evolve: evolveFulfillmentShipment,
    }),
    evolve: evolveFulfillmentShipment,
    decide: decideFulfillmentShipment,
  });

  async function requireSellerShipment(shipmentId: string, sellerAccountId: string) {
    const shipment = await getSellerShipment(deps.db, shipmentId, sellerAccountId);
    if (!shipment) {
      throw new FulfillmentDomainError("Shipment not found.");
    }
    return shipment;
  }

  return {
    commandHandler,
    processPostageProviderWebhook: async (input, context) => {
      const event = await postageWebhookGateway.processPostageProviderWebhook(input);
      if (!event) {
        return { status: "ignored", processingResult: "ignored" };
      }

      const shipment = await findShipmentForPostageProviderEvent(deps.db, event);
      const reserved = await reservePostageProviderEvent(deps.db, event, shipment);
      if (!reserved) {
        return {
          status: "duplicate",
          providerEventId: event.providerEventId,
          eventKind: event.eventKind,
          shipmentId: shipment?.shipment_id ?? null,
          processingResult: "duplicate",
        };
      }

      let processingResult = "recorded";
      if (!shipment) {
        processingResult = "unmatched";
      } else if (event.eventKind === "tracking-status") {
        processingResult = await applyPostageProviderTrackingEvent(commandHandler, event, shipment, context);
      }

      await markPostageProviderEventProcessed(deps.db, event.providerEventId, processingResult);

      return {
        status: "recorded",
        providerEventId: event.providerEventId,
        eventKind: event.eventKind,
        shipmentId: shipment?.shipment_id ?? null,
        processingResult,
      };
    },
    createShipmentForReadyOrder: async (params) => {
      const existingShipmentId = await findExistingShipmentIdForOrder(deps.db, params.orderId);
      if (existingShipmentId) {
        return { shipmentId: null };
      }

      const order = await loadReadyOrderSnapshot(deps.db, params.orderId);
      if (!order) {
        return { shipmentId: null };
      }

      const shipmentId = createId("shp") as ShipmentId;
      await commandHandler({
        streamId: `fulfillment.shipment-${shipmentId}`,
        command: {
          type: "CreateShipment",
          shipmentId,
          orderId: order.order_id as OrderId,
          buyerAccountId: order.buyer_account_id as AccountId,
          sellerAccountId: order.seller_account_id as AccountId,
          shippingOption: order.shipping_option,
          shippingDestinationSnapshot: order.shipping_destination_snapshot,
          shippingOriginSnapshot: order.shipping_origin_snapshot,
          shippingPlanSnapshot: order.shipping_plan_snapshot,
          lines: order.lines.map((line) => ({
            lineId: createId("spl"),
            orderLineId: line.order_line_id,
            catalogItemId: line.catalog_catalog_item_id,
            productId: line.product_id,
            itemTitle: line.item_title,
            itemSubtitle: line.item_subtitle,
            productSummary: line.product_summary,
            quantity: line.quantity,
            packingConfirmedQuantity: 0,
            packingConfirmedAt: null,
          })),
          createdAt: params.readyForFulfillmentAt,
        },
        context: params.context,
      });

      return { shipmentId };
    },
    cancelShipmentForCancelledOrder: async (params) => {
      const shipment = await loadCancellableShipmentForOrder(deps.db, params.orderId);
      if (!shipment || shipment.status === "cancelled") {
        return { shipmentId: null };
      }
      if (shipment.status !== "awaiting-package" || shipment.package_status !== "awaiting-package") {
        return { shipmentId: null };
      }

      await commandHandler({
        streamId: `fulfillment.shipment-${shipment.shipment_id}`,
        command: {
          type: "CancelShipment",
          cancelledAt: params.cancelledAt,
        },
        context: params.context,
      });

      return { shipmentId: shipment.shipment_id as ShipmentId };
    },
    packShipment: async (params, context) => {
      await requireSellerShipment(params.shipmentId, params.sellerAccountId);

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "PrepareShipmentPackage",
          packageCount: params.packageCount,
          preparedAt: new Date().toISOString(),
        },
        context,
      });

      return { shipmentId: params.shipmentId, version: result.version };
    },
    startPackingShipment: async (params, context) => {
      await requireSellerShipment(params.shipmentId, params.sellerAccountId);

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "StartShipmentPacking",
          startedAt: new Date().toISOString(),
        },
        context,
      });

      return { shipmentId: params.shipmentId, version: result.version };
    },
    confirmPackingLine: async (params, context) => {
      await requireSellerShipment(params.shipmentId, params.sellerAccountId);

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "ConfirmShipmentPackingLine",
          lineId: params.lineId as never,
          confirmedAt: new Date().toISOString(),
        },
        context,
      });

      return { shipmentId: params.shipmentId, version: result.version };
    },
    unconfirmPackingLine: async (params, context) => {
      await requireSellerShipment(params.shipmentId, params.sellerAccountId);

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "UnconfirmShipmentPackingLine",
          lineId: params.lineId as never,
          unconfirmedAt: new Date().toISOString(),
        },
        context,
      });

      return { shipmentId: params.shipmentId, version: result.version };
    },
    setPackingLineQuantity: async (params, context) => {
      await requireSellerShipment(params.shipmentId, params.sellerAccountId);

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "SetShipmentPackingLineQuantity",
          lineId: params.lineId as never,
          confirmedQuantity: params.confirmedQuantity,
          setAt: new Date().toISOString(),
        },
        context,
      });

      return { shipmentId: params.shipmentId, version: result.version };
    },
    attachLabel: async (params, context) => {
      await requireSellerShipment(params.shipmentId, params.sellerAccountId);

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "AttachShipmentLabel",
          shippingMethod: params.shippingMethod as never,
          carrierName: params.carrierName,
          labelReference: params.labelReference,
          trackingIdentifier: params.trackingIdentifier,
          attachedAt: new Date().toISOString(),
        },
        context,
      });

      return { shipmentId: params.shipmentId, version: result.version };
    },
    purchaseUspsLabel: async (params, context) => {
      const shipment = await requireSellerShipment(params.shipmentId, params.sellerAccountId);
      if (shipment.status !== "awaiting-label" || shipment.package_status !== "packed") {
        throw new FulfillmentDomainError(
          "Shipment must be packed and awaiting a label before postage can be purchased.",
        );
      }
      const senderSnapshot = normalizeAddressSnapshot(
        shipment.shipping_origin_snapshot ?? {
          name: "",
          line1: "",
          city: "",
          state: "",
          postalCode: "",
          country: "US",
        },
        "Shipping origin",
      );
      const recipientSnapshot = normalizeAddressSnapshot(
        shipment.shipping_destination_snapshot,
        "Shipping destination",
      );
      const submittedSender = params.sender ? addressSnapshotFromPostage(params.sender) : senderSnapshot;
      const submittedRecipient = params.recipient ? addressSnapshotFromPostage(params.recipient) : recipientSnapshot;
      const senderChanged = !addressSnapshotsEqual(senderSnapshot, submittedSender);
      const recipientChanged = !addressSnapshotsEqual(recipientSnapshot, submittedRecipient);
      const changedSide = changedAddressSnapshotSide(senderChanged, recipientChanged);
      const overrideReason = params.overrideReason?.trim() ?? "";
      if (changedSide && overrideReason.length === 0) {
        throw new FulfillmentDomainError(
          "Address override reason is required when label addresses differ from shipment snapshots.",
        );
      }
      const purchasedAt = new Date().toISOString();
      const addressOverrideAudit = changedSide
        ? {
            originalSenderSnapshot: senderSnapshot,
            submittedSenderAddress: submittedSender,
            originalRecipientSnapshot: recipientSnapshot,
            submittedRecipientAddress: submittedRecipient,
            changedSide,
            reason: overrideReason,
            actor: context.audit.performedByUserId,
            timestamp: purchasedAt,
          }
        : null;
      const sender = postageAddressFromSnapshot(submittedSender);
      const recipient = postageAddressFromSnapshot(submittedRecipient);
      const labelPackage = params.package ?? postagePackageFromShippingPlan(shipment.shipping_plan_snapshot);
      const deliveryConfirmation = postageDeliveryConfirmationFromShippingPlan(shipment.shipping_plan_snapshot);
      const labelSize = postageLabelSizeFromPackage(labelPackage);
      const operationKey = `shipment:${params.shipmentId}:purchase-usps-label:${purchasedAt}`;
      await recordFulfillmentPostageLabelOperationPending(deps.db, {
        operationKey,
        operationKind: "purchase-usps-label",
        shipmentId: params.shipmentId,
        providerName: postageLabelProvider.providerName,
        providerMode: postageLabelProvider.providerMode,
        idempotencyKey: operationKey,
        request: postageLabelOperationRequest({
          shipmentId: params.shipmentId,
          orderId: shipment.order_id,
          serviceLevel: params.serviceLevel,
          deliveryConfirmation,
          labelSize,
          labelPackage,
          addressOverrideAudit: addressOverrideAudit
            ? {
                changedSide: addressOverrideAudit.changedSide,
                reason: addressOverrideAudit.reason,
                actor: addressOverrideAudit.actor,
                timestamp: addressOverrideAudit.timestamp,
              }
            : null,
          shippingPlanSnapshot: shipment.shipping_plan_snapshot,
        }),
        createdAt: purchasedAt,
      });

      let purchasedLabel;
      try {
        assertPostagePolicyCompliance(shipment.shipping_plan_snapshot, labelPackage, params.serviceLevel);
        purchasedLabel = await postageLabelProvider.purchaseUspsLabel({
          shipmentId: params.shipmentId,
          orderId: shipment.order_id,
          serviceLevel: params.serviceLevel,
          deliveryConfirmation,
          labelSize,
          sender,
          recipient,
          package: labelPackage,
        });
      } catch (error) {
        await recordFulfillmentPostageLabelOperationFailed(deps.db, {
          operationKey,
          errorMessage: error instanceof Error ? error.message : "Label purchase failed.",
        });
        await commandHandler({
          streamId: `fulfillment.shipment-${params.shipmentId}`,
          command: {
            type: "RecordShipmentLabelPurchaseFailed",
            postageProviderName: postageLabelProvider.providerName,
            postageProviderMode: postageLabelProvider.providerMode,
            errorCode: postageLabelFailureErrorCode(error),
            errorMessage: error instanceof Error ? error.message : "Label purchase failed.",
            failedAt: new Date().toISOString(),
          },
          context,
        });
        throw new FulfillmentDomainError(error instanceof Error ? error.message : "Label purchase failed.");
      }

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "AttachShipmentLabel",
          shippingMethod: "standard",
          carrierName: purchasedLabel.carrierName,
          labelReference: purchasedLabel.labelReference,
          labelDocumentUrl: purchasedLabel.labelDocumentUrl,
          trackingIdentifier: purchasedLabel.trackingIdentifier,
          postageProviderName: purchasedLabel.providerName,
          postageProviderMode: purchasedLabel.providerMode,
          postageProviderShipmentId: purchasedLabel.providerShipmentId,
          postageProviderLabelId: purchasedLabel.providerLabelId,
          postageRateId: purchasedLabel.providerRateId,
          postageServiceLevel: purchasedLabel.serviceLevel,
          postageAmountCents: purchasedLabel.postageAmountCents,
          postageCurrency: purchasedLabel.postageCurrency,
          addressOverrideAudit,
          attachedAt: purchasedLabel.purchasedAt,
        },
        context,
      });
      await recordFulfillmentPostageLabelOperationSucceeded(deps.db, {
        operationKey,
        providerShipmentId: purchasedLabel.providerShipmentId,
        providerLabelId: purchasedLabel.providerLabelId,
        trackingIdentifier: purchasedLabel.trackingIdentifier,
        completedAt: purchasedLabel.purchasedAt,
      });

      return {
        shipmentId: params.shipmentId,
        version: result.version,
        trackingIdentifier: purchasedLabel.trackingIdentifier,
      };
    },
    voidLabel: async (params, context) => {
      const shipment = await requireSellerShipment(params.shipmentId, params.sellerAccountId);
      if (
        !shipment.postage_provider_shipment_id ||
        !shipment.postage_provider_label_id ||
        !shipment.tracking_identifier
      ) {
        throw new FulfillmentDomainError("Shipment does not have a purchased label.");
      }

      const voidRequestedAt = new Date().toISOString();
      const operationKey = `shipment:${params.shipmentId}:void-label:${voidRequestedAt}`;
      await recordFulfillmentPostageLabelOperationPending(deps.db, {
        operationKey,
        operationKind: "void-label",
        shipmentId: params.shipmentId,
        providerName: postageLabelProvider.providerName,
        providerMode: postageLabelProvider.providerMode,
        idempotencyKey: operationKey,
        request: {
          providerShipmentId: shipment.postage_provider_shipment_id,
          providerLabelId: shipment.postage_provider_label_id,
          trackingIdentifier: shipment.tracking_identifier,
        },
        createdAt: voidRequestedAt,
      });

      let voidedLabel;
      try {
        voidedLabel = await postageLabelProvider.voidLabel({
          providerShipmentId: shipment.postage_provider_shipment_id,
          providerLabelId: shipment.postage_provider_label_id,
          trackingIdentifier: shipment.tracking_identifier,
        });
      } catch (error) {
        await recordFulfillmentPostageLabelOperationFailed(deps.db, {
          operationKey,
          errorMessage: error instanceof Error ? error.message : "Label void failed.",
        });
        throw error;
      }

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "VoidShipmentLabel",
          refundStatus: voidedLabel.refundStatus,
          refundReference: voidedLabel.refundReference,
          voidedAt: voidedLabel.voidedAt,
        },
        context,
      });
      await recordFulfillmentPostageLabelOperationSucceeded(deps.db, {
        operationKey,
        providerShipmentId: shipment.postage_provider_shipment_id,
        providerLabelId: shipment.postage_provider_label_id,
        trackingIdentifier: shipment.tracking_identifier,
        completedAt: voidedLabel.voidedAt,
      });

      return { shipmentId: params.shipmentId, version: result.version };
    },
    dispatchShipment: async (params, context) => {
      await requireSellerShipment(params.shipmentId, params.sellerAccountId);

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "DispatchShipment",
          dispatchedAt: new Date().toISOString(),
        },
        context,
      });

      return { shipmentId: params.shipmentId, version: result.version };
    },
    deliverShipment: async (params, context) => {
      await requireSellerShipment(params.shipmentId, params.sellerAccountId);

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "RecordShipmentDelivery",
          deliveredAt: new Date().toISOString(),
        },
        context,
      });

      return { shipmentId: params.shipmentId, version: result.version };
    },
    returnShipment: async (params, context) => {
      await requireSellerShipment(params.shipmentId, params.sellerAccountId);

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "ReturnShipment",
          reason: params.reason ?? null,
          returnedAt: new Date().toISOString(),
        },
        context,
      });

      return { shipmentId: params.shipmentId, version: result.version };
    },
    raiseShipmentException: async (params, context) => {
      await requireSellerShipment(params.shipmentId, params.sellerAccountId);

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "RaiseShipmentException",
          exceptionType: params.exceptionType as never,
          notes: params.notes ?? null,
          raisedAt: new Date().toISOString(),
        },
        context,
      });

      return { shipmentId: params.shipmentId, version: result.version };
    },
    listBuyerShipments: (params) => listBuyerShipments(deps.db, params),
    getBuyerShipment: (shipmentId, buyerAccountId) => getBuyerShipment(deps.db, shipmentId, buyerAccountId),
    listSellerShipments: (params) => listSellerShipments(deps.db, params),
    getSellerShipment: (shipmentId, sellerAccountId) => getSellerShipment(deps.db, shipmentId, sellerAccountId),
    listSellerPackingSlips: (params) => listSellerPackingSlips(deps.db, params),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "fulfillment-shipment-projection",
        handlers: buildFulfillmentShipmentProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: FULFILLMENT_TRANSACTIONAL_EMAIL_PROJECTION,
        handlers: buildFulfillmentTransactionalEmailProjectionHandlers(
          notificationOutbox,
          FULFILLMENT_TRANSACTIONAL_EMAIL_PROJECTION,
        ),
      }),
    ],
  };
}

function createUnconfiguredPostageLabelProvider(): PostageLabelProvider {
  const fail = async (): Promise<never> => {
    throw new Error("Postage label provider adapter is not configured.");
  };

  return {
    providerName: "unconfigured",
    providerMode: "test",
    purchaseUspsLabel: fail,
    voidLabel: fail,
  };
}
