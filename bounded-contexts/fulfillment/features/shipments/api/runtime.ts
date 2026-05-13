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
import type {
  PostageAddress,
  PostageLabelProvider,
  PostagePackage,
} from "@chase-sets/postage-labels";
import {
  addressSnapshotsEqual,
  changedAddressSnapshotSide,
  normalizeAddressSnapshot,
  type AddressSnapshot,
} from "@chase-sets/primitives/address-snapshot";
import { createId } from "@chase-sets/primitives/typed-ids";
import type {
  AccountId,
  OrderId,
  ShipmentId,
} from "@chase-sets/primitives/typed-ids";
import { FulfillmentDomainError } from "../domain/common";
import {
  getBuyerShipment,
  getSellerShipment,
  listSellerPackingSlips,
  listBuyerShipments,
  listSellerShipments,
} from "../read-model/queries";
import { buildFulfillmentShipmentProjectionHandlers } from "../read-model/projection";
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
  lines: readonly ReadyOrderLineSnapshot[];
}>;

export type FulfillmentShipmentServices = Readonly<{
  commandHandler: CommandHandler<
    FulfillmentShipmentCommand,
    FulfillmentShipmentState,
    FulfillmentShipmentEvent
  >;
  packShipment: (
    params: Readonly<{
      shipmentId: string;
      sellerAccountId: string;
      packageCount: number;
    }>,
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
      package: PostagePackage;
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
  cancelShipmentForCancelledOrder: (params: {
    orderId: string;
    cancelledAt: string;
    context: EventStoreContext;
  }) => Promise<{ shipmentId: ShipmentId | null }>;
  listBuyerShipments: (
    params: Parameters<typeof listBuyerShipments>[1],
  ) => ReturnType<typeof listBuyerShipments>;
  getBuyerShipment: (
    shipmentId: string,
    buyerAccountId: string,
  ) => ReturnType<typeof getBuyerShipment>;
  listSellerShipments: (
    params: Parameters<typeof listSellerShipments>[1],
  ) => ReturnType<typeof listSellerShipments>;
  getSellerShipment: (
    shipmentId: string,
    sellerAccountId: string,
  ) => ReturnType<typeof getSellerShipment>;
  listSellerPackingSlips: (
    params: Parameters<typeof listSellerPackingSlips>[1],
  ) => ReturnType<typeof listSellerPackingSlips>;
  createShipmentForReadyOrder: (params: {
    orderId: string;
    readyForFulfillmentAt: string;
    context: EventStoreContext;
  }) => Promise<{ shipmentId: ShipmentId | null }>;
  projectors: readonly Projector[];
}>;

async function findExistingShipmentIdForOrder(
  db: PgQueryable,
  orderId: string,
): Promise<string | null> {
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

async function loadReadyOrderSnapshot(
  db: PgQueryable,
  orderId: string,
): Promise<ReadyOrderSnapshot | null> {
  const orderResult = await db.query<{
    order_id: string;
    buyer_account_id: string;
    seller_account_id: string;
    shipping_option: string;
    shipping_destination_snapshot: AddressSnapshot;
    shipping_origin_snapshot: AddressSnapshot;
    status: string;
  }>(
    `SELECT
       order_id,
       buyer_account_id,
       seller_account_id,
       shipping_option,
       shipping_destination_snapshot,
       shipping_origin_snapshot,
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

export function createFulfillmentShipmentRuntime(
  deps: ShipmentRuntimeDeps,
): FulfillmentShipmentServices {
  const postageLabelProvider =
    deps.postageLabelProvider ?? createUnconfiguredPostageLabelProvider();
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

  async function requireSellerShipment(
    shipmentId: string,
    sellerAccountId: string,
  ) {
    const shipment = await getSellerShipment(deps.db, shipmentId, sellerAccountId);
    if (!shipment) {
      throw new FulfillmentDomainError("Shipment not found.");
    }
    return shipment;
  }

  return {
    commandHandler,
    createShipmentForReadyOrder: async (params) => {
      const existingShipmentId = await findExistingShipmentIdForOrder(
        deps.db,
        params.orderId,
      );
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
          lines: order.lines.map((line) => ({
            lineId: createId("spl"),
            orderLineId: line.order_line_id,
            catalogItemId: line.catalog_catalog_item_id,
            productId: line.product_id,
            itemTitle: line.item_title,
            itemSubtitle: line.item_subtitle,
            productSummary: line.product_summary,
            quantity: line.quantity,
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
      const shipment = await requireSellerShipment(
        params.shipmentId,
        params.sellerAccountId,
      );
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
      const submittedSender = params.sender
        ? addressSnapshotFromPostage(params.sender)
        : senderSnapshot;
      const submittedRecipient = params.recipient
        ? addressSnapshotFromPostage(params.recipient)
        : recipientSnapshot;
      const senderChanged = !addressSnapshotsEqual(senderSnapshot, submittedSender);
      const recipientChanged = !addressSnapshotsEqual(
        recipientSnapshot,
        submittedRecipient,
      );
      const changedSide = changedAddressSnapshotSide(
        senderChanged,
        recipientChanged,
      );
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

      let purchasedLabel;
      try {
        purchasedLabel = await postageLabelProvider.purchaseUspsLabel({
          shipmentId: params.shipmentId,
          orderId: shipment.order_id,
          serviceLevel: params.serviceLevel,
          sender,
          recipient,
          package: params.package,
        });
      } catch (error) {
        await commandHandler({
          streamId: `fulfillment.shipment-${params.shipmentId}`,
          command: {
            type: "RecordShipmentLabelPurchaseFailed",
            postageProviderName: postageLabelProvider.providerName,
            postageProviderMode: postageLabelProvider.providerMode,
            errorCode: error instanceof Error ? error.name : "postage_error",
            errorMessage: error instanceof Error ? error.message : "Label purchase failed.",
            failedAt: new Date().toISOString(),
          },
          context,
        });
        throw new FulfillmentDomainError(
          error instanceof Error ? error.message : "Label purchase failed.",
        );
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

      return {
        shipmentId: params.shipmentId,
        version: result.version,
        trackingIdentifier: purchasedLabel.trackingIdentifier,
      };
    },
    voidLabel: async (params, context) => {
      const shipment = await requireSellerShipment(
        params.shipmentId,
        params.sellerAccountId,
      );
      if (
        !shipment.postage_provider_shipment_id ||
        !shipment.postage_provider_label_id ||
        !shipment.tracking_identifier
      ) {
        throw new FulfillmentDomainError("Shipment does not have a purchased label.");
      }

      const voidedLabel = await postageLabelProvider.voidLabel({
        providerShipmentId: shipment.postage_provider_shipment_id,
        providerLabelId: shipment.postage_provider_label_id,
        trackingIdentifier: shipment.tracking_identifier,
      });

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
    getBuyerShipment: (shipmentId, buyerAccountId) =>
      getBuyerShipment(deps.db, shipmentId, buyerAccountId),
    listSellerShipments: (params) => listSellerShipments(deps.db, params),
    getSellerShipment: (shipmentId, sellerAccountId) =>
      getSellerShipment(deps.db, shipmentId, sellerAccountId),
    listSellerPackingSlips: (params) =>
      listSellerPackingSlips(deps.db, params),
    projectors: [
      createProjector({
        projectorName: "fulfillment-shipment-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildFulfillmentShipmentProjectionHandlers(deps.db),
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
