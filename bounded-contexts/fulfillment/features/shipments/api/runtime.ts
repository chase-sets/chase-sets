import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createHash, randomUUID } from "node:crypto";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createNoopNotificationOutbox, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import {
  createNoopPostageProviderWebhookGateway,
  PostageLabelProviderError,
  type PostageAddress,
  type PostageLabelProvider,
  type PostagePackage,
  type PostageProviderWebhookEvent,
  type PostageProviderWebhookGateway,
  type PostageProviderWebhookInput,
  type PurchasedPostageLabel,
} from "@chase-sets/postage-labels";
import {
  addressSnapshotsEqual,
  changedAddressSnapshotSide,
  normalizeAddressSnapshot,
  type AddressSnapshot,
} from "@chase-sets/primitives/address-snapshot";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { ProductKey } from "@chase-sets/primitives/catalog-identity";
import type { AccountId, CatalogItemId, OrderId, ShipmentId } from "@chase-sets/primitives/typed-ids";
import type { PackagePlan } from "@chase-sets/product-measures";
import {
  FulfillmentDomainError,
  type ShipmentExceptionType,
  type ShipmentLineId,
  type ShippingMethod,
} from "../domain/common";
import {
  getBuyerShipment,
  getSellerShipment,
  getShipmentForPostageRecovery,
  listStaleFulfillmentPostageLabelOperations,
  listStaleFulfillmentPostageLabelVoidOperations,
  listSellerPackingSlips,
  listBuyerShipments,
  listSellerShipments,
  recordFulfillmentPostageLabelOperationFailed,
  recordFulfillmentPostageLabelOperationPending,
  recordFulfillmentPostageLabelOperationProviderSucceeded,
  recordFulfillmentPostageLabelOperationSucceeded,
  type FulfillmentPostageLabelOperationRecord,
  type FulfillmentShipmentDetailRow,
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
import {
  assertCompleteHistoryTenant,
  executeShipmentMutationAttempt,
  readShipmentMutationAttempt,
  shipmentMutationKeyDigest,
  shipmentMutationRequestHash,
  type ShipmentMutationAttemptReceipt,
  ShipmentHistoryPoisonedError,
} from "../domain/mutation-attempt";
import {
  claimPostageOperationForFinalization,
  claimReservedPostageOperation,
  expireInvokingPostageOperation,
  findPostageOperationByDigest,
  findPostageOperationByLocator,
  listStalePostageOperationLocators,
  postageOperationRecoveryStatus,
  quarantineShipmentTenantBinding,
  reservePostageOperation,
  transitionPostageOperation,
  type PostageOperationAuthority,
  type PostageOperationLocator,
} from "../read-model/postage-operation-authority";

type ShipmentRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  postageLabelProvider?: PostageLabelProvider;
  postageWebhookGateway?: PostageProviderWebhookGateway;
  notificationOutbox?: NotificationOutbox;
  /**
   * Optional sink for tracking webhooks that do not match any outbound shipment.
   * Reverse-shipment labels ride the same postage provider, so their carrier scans
   * arrive on the shared webhook endpoint; unmatched-outbound tracking events are
   * offered here so the ReturnShipment slice can ingest them. Kept as a narrow
   * callback so this slice takes no dependency on the return-shipments module.
   */
  returnTrackingFallback?: (
    event: PostageProviderWebhookEvent,
    context: EventStoreContext,
  ) => Promise<{ returnShipmentId: string | null; processingResult: string }>;
}>;

type ShipmentForPostageProviderEvent = Readonly<{
  shipment_id: string;
  tenant_id: string;
  seller_account_id: string;
  status: string;
  label_status: string;
  label_refund_status: string | null;
  label_voided_at: string | null;
  tracking_identifier: string | null;
  postage_provider_shipment_id: string | null;
  matched_void_operation_key: string | null;
  matched_void_operation_status: string | null;
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

type AttachShipmentLabelCommand = Extract<FulfillmentShipmentCommand, { type: "AttachShipmentLabel" }>;
type ShipmentLabelAddressOverrideAudit = NonNullable<AttachShipmentLabelCommand["addressOverrideAudit"]>;

const FULFILLMENT_SYSTEM_CONTEXT: EventStoreContext = {
  tenantId: "tnt_fulfillment" as never,
  audit: {
    performedByUserId: "usr_fulfillment_system" as never,
    forAccountId: "acc_fulfillment_system" as never,
  },
};

export type FulfillmentShipmentServices = Readonly<{
  commandHandler: CommandHandler<FulfillmentShipmentCommand, FulfillmentShipmentState, FulfillmentShipmentEvent>;
  packShipment: (
    params: Readonly<{
      shipmentId: string;
      sellerAccountId: string;
      packageCount: number;
      mutationAttemptId?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  startPackingShipment: (
    params: Readonly<{ shipmentId: string; sellerAccountId: string; mutationAttemptId?: string }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  confirmPackingLine: (
    params: Readonly<{ shipmentId: string; sellerAccountId: string; lineId: string; mutationAttemptId?: string }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  unconfirmPackingLine: (
    params: Readonly<{ shipmentId: string; sellerAccountId: string; lineId: string; mutationAttemptId?: string }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  setPackingLineQuantity: (
    params: Readonly<{
      shipmentId: string;
      sellerAccountId: string;
      lineId: string;
      confirmedQuantity: number;
      mutationAttemptId?: string;
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
      mutationAttemptId?: string;
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
      mutationAttemptId?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number; trackingIdentifier: string }>;
  reconcileStalePostageLabelPurchases: (
    params?: Readonly<{ staleBefore?: string; staleAfterMs?: number; limit?: number }>,
    context?: EventStoreContext,
  ) => Promise<{ checked: number; attached: number; voided: number; failed: number }>;
  reconcileStalePostageLabelVoids: (
    params?: Readonly<{ staleBefore?: string; staleAfterMs?: number; limit?: number }>,
    context?: EventStoreContext,
  ) => Promise<{ checked: number; failed: number }>;
  listStalePostageOperationLocators: (
    params: Readonly<{
      staleBefore: string;
      afterUpdatedAt?: string | null;
      afterOperationId?: string | null;
      limit?: number;
    }>,
  ) => Promise<readonly PostageOperationLocator[]>;
  reconcilePostageOperationLocator: (
    locator: Pick<PostageOperationLocator, "operationId" | "tenantId" | "shipmentId">,
  ) => Promise<{ outcome: "effect-applied" | "ambiguous" | "pending" | "quarantined" | "missing" }>;
  voidLabel: (
    params: Readonly<{ shipmentId: string; sellerAccountId: string; mutationAttemptId?: string }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  dispatchShipment: (
    params: Readonly<{ shipmentId: string; sellerAccountId: string; mutationAttemptId?: string }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  deliverShipment: (
    params: Readonly<{ shipmentId: string; sellerAccountId: string; mutationAttemptId?: string }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  returnShipment: (
    params: Readonly<{
      shipmentId: string;
      sellerAccountId: string;
      reason?: string | null;
      mutationAttemptId?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ shipmentId: string; version: number }>;
  raiseShipmentException: (
    params: Readonly<{
      shipmentId: string;
      sellerAccountId: string;
      exceptionType: string;
      notes?: string | null;
      mutationAttemptId?: string;
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
    sourceIdentity?: Readonly<{ eventId: string; streamId: string; streamVersion: number; eventType: string }>;
  }) => Promise<{ shipmentId: ShipmentId | null }>;
  listBuyerShipments: (params: Parameters<typeof listBuyerShipments>[1]) => ReturnType<typeof listBuyerShipments>;
  getBuyerShipment: (shipmentId: string, buyerAccountId: string) => ReturnType<typeof getBuyerShipment>;
  listSellerShipments: (params: Parameters<typeof listSellerShipments>[1]) => ReturnType<typeof listSellerShipments>;
  getSellerShipment: (shipmentId: string, sellerAccountId: string) => ReturnType<typeof getSellerShipment>;
  recoverShipmentMutation: (
    params: Readonly<{ shipmentId: string; sellerAccountId: string; mutationAttemptId: string }>,
    context: EventStoreContext,
  ) => Promise<
    Readonly<{
      schemaVersion: 1;
      shipmentId: string;
      shipmentVersion: number;
      shipmentStatus: string;
      status: string;
      receiptKind: "shipment-attempt" | "postage-operation" | "absent";
      commandKind: string | null;
      result: ShipmentMutationAttemptReceipt["response"] | null;
      actions: readonly string[];
    }>
  >;
  listSellerPackingSlips: (
    params: Parameters<typeof listSellerPackingSlips>[1],
  ) => ReturnType<typeof listSellerPackingSlips>;
  createShipmentForReadyOrder: (params: {
    orderId: string;
    readyForFulfillmentAt: string;
    context: EventStoreContext;
    sourceIdentity?: Readonly<{ eventId: string; streamId: string; streamVersion: number; eventType: string }>;
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

function deterministicShipmentId(sourceIdentity: string, orderId: string): ShipmentId {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = createHash("sha256").update(`shipment-source/v1\n${sourceIdentity}\n${orderId}`).digest();
  let value = BigInt(`0x${bytes.subarray(0, 17).toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = alphabet[Number(value & 31n)]! + encoded;
    value >>= 5n;
  }
  return `shp_${encoded}` as ShipmentId;
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

async function hasActivePaymentFraudReviewHold(db: PgQueryable, orderId: string): Promise<boolean> {
  const result = await db.query<{ provider_review_id: string }>(
    `SELECT provider_review_id
     FROM fulfillment_payment_fraud_review_holds
     WHERE status = 'opened'
       AND order_ids ? $1
     LIMIT 1`,
    [orderId],
  );

  return result.rows.length > 0;
}

async function findShipmentForPostageProviderEvent(
  db: PgQueryable,
  event: PostageProviderWebhookEvent,
): Promise<Readonly<{ shipment: ShipmentForPostageProviderEvent | null; ambiguous: boolean }>> {
  const trackingIdentifier = event.trackingIdentifier?.trim() || null;
  const providerShipmentId = event.providerShipmentId?.trim() || null;
  const matchHistoricalVoidOperations = event.eventKind === "refund-status";
  if (!trackingIdentifier && !providerShipmentId) {
    return { shipment: null, ambiguous: false };
  }

  const result = await db.query<ShipmentForPostageProviderEvent>(
    `WITH candidate_shipments AS (
       SELECT
         page.shipment_id,
         authority.tenant_id,
         page.seller_account_id,
         page.status,
         page.label_status,
         page.label_refund_status,
         page.label_voided_at,
         page.tracking_identifier,
         page.postage_provider_shipment_id,
         NULL::text AS matched_void_operation_key,
         NULL::text AS matched_void_operation_status,
         0 AS match_priority,
         page.updated_at
       FROM fulfillment_shipment_pages AS page
       JOIN fulfillment_shipment_tenant_resolutions AS authority
         ON authority.shipment_id = page.shipment_id
        AND authority.status = 'resolved'
        AND authority.tenant_id = page.tenant_id
        AND authority.seller_account_id = page.seller_account_id
       WHERE ($1::text IS NOT NULL AND page.tracking_identifier = $1)
          OR ($2::text IS NOT NULL AND page.postage_provider_shipment_id = $2)
       UNION ALL
       SELECT
         page.shipment_id,
         authority.tenant_id,
         page.seller_account_id,
         page.status,
         page.label_status,
         page.label_refund_status,
         page.label_voided_at,
         page.tracking_identifier,
         page.postage_provider_shipment_id,
         operation.operation_key AS matched_void_operation_key,
         operation.status AS matched_void_operation_status,
         1 AS match_priority,
         operation.updated_at
       FROM fulfillment_postage_label_operations AS operation
       JOIN fulfillment_shipment_pages AS page
         ON page.shipment_id = operation.shipment_id
       JOIN fulfillment_shipment_tenant_resolutions AS authority
         ON authority.shipment_id = page.shipment_id
        AND authority.status = 'resolved'
        AND authority.tenant_id = operation.tenant_id
        AND authority.seller_account_id = operation.seller_account_id
       WHERE $3::boolean
         AND operation.operation_kind = 'void-label'
         AND (
           ($1::text IS NOT NULL AND (
             operation.tracking_identifier = $1
             OR operation.request_json #>> '{trackingIdentifier}' = $1
           ))
           OR ($2::text IS NOT NULL AND (
             operation.provider_shipment_id = $2
             OR operation.request_json #>> '{providerShipmentId}' = $2
           ))
         )
     )
     SELECT DISTINCT ON (shipment_id)
       shipment_id,
       tenant_id,
       seller_account_id,
       status,
       label_status,
       label_refund_status,
       label_voided_at,
       tracking_identifier,
       postage_provider_shipment_id,
       matched_void_operation_key,
       matched_void_operation_status
     FROM candidate_shipments
     ORDER BY shipment_id, match_priority ASC, updated_at DESC
     LIMIT 2`,
    [trackingIdentifier, providerShipmentId, matchHistoricalVoidOperations],
  );

  return { shipment: result.rows.length === 1 ? result.rows[0]! : null, ambiguous: result.rows.length > 1 };
}

async function reservePostageProviderEvent(db: PgQueryable, event: PostageProviderWebhookEvent) {
  const payloadHash = shipmentMutationRequestHash({
    providerName: event.providerName,
    providerMode: event.providerMode,
    eventKind: event.eventKind,
    providerObjectReference: event.providerObjectReference,
    trackingIdentifier: event.trackingIdentifier ?? null,
    status: event.status ?? null,
    statusDetail: event.statusDetail ?? null,
    occurredAt: event.occurredAt,
    payload: event.payload ?? {},
  });
  const result = await db.query<{
    provider_event_id: string;
    payload_hash: string | null;
    handoff_state: string;
    processing_result: string;
    inserted: boolean;
  }>(
    `WITH inserted AS (
       INSERT INTO fulfillment_postage_provider_events (
         provider_event_id, provider_name, provider_mode, event_kind, provider_object_reference,
         shipment_id, tracking_identifier, status, status_detail, occurred_at, received_at,
         processing_result, payload_json, payload_hash, handoff_state, receipt_version
       ) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,'reserved',$11::jsonb,$12,'reserved',1)
       ON CONFLICT (provider_event_id) DO NOTHING
       RETURNING provider_event_id, payload_hash, handoff_state, processing_result, true AS inserted
     )
     SELECT * FROM inserted
     UNION ALL
     SELECT provider_event_id, payload_hash, handoff_state, processing_result, false AS inserted
     FROM fulfillment_postage_provider_events
     WHERE provider_event_id = $1 AND NOT EXISTS (SELECT 1 FROM inserted)`,
    [
      event.providerEventId,
      event.providerName,
      event.providerMode,
      event.eventKind,
      event.providerObjectReference,
      event.trackingIdentifier ?? null,
      event.status ?? null,
      event.statusDetail ?? null,
      event.occurredAt,
      event.receivedAt ?? new Date().toISOString(),
      JSON.stringify(event.payload ?? {}),
      payloadHash,
    ],
  );
  const receipt = result.rows[0];
  if (!receipt) throw new Error("Postage provider event reservation failed.");
  return { ...receipt, payloadHash, hashMatches: receipt.payload_hash === payloadHash };
}

async function recordProcessedPostageProviderEvent(
  db: PgQueryable,
  event: PostageProviderWebhookEvent,
  shipment: ShipmentForPostageProviderEvent | null,
  processingResult: string,
  claimToken?: string,
) {
  await db.query(
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
       payload_json,
       payload_hash,
       handoff_state,
       receipt_version
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz, $12, $13::jsonb, $14,
       CASE WHEN $12 = 'unmatched' THEN 'unmatched' ELSE 'completed' END, 1)
     ON CONFLICT (provider_event_id) DO UPDATE
     SET shipment_id = EXCLUDED.shipment_id,
         processing_result = EXCLUDED.processing_result,
         handoff_state = CASE WHEN EXCLUDED.processing_result = 'unmatched' THEN 'unmatched' ELSE 'completed' END,
         receipt_version = fulfillment_postage_provider_events.receipt_version + 1
     WHERE fulfillment_postage_provider_events.payload_hash = EXCLUDED.payload_hash
       AND ($15::text IS NULL OR fulfillment_postage_provider_events.claim_token = $15)`,
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
      processingResult,
      JSON.stringify(event.payload ?? {}),
      shipmentMutationRequestHash({
        providerName: event.providerName,
        providerMode: event.providerMode,
        eventKind: event.eventKind,
        providerObjectReference: event.providerObjectReference,
        trackingIdentifier: event.trackingIdentifier ?? null,
        status: event.status ?? null,
        statusDetail: event.statusDetail ?? null,
        occurredAt: event.occurredAt,
        payload: event.payload ?? {},
      }),
      claimToken ?? null,
    ],
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

function normalizeProviderRefundStatus(status: string | null | undefined) {
  const normalized = (status ?? "").trim().toLowerCase().replaceAll("_", "-");
  if (normalized === "refunded" || normalized === "refund-successful" || normalized === "successful") {
    return "refunded" as const;
  }
  if (normalized === "rejected" || normalized === "refund-rejected" || normalized === "failed") {
    return "rejected" as const;
  }
  return null;
}

async function applyPostageProviderRefundEvent(
  db: PgQueryable,
  commandHandler: CommandHandler<FulfillmentShipmentCommand, FulfillmentShipmentState, FulfillmentShipmentEvent>,
  event: PostageProviderWebhookEvent,
  shipment: ShipmentForPostageProviderEvent,
  context: EventStoreContext,
) {
  const refundStatus = normalizeProviderRefundStatus(event.status);
  if (!refundStatus) {
    return "recorded";
  }

  if (shipment.label_status === "voided" || shipment.label_status === "void-rejected") {
    return "terminal-refund-status-ignored";
  }

  if (shipment.label_status !== "void-requested") {
    if (refundStatus === "rejected" && shipment.matched_void_operation_key) {
      await recordFulfillmentPostageLabelOperationFailed(db, {
        operationKey: shipment.matched_void_operation_key,
        errorMessage: "Postage label refund was rejected after a replacement label was purchased.",
        completedAt: event.occurredAt,
      });
      return "refund-rejected-after-rebuy";
    }
    if (refundStatus === "refunded" && shipment.matched_void_operation_key) {
      await recordFulfillmentPostageLabelOperationSucceeded(db, {
        operationKey: shipment.matched_void_operation_key,
        completedAt: event.occurredAt,
      });
      return "refund-resolved-after-rebuy";
    }
    return "recorded";
  }

  const result = await commandHandler({
    streamId: `fulfillment.shipment-${shipment.shipment_id}`,
    command: {
      type: "RecordShipmentLabelRefundStatus",
      refundStatus,
      refundReference: event.providerObjectReference,
      resolvedAt: event.occurredAt,
    },
    context,
  });

  if (result.newEvents.length === 0) {
    return "terminal-refund-status-ignored";
  }

  if (shipment.matched_void_operation_key) {
    if (refundStatus === "refunded") {
      await recordFulfillmentPostageLabelOperationSucceeded(db, {
        operationKey: shipment.matched_void_operation_key,
        completedAt: event.occurredAt,
      });
    } else {
      await recordFulfillmentPostageLabelOperationFailed(db, {
        operationKey: shipment.matched_void_operation_key,
        errorMessage: "Postage label refund was rejected by the provider.",
        completedAt: event.occurredAt,
      });
    }
  }

  return refundStatus === "refunded" ? "refund-refunded" : "refund-rejected";
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

function postageInsuranceAmountFromShippingPlan(plan: PackagePlan | null | undefined) {
  const snapshot = plan?.postagePolicySnapshot;
  return snapshot?.insuranceRequired ? (snapshot.insuredValueAmount ?? null) : null;
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
  if (!snapshot) {
    return;
  }

  if (
    snapshot.parcelRequired &&
    (pkg.mailpieceClass === "letter" || pkg.mailpieceClass === "flat" || isLetterMailServiceLevel(serviceLevel))
  ) {
    throw new FulfillmentDomainError(
      "Parcel postage is required by the committed postage policy snapshot for this shipment.",
    );
  }

  if (snapshot.insuranceRequired && !snapshot.insuredValueAmount) {
    throw new FulfillmentDomainError(
      "Carrier insurance is required by the committed postage policy snapshot for this shipment.",
    );
  }
}

function postageLabelOperationRequest(
  input: Readonly<{
    shipmentId: string;
    orderId: string;
    serviceLevel: string;
    deliveryConfirmation: "signature" | null;
    insuranceAmount: string | null;
    labelPackage: PostagePackage;
    labelSize: "7x3" | null;
    sender?: PostageAddress;
    recipient?: PostageAddress;
    addressOverrideAudit: {
      changedSide: string;
      reason: string;
      actor?: string;
      timestamp?: string;
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
    insuranceAmount: input.insuranceAmount,
    labelSize: input.labelSize,
    ...(input.sender ? { sender: input.sender } : {}),
    ...(input.recipient ? { recipient: input.recipient } : {}),
    package: input.labelPackage,
    addressOverride: input.addressOverrideAudit
      ? {
          changedSide: input.addressOverrideAudit.changedSide,
          reason: input.addressOverrideAudit.reason,
          ...(input.addressOverrideAudit.actor ? { actor: input.addressOverrideAudit.actor } : {}),
          ...(input.addressOverrideAudit.timestamp ? { timestamp: input.addressOverrideAudit.timestamp } : {}),
        }
      : null,
    postagePolicySnapshot: policySnapshot
      ? {
          policyVersion: policySnapshot.policyVersion,
          parcelRequired: policySnapshot.parcelRequired,
          parcelReasons: policySnapshot.parcelReasons,
          signatureRequired: policySnapshot.signatureRequired,
          signatureReasons: policySnapshot.signatureReasons,
          insuranceRequired: policySnapshot.insuranceRequired,
          insuranceReasons: policySnapshot.insuranceReasons,
          insuredValueAmount: policySnapshot.insuredValueAmount,
          shippingEvidenceTier: policySnapshot.shippingEvidenceTier,
        }
      : null,
  };
}

export function createFulfillmentShipmentRuntime(deps: ShipmentRuntimeDeps): FulfillmentShipmentServices {
  const postageLabelProvider = deps.postageLabelProvider ?? createUnconfiguredPostageLabelProvider();
  const postageWebhookGateway = deps.postageWebhookGateway ?? createNoopPostageProviderWebhookGateway();
  const notificationOutbox = deps.notificationOutbox ?? createNoopNotificationOutbox();
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<FulfillmentShipmentEvent>(),
    initialState: () => initialFulfillmentShipmentState,
    evolve: evolveFulfillmentShipment,
    decide: decideFulfillmentShipment,
  });

  async function requireSellerShipment(shipmentId: string, sellerAccountId: string, context?: EventStoreContext) {
    if (context) {
      const loaded = await repository.load(`fulfillment.shipment-${shipmentId}`);
      assertCompleteHistoryTenant(loaded.storedEvents, String(context.tenantId));
      if (String(loaded.state.sellerAccountId) !== sellerAccountId) {
        throw new FulfillmentDomainError("Shipment not found.");
      }
    }
    const shipment = await getSellerShipment(deps.db, shipmentId, sellerAccountId);
    if (!shipment) {
      throw new FulfillmentDomainError("Shipment not found.");
    }
    return shipment;
  }

  async function executeAttempt(
    params: Readonly<{
      shipmentId: string;
      sellerAccountId: string;
      mutationAttemptId: string;
      commandKind: string;
      target?: string | null;
      request?: Readonly<Record<string, unknown>>;
      command: () => FulfillmentShipmentCommand;
      successStatus: string;
    }>,
    context: EventStoreContext,
  ) {
    const receipt = await executeShipmentMutationAttempt({
      eventStore: deps.eventStore,
      loadShipment: repository.load,
      context,
      mutationAttemptId: params.mutationAttemptId,
      shipmentId: params.shipmentId,
      sellerAccountId: params.sellerAccountId,
      commandKind: params.commandKind,
      target: params.target,
      request: params.request ?? {},
      createCommand: params.command,
      successStatus: params.successStatus,
    });
    if (receipt.resultClass === "failed-safe") {
      throw new FulfillmentDomainError(`Shipment mutation was refused safely (${receipt.reason}).`);
    }
    return { shipmentId: params.shipmentId, version: receipt.shipmentVersion };
  }

  function buildPurchaseUspsLabelOperationKey(shipment: FulfillmentShipmentDetailRow) {
    const attemptScope = shipment.label_voided_at ? `after-void:${shipment.label_voided_at}` : "initial";
    return `shipment:${shipment.shipment_id}:purchase-usps-label:${attemptScope}`;
  }

  async function getShipmentVersion(shipmentId: string) {
    const loaded = await repository.load(`fulfillment.shipment-${shipmentId}`);
    return loaded.version;
  }

  function operationHasProviderLabel(operation: FulfillmentPostageLabelOperationRecord) {
    return Boolean(operation.provider_shipment_id && operation.provider_label_id && operation.tracking_identifier);
  }

  async function recoverPurchasedLabelForOperation(operation: FulfillmentPostageLabelOperationRecord) {
    if (!postageLabelProvider.recoverPurchasedUspsLabel) {
      return null;
    }
    const recovered = await postageLabelProvider.recoverPurchasedUspsLabel({
      idempotencyKey: operation.idempotency_key,
    });
    if (!recovered) {
      return null;
    }
    await recordFulfillmentPostageLabelOperationProviderSucceeded(deps.db, {
      operationKey: operation.operation_key,
      providerShipmentId: recovered.providerShipmentId,
      providerLabelId: recovered.providerLabelId,
      trackingIdentifier: recovered.trackingIdentifier,
      updatedAt: recovered.purchasedAt,
    });
    return recovered;
  }

  async function recordOrphanedProviderLabelVoided(
    operation: FulfillmentPostageLabelOperationRecord,
    label: PurchasedPostageLabel,
  ) {
    await postageLabelProvider.voidLabel({
      providerShipmentId: label.providerShipmentId,
      providerLabelId: label.providerLabelId,
      trackingIdentifier: label.trackingIdentifier,
    });
    await recordFulfillmentPostageLabelOperationFailed(deps.db, {
      operationKey: operation.operation_key,
      errorMessage: "Recovered provider label was voided because the shipment already has a different label.",
    });
  }

  async function attachPurchasedLabelForOperation(
    operation: FulfillmentPostageLabelOperationRecord,
    label: PurchasedPostageLabel,
    addressOverrideAudit: ShipmentLabelAddressOverrideAudit | null,
    context: EventStoreContext,
  ) {
    const loaded = await repository.load(`fulfillment.shipment-${operation.shipment_id}`);
    if (
      loaded.state.postageProviderLabelId === label.providerLabelId ||
      loaded.state.trackingIdentifier === label.trackingIdentifier
    ) {
      await recordFulfillmentPostageLabelOperationSucceeded(deps.db, {
        operationKey: operation.operation_key,
        providerShipmentId: label.providerShipmentId,
        providerLabelId: label.providerLabelId,
        trackingIdentifier: label.trackingIdentifier,
        completedAt: label.purchasedAt,
      });
      return {
        shipmentId: operation.shipment_id,
        version: loaded.version,
        trackingIdentifier: label.trackingIdentifier,
      };
    }

    if (loaded.state.status !== "awaiting-label") {
      throw new FulfillmentDomainError("Shipment is no longer awaiting a label.");
    }

    const result = await commandHandler({
      streamId: `fulfillment.shipment-${operation.shipment_id}`,
      command: {
        type: "AttachShipmentLabel",
        shippingMethod: "standard",
        carrierName: label.carrierName,
        labelReference: label.labelReference,
        labelDocumentUrl: label.labelDocumentUrl,
        trackingIdentifier: label.trackingIdentifier,
        postageProviderName: label.providerName,
        postageProviderMode: label.providerMode,
        postageProviderShipmentId: label.providerShipmentId,
        postageProviderLabelId: label.providerLabelId,
        postageRateId: label.providerRateId,
        postageServiceLevel: label.serviceLevel,
        postageAmountCents: label.postageAmountCents,
        postageCurrency: label.postageCurrency,
        addressOverrideAudit,
        attachedAt: label.purchasedAt,
      },
      context,
    });
    await recordFulfillmentPostageLabelOperationSucceeded(deps.db, {
      operationKey: operation.operation_key,
      providerShipmentId: label.providerShipmentId,
      providerLabelId: label.providerLabelId,
      trackingIdentifier: label.trackingIdentifier,
      completedAt: label.purchasedAt,
    });

    return {
      shipmentId: operation.shipment_id,
      version: result.version,
      trackingIdentifier: label.trackingIdentifier,
    };
  }

  function systemContextForOperation(
    operation: Pick<PostageOperationAuthority, "tenant_id" | "seller_account_id">,
  ): EventStoreContext {
    return {
      tenantId: operation.tenant_id as never,
      audit: {
        performedByUserId: "usr_fulfillment_system" as never,
        forAccountId: operation.seller_account_id as never,
      },
    };
  }

  function postageOperationRequestRecord(operation: PostageOperationAuthority) {
    if (
      !operation.request_json ||
      typeof operation.request_json !== "object" ||
      Array.isArray(operation.request_json)
    ) {
      throw new FulfillmentDomainError("Postage operation request is invalid.");
    }
    return operation.request_json as Record<string, unknown>;
  }

  async function finalizeAuthoritativePostageOperation(
    operation: PostageOperationAuthority,
    claim: NonNullable<Awaited<ReturnType<typeof claimPostageOperationForFinalization>>>,
  ) {
    const context = systemContextForOperation(operation);
    const loaded = await repository.load(`fulfillment.shipment-${operation.shipment_id}`);
    assertCompleteHistoryTenant(loaded.storedEvents, operation.tenant_id);
    if (String(loaded.state.sellerAccountId) !== operation.seller_account_id) {
      throw new ShipmentHistoryPoisonedError("shipment-seller-mismatch");
    }
    const providerResult = operation.provider_result_json;

    if (operation.operation_kind === "purchase-usps-label") {
      if (!providerResult || typeof providerResult !== "object" || Array.isArray(providerResult)) {
        throw new ShipmentHistoryPoisonedError("postage-provider-result-invalid");
      }
      const label = providerResult as PurchasedPostageLabel;
      if (
        typeof label.providerLabelId !== "string" ||
        typeof label.providerShipmentId !== "string" ||
        typeof label.trackingIdentifier !== "string" ||
        typeof label.purchasedAt !== "string"
      ) {
        throw new ShipmentHistoryPoisonedError("postage-provider-result-invalid");
      }
      if (
        loaded.state.postageProviderLabelId !== label.providerLabelId &&
        loaded.state.trackingIdentifier !== label.trackingIdentifier
      ) {
        const request = postageOperationRequestRecord(operation);
        const addressOverride = request.addressOverride;
        const addressOverrideAudit =
          addressOverride && typeof addressOverride === "object" && !Array.isArray(addressOverride)
            ? (addressOverride as ShipmentLabelAddressOverrideAudit)
            : null;
        await commandHandler({
          streamId: `fulfillment.shipment-${operation.shipment_id}`,
          command: {
            type: "AttachShipmentLabel",
            shippingMethod: "standard",
            carrierName: label.carrierName,
            labelReference: label.labelReference,
            labelDocumentUrl: label.labelDocumentUrl,
            trackingIdentifier: label.trackingIdentifier,
            postageProviderName: label.providerName,
            postageProviderMode: label.providerMode,
            postageProviderShipmentId: label.providerShipmentId,
            postageProviderLabelId: label.providerLabelId,
            postageRateId: label.providerRateId,
            postageServiceLevel: label.serviceLevel,
            postageAmountCents: label.postageAmountCents,
            postageCurrency: label.postageCurrency,
            addressOverrideAudit,
            attachedAt: label.purchasedAt,
          },
          context,
          expectedVersion: loaded.version,
        });
      }
      const completed = await transitionPostageOperation(deps.db, {
        claim,
        from: "provider-succeeded",
        to: "effect-applied",
        completedAt: label.purchasedAt,
      });
      return Boolean(completed);
    }

    if (operation.operation_kind === "void-label") {
      if (!providerResult || typeof providerResult !== "object" || Array.isArray(providerResult)) {
        throw new ShipmentHistoryPoisonedError("postage-provider-result-invalid");
      }
      const result = providerResult as Awaited<ReturnType<PostageLabelProvider["voidLabel"]>>;
      const refundStatus = normalizeProviderRefundStatus(result.refundStatus);
      if (!refundStatus && result.refundStatus !== "submitted") {
        throw new ShipmentHistoryPoisonedError("postage-provider-result-invalid");
      }
      if (loaded.state.labelStatus !== "voided" && loaded.state.labelStatus !== "void-rejected") {
        await commandHandler({
          streamId: `fulfillment.shipment-${operation.shipment_id}`,
          command: {
            type: "VoidShipmentLabel",
            refundStatus: result.refundStatus,
            refundReference: result.refundReference,
            voidedAt: result.voidedAt,
          },
          context,
          expectedVersion: loaded.version,
        });
      }
      const completed = await transitionPostageOperation(deps.db, {
        claim,
        from: "provider-succeeded",
        to: "effect-applied",
        completedAt: result.voidedAt,
      });
      return Boolean(completed);
    }

    const completed = await transitionPostageOperation(deps.db, {
      claim,
      from: "provider-succeeded",
      to: "effect-applied",
      completedAt: new Date().toISOString(),
    });
    return Boolean(completed);
  }

  async function invokeReservedPostageOperation(operation: PostageOperationAuthority) {
    const claim = await claimReservedPostageOperation(deps.db, operation);
    if (!claim) return null;
    const invoking = await transitionPostageOperation(deps.db, {
      claim,
      from: "reserved",
      to: "invoking",
      providerInvoked: true,
    });
    if (!invoking) return null;
    const request = postageOperationRequestRecord(operation);
    try {
      const providerResult =
        operation.operation_kind === "purchase-usps-label"
          ? await postageLabelProvider.purchaseUspsLabel({
              shipmentId: operation.shipment_id,
              orderId: String(request.orderId),
              idempotencyKey: operation.provider_idempotency_key!,
              serviceLevel: String(request.serviceLevel),
              deliveryConfirmation: (request.deliveryConfirmation ?? null) as "signature" | null,
              insuranceAmount: (request.insuranceAmount ?? null) as string | null,
              labelSize: (request.labelSize ?? null) as "7x3" | null,
              sender: request.sender as PostageAddress,
              recipient: request.recipient as PostageAddress,
              package: request.package as PostagePackage,
            })
          : await postageLabelProvider.voidLabel({
              providerShipmentId: String(request.providerShipmentId),
              providerLabelId: String(request.providerLabelId),
              trackingIdentifier: String(request.trackingIdentifier),
            });
      return await transitionPostageOperation(deps.db, {
        claim,
        from: "invoking",
        to: "provider-succeeded",
        providerInvoked: true,
        providerShipmentId:
          operation.operation_kind === "purchase-usps-label"
            ? (providerResult as PurchasedPostageLabel).providerShipmentId
            : String(request.providerShipmentId),
        providerLabelId:
          operation.operation_kind === "purchase-usps-label"
            ? (providerResult as PurchasedPostageLabel).providerLabelId
            : String(request.providerLabelId),
        trackingIdentifier:
          operation.operation_kind === "purchase-usps-label"
            ? (providerResult as PurchasedPostageLabel).trackingIdentifier
            : String(request.trackingIdentifier),
        providerResult,
      });
    } catch {
      await transitionPostageOperation(deps.db, {
        claim,
        from: "invoking",
        to: "ambiguous",
        providerInvoked: true,
        closedReason: "invocation-outcome-unknown",
      });
      return null;
    }
  }

  return {
    commandHandler,
    processPostageProviderWebhook: async (input, context) => {
      const event = await postageWebhookGateway.processPostageProviderWebhook(input);
      if (!event) {
        return { status: "ignored", processingResult: "ignored" };
      }

      const reservation = await reservePostageProviderEvent(deps.db, event);
      if (!reservation.hashMatches) {
        return {
          status: "duplicate",
          providerEventId: event.providerEventId,
          eventKind: event.eventKind,
          shipmentId: null,
          processingResult: "quarantined-hash-mismatch",
        };
      }
      if (!reservation.inserted && ["completed", "quarantined"].includes(reservation.handoff_state)) {
        return {
          status: "duplicate",
          providerEventId: event.providerEventId,
          eventKind: event.eventKind,
          shipmentId: null,
          processingResult: reservation.processing_result,
        };
      }
      const claimToken = randomUUID();
      const now = new Date();
      const claim = await deps.db.query<{ provider_event_id: string }>(
        `UPDATE fulfillment_postage_provider_events
         SET claim_token = $3, claim_generation = claim_generation + 1,
             claim_expires_at = $4, receipt_version = receipt_version + 1
         WHERE provider_event_id = $1 AND payload_hash = $2
           AND handoff_state IN ('reserved', 'outbound-pending', 'return-pending', 'unmatched')
           AND (claim_token IS NULL OR claim_expires_at <= $5)
         RETURNING provider_event_id`,
        [
          event.providerEventId,
          reservation.payloadHash,
          claimToken,
          new Date(now.getTime() + 60_000).toISOString(),
          now.toISOString(),
        ],
      );
      if (!claim.rows[0]) {
        return {
          status: "duplicate",
          providerEventId: event.providerEventId,
          eventKind: event.eventKind,
          shipmentId: null,
          processingResult: "pending",
        };
      }

      const match = await findShipmentForPostageProviderEvent(deps.db, event);
      if (match.ambiguous) {
        await deps.db.query(
          `UPDATE fulfillment_postage_provider_events
           SET handoff_state = 'quarantined', processing_result = 'multiple-authority-matches',
               receipt_version = receipt_version + 1
           WHERE provider_event_id = $1 AND payload_hash = $2 AND claim_token = $3`,
          [event.providerEventId, reservation.payloadHash, claimToken],
        );
        return {
          status: "recorded",
          providerEventId: event.providerEventId,
          eventKind: event.eventKind,
          shipmentId: null,
          processingResult: "quarantined",
        };
      }
      const shipment = match.shipment;

      let processingResult = "recorded";
      let returnShipmentId: string | null = null;
      if (!shipment) {
        if (event.eventKind === "tracking-status" && deps.returnTrackingFallback) {
          const fallback = await deps.returnTrackingFallback(event, context);
          returnShipmentId = fallback.returnShipmentId;
          processingResult = `return:${fallback.processingResult}`;
        } else {
          processingResult = "unmatched";
        }
      } else {
        try {
          const loaded = await repository.load(`fulfillment.shipment-${shipment.shipment_id}`);
          assertCompleteHistoryTenant(loaded.storedEvents, shipment.tenant_id);
          if (String(loaded.state.sellerAccountId) !== shipment.seller_account_id) {
            throw new ShipmentHistoryPoisonedError("shipment-seller-mismatch");
          }
          const effectContext = systemContextForOperation({
            tenant_id: shipment.tenant_id,
            seller_account_id: shipment.seller_account_id,
          });
          if (event.eventKind === "tracking-status") {
            processingResult = await applyPostageProviderTrackingEvent(commandHandler, event, shipment, effectContext);
          } else if (event.eventKind === "refund-status") {
            processingResult = await applyPostageProviderRefundEvent(
              deps.db,
              commandHandler,
              event,
              shipment,
              effectContext,
            );
          }
        } catch (error) {
          if (!(error instanceof ShipmentHistoryPoisonedError)) throw error;
          await quarantineShipmentTenantBinding(deps.db, {
            shipmentId: shipment.shipment_id,
            tenantId: shipment.tenant_id,
            reasonCode: "postage-webhook-authority-mismatch",
          });
          await deps.db.query(
            `UPDATE fulfillment_postage_provider_events
             SET handoff_state = 'quarantined', processing_result = 'authority-mismatch',
                 receipt_version = receipt_version + 1
             WHERE provider_event_id = $1 AND payload_hash = $2 AND claim_token = $3`,
            [event.providerEventId, reservation.payloadHash, claimToken],
          );
          return {
            status: "recorded",
            providerEventId: event.providerEventId,
            eventKind: event.eventKind,
            shipmentId: null,
            processingResult: "quarantined",
          };
        }
      }

      await recordProcessedPostageProviderEvent(deps.db, event, shipment, processingResult, claimToken);

      return {
        status: "recorded",
        providerEventId: event.providerEventId,
        eventKind: event.eventKind,
        shipmentId: shipment?.shipment_id ?? returnShipmentId,
        processingResult,
      };
    },
    createShipmentForReadyOrder: async (params) => {
      const sourceShipmentId = params.sourceIdentity
        ? deterministicShipmentId(params.sourceIdentity.eventId, params.orderId)
        : null;
      if (sourceShipmentId) {
        const existing = await repository.load(`fulfillment.shipment-${sourceShipmentId}`);
        if (existing.version > 0) {
          assertCompleteHistoryTenant(existing.storedEvents, String(params.context.tenantId));
          if (String(existing.state.orderId) !== params.orderId) {
            throw new ShipmentHistoryPoisonedError("Shipment source identity was reused for a different order.");
          }
          return { shipmentId: null };
        }
      }
      const existingShipmentId = await findExistingShipmentIdForOrder(deps.db, params.orderId);
      if (existingShipmentId) {
        return { shipmentId: null };
      }

      const order = await loadReadyOrderSnapshot(deps.db, params.orderId);
      if (!order) {
        return { shipmentId: null };
      }

      const shipmentId = sourceShipmentId ?? (createId("shp") as ShipmentId);
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
            catalogItemId: line.catalog_catalog_item_id as CatalogItemId,
            productId: line.product_id as ProductKey,
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
      if (params.mutationAttemptId) {
        return executeAttempt(
          {
            ...params,
            mutationAttemptId: params.mutationAttemptId,
            commandKind: "prepare-package",
            request: { packageCount: params.packageCount },
            command: () => ({
              type: "PrepareShipmentPackage",
              packageCount: params.packageCount,
              preparedAt: new Date().toISOString(),
            }),
            successStatus: "packed",
          },
          context,
        );
      }
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
      if (params.mutationAttemptId) {
        return executeAttempt(
          {
            ...params,
            mutationAttemptId: params.mutationAttemptId,
            commandKind: "start-packing",
            command: () => ({ type: "StartShipmentPacking", startedAt: new Date().toISOString() }),
            successStatus: "packing",
          },
          context,
        );
      }
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
      if (params.mutationAttemptId) {
        return executeAttempt(
          {
            ...params,
            mutationAttemptId: params.mutationAttemptId,
            commandKind: "confirm-packing-line",
            target: params.lineId,
            command: () => ({
              type: "ConfirmShipmentPackingLine",
              lineId: params.lineId as ShipmentLineId,
              confirmedAt: new Date().toISOString(),
            }),
            successStatus: "confirmed",
          },
          context,
        );
      }
      await requireSellerShipment(params.shipmentId, params.sellerAccountId);

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "ConfirmShipmentPackingLine",
          lineId: params.lineId as ShipmentLineId,
          confirmedAt: new Date().toISOString(),
        },
        context,
      });

      return { shipmentId: params.shipmentId, version: result.version };
    },
    unconfirmPackingLine: async (params, context) => {
      if (params.mutationAttemptId) {
        return executeAttempt(
          {
            ...params,
            mutationAttemptId: params.mutationAttemptId,
            commandKind: "unconfirm-packing-line",
            target: params.lineId,
            command: () => ({
              type: "UnconfirmShipmentPackingLine",
              lineId: params.lineId as ShipmentLineId,
              unconfirmedAt: new Date().toISOString(),
            }),
            successStatus: "unconfirmed",
          },
          context,
        );
      }
      await requireSellerShipment(params.shipmentId, params.sellerAccountId);

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "UnconfirmShipmentPackingLine",
          lineId: params.lineId as ShipmentLineId,
          unconfirmedAt: new Date().toISOString(),
        },
        context,
      });

      return { shipmentId: params.shipmentId, version: result.version };
    },
    setPackingLineQuantity: async (params, context) => {
      if (params.mutationAttemptId) {
        return executeAttempt(
          {
            ...params,
            mutationAttemptId: params.mutationAttemptId,
            commandKind: "set-packing-line-quantity",
            target: params.lineId,
            request: { confirmedQuantity: params.confirmedQuantity },
            command: () => ({
              type: "SetShipmentPackingLineQuantity",
              lineId: params.lineId as ShipmentLineId,
              confirmedQuantity: params.confirmedQuantity,
              setAt: new Date().toISOString(),
            }),
            successStatus: "quantity-set",
          },
          context,
        );
      }
      await requireSellerShipment(params.shipmentId, params.sellerAccountId);

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "SetShipmentPackingLineQuantity",
          lineId: params.lineId as ShipmentLineId,
          confirmedQuantity: params.confirmedQuantity,
          setAt: new Date().toISOString(),
        },
        context,
      });

      return { shipmentId: params.shipmentId, version: result.version };
    },
    attachLabel: async (params, context) => {
      if (params.mutationAttemptId) {
        return executeAttempt(
          {
            ...params,
            mutationAttemptId: params.mutationAttemptId,
            commandKind: "attach-manual-label",
            request: {
              shippingMethod: params.shippingMethod,
              carrierName: params.carrierName,
              labelReference: params.labelReference,
              trackingIdentifier: params.trackingIdentifier,
            },
            command: () => ({
              type: "AttachShipmentLabel",
              shippingMethod: params.shippingMethod as ShippingMethod,
              carrierName: params.carrierName,
              labelReference: params.labelReference,
              trackingIdentifier: params.trackingIdentifier,
              attachedAt: new Date().toISOString(),
            }),
            successStatus: "label-attached",
          },
          context,
        );
      }
      await requireSellerShipment(params.shipmentId, params.sellerAccountId);

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "AttachShipmentLabel",
          shippingMethod: params.shippingMethod as ShippingMethod,
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
        params.mutationAttemptId ? context : undefined,
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
      const insuranceAmount = postageInsuranceAmountFromShippingPlan(shipment.shipping_plan_snapshot);
      const labelSize = postageLabelSizeFromPackage(labelPackage);
      try {
        assertPostagePolicyCompliance(shipment.shipping_plan_snapshot, labelPackage, params.serviceLevel);
      } catch (error) {
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
      const authoritativeRequest = postageLabelOperationRequest({
        shipmentId: params.shipmentId,
        orderId: shipment.order_id,
        serviceLevel: params.serviceLevel,
        deliveryConfirmation,
        insuranceAmount,
        labelSize,
        sender,
        recipient,
        labelPackage,
        addressOverrideAudit,
        shippingPlanSnapshot: shipment.shipping_plan_snapshot,
      });

      if (params.mutationAttemptId) {
        const tenantId = String(context.tenantId);
        const keyDigest = shipmentMutationKeyDigest({
          tenantId,
          sellerAccountId: params.sellerAccountId,
          key: params.mutationAttemptId,
        });
        const targetKey = `purchase:${params.shipmentId}:${shipment.label_voided_at ?? "initial"}`;
        const requestHash = shipmentMutationRequestHash({
          commandKind: "purchase-usps-label",
          tenantId,
          sellerAccountId: params.sellerAccountId,
          shipmentId: params.shipmentId,
          target: targetKey,
          request: authoritativeRequest,
        });
        const reservation = await reservePostageOperation(deps.db, {
          tenantId,
          sellerAccountId: params.sellerAccountId,
          shipmentId: params.shipmentId,
          keyDigest,
          requestHash,
          targetKey,
          operationKind: "purchase-usps-label",
          providerName: postageLabelProvider.providerName,
          providerMode: postageLabelProvider.providerMode,
          request: authoritativeRequest,
          now: purchasedAt,
        });
        let operation = reservation.operation;
        if (reservation.targetConflict) {
          throw new FulfillmentDomainError("Another immutable postage operation already owns this label target.");
        }
        if (!reservation.created) {
          if (operation.status === "effect-applied" && operation.tracking_identifier) {
            return {
              shipmentId: params.shipmentId,
              version: await getShipmentVersion(params.shipmentId),
              trackingIdentifier: operation.tracking_identifier,
            };
          }
          if (operation.status === "provider-succeeded" && operation.provider_result_json) {
            const label = operation.provider_result_json as PurchasedPostageLabel;
            const loaded = await repository.load(`fulfillment.shipment-${params.shipmentId}`);
            assertCompleteHistoryTenant(loaded.storedEvents, tenantId);
            if (loaded.state.postageProviderLabelId !== label.providerLabelId) {
              await commandHandler({
                streamId: `fulfillment.shipment-${params.shipmentId}`,
                command: {
                  type: "AttachShipmentLabel",
                  shippingMethod: "standard",
                  carrierName: label.carrierName,
                  labelReference: label.labelReference,
                  labelDocumentUrl: label.labelDocumentUrl,
                  trackingIdentifier: label.trackingIdentifier,
                  postageProviderName: label.providerName,
                  postageProviderMode: label.providerMode,
                  postageProviderShipmentId: label.providerShipmentId,
                  postageProviderLabelId: label.providerLabelId,
                  postageRateId: label.providerRateId,
                  postageServiceLevel: label.serviceLevel,
                  postageAmountCents: label.postageAmountCents,
                  postageCurrency: label.postageCurrency,
                  addressOverrideAudit,
                  attachedAt: label.purchasedAt,
                },
                context,
                expectedVersion: loaded.version,
              });
            }
            const current = await findPostageOperationByDigest(deps.db, {
              tenantId,
              sellerAccountId: params.sellerAccountId,
              keyDigest,
            });
            if (current?.claim_token && current.claim_expires_at) {
              await transitionPostageOperation(deps.db, {
                claim: current as never,
                from: "provider-succeeded",
                to: "effect-applied",
                completedAt: label.purchasedAt,
              });
            }
            return {
              shipmentId: params.shipmentId,
              version: await getShipmentVersion(params.shipmentId),
              trackingIdentifier: label.trackingIdentifier,
            };
          }
          throw new FulfillmentDomainError(
            operation.status === "ambiguous"
              ? "Postage label purchase outcome is ambiguous; reconciliation is required."
              : "Postage label purchase is pending durable reconciliation.",
          );
        }

        const claim = await claimReservedPostageOperation(deps.db, operation);
        if (!claim) throw new FulfillmentDomainError("Postage label purchase is already claimed.");
        const invoking = await transitionPostageOperation(deps.db, {
          claim,
          from: "reserved",
          to: "invoking",
          providerInvoked: true,
        });
        if (!invoking) throw new FulfillmentDomainError("Postage label purchase claim was lost before invocation.");

        let purchasedLabel: PurchasedPostageLabel;
        try {
          purchasedLabel = await postageLabelProvider.purchaseUspsLabel({
            shipmentId: params.shipmentId,
            orderId: shipment.order_id,
            idempotencyKey: operation.provider_idempotency_key!,
            serviceLevel: params.serviceLevel,
            deliveryConfirmation,
            insuranceAmount,
            labelSize,
            sender,
            recipient,
            package: labelPackage,
          });
        } catch {
          await transitionPostageOperation(deps.db, {
            claim,
            from: "invoking",
            to: "ambiguous",
            providerInvoked: true,
            closedReason: "invocation-outcome-unknown",
          });
          throw new FulfillmentDomainError("Postage label purchase outcome is ambiguous; reconciliation is required.");
        }
        operation =
          (await transitionPostageOperation(deps.db, {
            claim,
            from: "invoking",
            to: "provider-succeeded",
            providerInvoked: true,
            providerShipmentId: purchasedLabel.providerShipmentId,
            providerLabelId: purchasedLabel.providerLabelId,
            trackingIdentifier: purchasedLabel.trackingIdentifier,
            providerResult: purchasedLabel,
          })) ?? operation;

        const loaded = await repository.load(`fulfillment.shipment-${params.shipmentId}`);
        assertCompleteHistoryTenant(loaded.storedEvents, tenantId);
        if (loaded.state.postageProviderLabelId !== purchasedLabel.providerLabelId) {
          await commandHandler({
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
            expectedVersion: loaded.version,
          });
        }
        const completed = await transitionPostageOperation(deps.db, {
          claim,
          from: "provider-succeeded",
          to: "effect-applied",
          completedAt: purchasedLabel.purchasedAt,
        });
        if (!completed) throw new FulfillmentDomainError("Postage label finalization requires reconciliation.");
        return {
          shipmentId: params.shipmentId,
          version: await getShipmentVersion(params.shipmentId),
          trackingIdentifier: purchasedLabel.trackingIdentifier,
        };
      }
      const operationKey = buildPurchaseUspsLabelOperationKey(shipment);
      const operation = await recordFulfillmentPostageLabelOperationPending(deps.db, {
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
          insuranceAmount,
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

      if (!operation.operation_reserved) {
        if (operation.status === "succeeded") {
          if (!operation.tracking_identifier) {
            throw new FulfillmentDomainError("Postage label purchase already completed without tracking metadata.");
          }
          return {
            shipmentId: params.shipmentId,
            version: await getShipmentVersion(params.shipmentId),
            trackingIdentifier: operation.tracking_identifier,
          };
        }

        if (operation.status === "provider-succeeded" || operationHasProviderLabel(operation)) {
          const recoveredLabel = await recoverPurchasedLabelForOperation(operation);
          if (!recoveredLabel) {
            throw new FulfillmentDomainError(
              "Postage label purchase is pending provider reconciliation; retry after recovery completes.",
            );
          }
          return attachPurchasedLabelForOperation(operation, recoveredLabel, addressOverrideAudit, context);
        }

        throw new FulfillmentDomainError(
          "Postage label purchase is already in progress; retry after recovery completes.",
        );
      }

      let purchasedLabel;
      try {
        purchasedLabel = await postageLabelProvider.purchaseUspsLabel({
          shipmentId: params.shipmentId,
          orderId: shipment.order_id,
          idempotencyKey: operationKey,
          serviceLevel: params.serviceLevel,
          deliveryConfirmation,
          insuranceAmount,
          labelSize,
          sender,
          recipient,
          package: labelPackage,
        });
      } catch (error) {
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
      await recordFulfillmentPostageLabelOperationProviderSucceeded(deps.db, {
        operationKey,
        providerShipmentId: purchasedLabel.providerShipmentId,
        providerLabelId: purchasedLabel.providerLabelId,
        trackingIdentifier: purchasedLabel.trackingIdentifier,
        updatedAt: purchasedLabel.purchasedAt,
      });

      return attachPurchasedLabelForOperation(operation, purchasedLabel, addressOverrideAudit, context);
    },
    listStalePostageOperationLocators: async (params) => listStalePostageOperationLocators(deps.db, params),
    reconcilePostageOperationLocator: async (locator) => {
      const operation = await findPostageOperationByLocator(deps.db, locator);
      if (!operation) return { outcome: "missing" };
      try {
        const loaded = await repository.load(`fulfillment.shipment-${operation.shipment_id}`);
        assertCompleteHistoryTenant(loaded.storedEvents, operation.tenant_id);
        if (
          operation.operation_key !== locator.operationId ||
          operation.tenant_id !== locator.tenantId ||
          operation.shipment_id !== locator.shipmentId ||
          String(loaded.state.sellerAccountId) !== operation.seller_account_id
        ) {
          throw new ShipmentHistoryPoisonedError("postage-operation-authority-mismatch");
        }

        if (operation.status === "invoking") {
          const expired = await expireInvokingPostageOperation(deps.db, operation.operation_id, operation.tenant_id);
          return { outcome: expired ? "ambiguous" : "pending" };
        }
        if (operation.status === "reserved") {
          const succeeded = await invokeReservedPostageOperation(operation);
          if (!succeeded) {
            const current = await findPostageOperationByLocator(deps.db, locator);
            return { outcome: current?.status === "ambiguous" ? "ambiguous" : "pending" };
          }
          const applied = await finalizeAuthoritativePostageOperation(succeeded, succeeded as never);
          return { outcome: applied ? "effect-applied" : "pending" };
        }
        if (operation.status === "provider-succeeded") {
          const claim = await claimPostageOperationForFinalization(deps.db, operation);
          if (!claim) return { outcome: "pending" };
          const applied = await finalizeAuthoritativePostageOperation(claim, claim);
          return { outcome: applied ? "effect-applied" : "pending" };
        }
        return { outcome: operation.status === "ambiguous" ? "ambiguous" : "effect-applied" };
      } catch (error) {
        if (error instanceof ShipmentHistoryPoisonedError) {
          await quarantineShipmentTenantBinding(deps.db, {
            shipmentId: operation.shipment_id,
            tenantId: operation.tenant_id,
            reasonCode: "postage-operation-authority-mismatch",
          });
          return { outcome: "quarantined" };
        }
        throw error;
      }
    },
    reconcileStalePostageLabelPurchases: async (params = {}, context = FULFILLMENT_SYSTEM_CONTEXT) => {
      const staleBefore =
        params.staleBefore ?? new Date(Date.now() - Math.max(1, params.staleAfterMs ?? 5 * 60 * 1000)).toISOString();
      const operations = await listStaleFulfillmentPostageLabelOperations(deps.db, {
        staleBefore,
        limit: params.limit,
      });
      const result = {
        checked: operations.length,
        attached: 0,
        voided: 0,
        failed: 0,
      };

      for (const operation of operations) {
        const shipment = await getShipmentForPostageRecovery(deps.db, operation.shipment_id);
        if (!shipment) {
          await recordFulfillmentPostageLabelOperationFailed(deps.db, {
            operationKey: operation.operation_key,
            errorMessage: "Shipment no longer exists for stale postage label purchase operation.",
          });
          result.failed += 1;
          continue;
        }

        const recoveredLabel = await recoverPurchasedLabelForOperation(operation);
        if (!recoveredLabel) {
          await recordFulfillmentPostageLabelOperationFailed(deps.db, {
            operationKey: operation.operation_key,
            errorMessage: "No purchased provider label was found for the stale postage label purchase operation.",
          });
          result.failed += 1;
          continue;
        }

        if (
          shipment.postage_provider_label_id === recoveredLabel.providerLabelId ||
          shipment.tracking_identifier === recoveredLabel.trackingIdentifier
        ) {
          await recordFulfillmentPostageLabelOperationSucceeded(deps.db, {
            operationKey: operation.operation_key,
            providerShipmentId: recoveredLabel.providerShipmentId,
            providerLabelId: recoveredLabel.providerLabelId,
            trackingIdentifier: recoveredLabel.trackingIdentifier,
            completedAt: recoveredLabel.purchasedAt,
          });
          result.attached += 1;
          continue;
        }

        if (shipment.status === "awaiting-label" && shipment.package_status === "packed") {
          await attachPurchasedLabelForOperation(operation, recoveredLabel, null, context);
          result.attached += 1;
          continue;
        }

        await recordOrphanedProviderLabelVoided(operation, recoveredLabel);
        result.voided += 1;
      }

      return result;
    },
    reconcileStalePostageLabelVoids: async (params = {}) => {
      const staleBefore =
        params.staleBefore ??
        new Date(Date.now() - Math.max(1, params.staleAfterMs ?? 24 * 60 * 60 * 1000)).toISOString();
      const operations = await listStaleFulfillmentPostageLabelVoidOperations(deps.db, {
        staleBefore,
        limit: params.limit,
      });
      const result = {
        checked: operations.length,
        failed: 0,
      };

      for (const operation of operations) {
        await recordFulfillmentPostageLabelOperationFailed(deps.db, {
          operationKey: operation.operation_key,
          errorMessage: "Postage label void request is stale without a terminal provider refund status.",
        });
        result.failed += 1;
      }

      return result;
    },
    voidLabel: async (params, context) => {
      const shipment = await requireSellerShipment(
        params.shipmentId,
        params.sellerAccountId,
        params.mutationAttemptId ? context : undefined,
      );
      const loaded = await repository.load(`fulfillment.shipment-${params.shipmentId}`);
      if (
        !shipment.postage_provider_shipment_id ||
        !shipment.postage_provider_label_id ||
        !shipment.tracking_identifier
      ) {
        throw new FulfillmentDomainError("Shipment does not have a purchased label.");
      }

      const voidRequestedAt = new Date().toISOString();
      decideFulfillmentShipment(loaded.state, {
        type: "VoidShipmentLabel",
        refundStatus: "submitted",
        voidedAt: voidRequestedAt,
      });
      if (params.mutationAttemptId) {
        const tenantId = String(context.tenantId);
        assertCompleteHistoryTenant(loaded.storedEvents, tenantId);
        const keyDigest = shipmentMutationKeyDigest({
          tenantId,
          sellerAccountId: params.sellerAccountId,
          key: params.mutationAttemptId,
        });
        const targetKey = `void:${params.shipmentId}:${shipment.postage_provider_label_id}`;
        const request = {
          providerShipmentId: shipment.postage_provider_shipment_id,
          providerLabelId: shipment.postage_provider_label_id,
          trackingIdentifier: shipment.tracking_identifier,
        };
        const requestHash = shipmentMutationRequestHash({
          commandKind: "void-label",
          tenantId,
          sellerAccountId: params.sellerAccountId,
          shipmentId: params.shipmentId,
          target: targetKey,
          request,
        });
        const reservation = await reservePostageOperation(deps.db, {
          tenantId,
          sellerAccountId: params.sellerAccountId,
          shipmentId: params.shipmentId,
          keyDigest,
          requestHash,
          targetKey,
          operationKind: "void-label",
          providerName: postageLabelProvider.providerName,
          providerMode: postageLabelProvider.providerMode,
          request,
          now: voidRequestedAt,
        });
        if (reservation.targetConflict) {
          throw new FulfillmentDomainError("Another immutable postage operation already owns this label target.");
        }
        const operation = reservation.operation;
        if (!reservation.created) {
          if (operation.status === "effect-applied") {
            return { shipmentId: params.shipmentId, version: await getShipmentVersion(params.shipmentId) };
          }
          if (operation.status === "provider-succeeded" && operation.provider_result_json) {
            const result = operation.provider_result_json as Awaited<ReturnType<PostageLabelProvider["voidLabel"]>>;
            const current = await repository.load(`fulfillment.shipment-${params.shipmentId}`);
            assertCompleteHistoryTenant(current.storedEvents, tenantId);
            await commandHandler({
              streamId: `fulfillment.shipment-${params.shipmentId}`,
              command: {
                type: "VoidShipmentLabel",
                refundStatus: result.refundStatus,
                refundReference: result.refundReference,
                voidedAt: result.voidedAt,
              },
              context,
              expectedVersion: current.version,
            });
            return { shipmentId: params.shipmentId, version: await getShipmentVersion(params.shipmentId) };
          }
          throw new FulfillmentDomainError(
            operation.status === "ambiguous"
              ? "Postage label void outcome is ambiguous; reconciliation is required."
              : "Postage label void is pending durable reconciliation.",
          );
        }
        const claim = await claimReservedPostageOperation(deps.db, operation);
        if (!claim) throw new FulfillmentDomainError("Postage label void is already claimed.");
        if (
          !(await transitionPostageOperation(deps.db, {
            claim,
            from: "reserved",
            to: "invoking",
            providerInvoked: true,
          }))
        ) {
          throw new FulfillmentDomainError("Postage label void claim was lost before invocation.");
        }
        let voidedLabel: Awaited<ReturnType<PostageLabelProvider["voidLabel"]>>;
        try {
          voidedLabel = await postageLabelProvider.voidLabel(request);
        } catch {
          await transitionPostageOperation(deps.db, {
            claim,
            from: "invoking",
            to: "ambiguous",
            providerInvoked: true,
            closedReason: "invocation-outcome-unknown",
          });
          throw new FulfillmentDomainError("Postage label void outcome is ambiguous; reconciliation is required.");
        }
        if (
          !(await transitionPostageOperation(deps.db, {
            claim,
            from: "invoking",
            to: "provider-succeeded",
            providerInvoked: true,
            providerShipmentId: shipment.postage_provider_shipment_id,
            providerLabelId: shipment.postage_provider_label_id,
            trackingIdentifier: shipment.tracking_identifier,
            providerResult: voidedLabel,
          }))
        ) {
          throw new FulfillmentDomainError("Postage label void result requires reconciliation.");
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
          expectedVersion: loaded.version,
        });
        if (
          !(await transitionPostageOperation(deps.db, {
            claim,
            from: "provider-succeeded",
            to: "effect-applied",
            completedAt: voidedLabel.voidedAt,
          }))
        ) {
          throw new FulfillmentDomainError("Postage label void finalization requires reconciliation.");
        }
        return { shipmentId: params.shipmentId, version: result.version };
      }
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
        await recordFulfillmentPostageLabelOperationProviderSucceeded(deps.db, {
          operationKey,
          providerShipmentId: shipment.postage_provider_shipment_id,
          providerLabelId: shipment.postage_provider_label_id,
          trackingIdentifier: shipment.tracking_identifier,
          updatedAt: voidedLabel.voidedAt,
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
        expectedVersion: loaded.version,
      });
      const terminalRefundStatus = normalizeProviderRefundStatus(voidedLabel.refundStatus);
      if (terminalRefundStatus === "refunded") {
        await recordFulfillmentPostageLabelOperationSucceeded(deps.db, {
          operationKey,
          providerShipmentId: shipment.postage_provider_shipment_id,
          providerLabelId: shipment.postage_provider_label_id,
          trackingIdentifier: shipment.tracking_identifier,
          completedAt: voidedLabel.voidedAt,
        });
      } else if (terminalRefundStatus === "rejected") {
        await recordFulfillmentPostageLabelOperationFailed(deps.db, {
          operationKey,
          errorMessage: "Postage label refund was rejected by the provider.",
          completedAt: voidedLabel.voidedAt,
        });
      }

      return { shipmentId: params.shipmentId, version: result.version };
    },
    dispatchShipment: async (params, context) => {
      const shipment = await requireSellerShipment(
        params.shipmentId,
        params.sellerAccountId,
        params.mutationAttemptId ? context : undefined,
      );
      if (await hasActivePaymentFraudReviewHold(deps.db, shipment.order_id)) {
        throw new FulfillmentDomainError("Shipment dispatch is blocked while Stripe reviews the payment.");
      }

      if (params.mutationAttemptId) {
        return executeAttempt(
          {
            ...params,
            mutationAttemptId: params.mutationAttemptId,
            commandKind: "dispatch-shipment",
            command: () => ({ type: "DispatchShipment", dispatchedAt: new Date().toISOString() }),
            successStatus: "dispatched",
          },
          context,
        );
      }

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
      if (params.mutationAttemptId) {
        return executeAttempt(
          {
            ...params,
            mutationAttemptId: params.mutationAttemptId,
            commandKind: "deliver-shipment",
            command: () => ({ type: "RecordShipmentDelivery", deliveredAt: new Date().toISOString() }),
            successStatus: "delivered",
          },
          context,
        );
      }
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
      if (params.mutationAttemptId) {
        return executeAttempt(
          {
            ...params,
            mutationAttemptId: params.mutationAttemptId,
            commandKind: "return-shipment",
            request: { reason: params.reason ?? null },
            command: () => ({
              type: "ReturnShipment",
              reason: params.reason ?? null,
              returnedAt: new Date().toISOString(),
            }),
            successStatus: "returned",
          },
          context,
        );
      }
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
      if (params.mutationAttemptId) {
        return executeAttempt(
          {
            ...params,
            mutationAttemptId: params.mutationAttemptId,
            commandKind: "raise-shipment-exception",
            request: { exceptionType: params.exceptionType, notes: params.notes ?? null },
            command: () => ({
              type: "RaiseShipmentException",
              exceptionType: params.exceptionType as ShipmentExceptionType,
              notes: params.notes ?? null,
              raisedAt: new Date().toISOString(),
            }),
            successStatus: "exception-raised",
          },
          context,
        );
      }
      await requireSellerShipment(params.shipmentId, params.sellerAccountId);

      const result = await commandHandler({
        streamId: `fulfillment.shipment-${params.shipmentId}`,
        command: {
          type: "RaiseShipmentException",
          exceptionType: params.exceptionType as ShipmentExceptionType,
          notes: params.notes ?? null,
          raisedAt: new Date().toISOString(),
        },
        context,
      });

      return { shipmentId: params.shipmentId, version: result.version };
    },
    recoverShipmentMutation: async (params, context) => {
      const loaded = await repository.load(`fulfillment.shipment-${params.shipmentId}`);
      const tenantId = String(context.tenantId);
      assertCompleteHistoryTenant(loaded.storedEvents, tenantId);
      if (String(loaded.state.sellerAccountId) !== params.sellerAccountId) {
        throw new FulfillmentDomainError("Shipment not found.");
      }
      const attempt = await readShipmentMutationAttempt({
        eventStore: deps.eventStore,
        context,
        key: params.mutationAttemptId,
        shipmentId: params.shipmentId,
        sellerAccountId: params.sellerAccountId,
      });
      if (attempt) {
        return {
          schemaVersion: 1,
          shipmentId: params.shipmentId,
          shipmentVersion: loaded.version,
          shipmentStatus: loaded.state.status ?? "unknown",
          status: attempt.resultClass,
          receiptKind: "shipment-attempt",
          commandKind: attempt.commandKind,
          result: attempt.response,
          actions: attempt.resultClass === "failed-safe" ? ["correct-and-new-attempt"] : ["read-current-shipment"],
        };
      }
      const keyDigest = shipmentMutationKeyDigest({
        tenantId,
        sellerAccountId: params.sellerAccountId,
        key: params.mutationAttemptId,
      });
      const operation = await findPostageOperationByDigest(deps.db, {
        tenantId,
        sellerAccountId: params.sellerAccountId,
        keyDigest,
      });
      if (operation) {
        const status = postageOperationRecoveryStatus(operation);
        return {
          schemaVersion: 1,
          shipmentId: params.shipmentId,
          shipmentVersion: loaded.version,
          shipmentStatus: loaded.state.status ?? "unknown",
          status,
          receiptKind: "postage-operation",
          commandKind: operation.operation_kind,
          result: null,
          actions: status === "ambiguous" ? ["read-status", "contact-support"] : ["read-current-shipment"],
        };
      }
      return {
        schemaVersion: 1,
        shipmentId: params.shipmentId,
        shipmentVersion: loaded.version,
        shipmentStatus: loaded.state.status ?? "unknown",
        status: "confirming",
        receiptKind: "absent",
        commandKind: null,
        result: null,
        actions: ["refresh-status", "explicit-same-attempt-retry"],
      };
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
