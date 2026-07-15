// Fulfillment command center read model — the single work-ordered view of the shipments
// that need the seller now: pack, label, dispatch, and exceptions on one surface. It
// consumes the Seller Desk attention-queue contract (the `fulfillment-ship-by` source and
// the shared `compareSellerAttentionItems` ordering policy) so the web command center and
// the MCP `seller_attention_queue` tool order fulfillment work identically. Each item
// carries the context-aware action plan derived from the shipment's state, so the surface
// renders the one next action without re-encoding the state machine.

import {
  buildSellerAttentionItem,
  compareSellerAttentionItems,
  SELLER_ATTENTION_SOURCES,
  type SellerAttentionItem,
  type SellerAttentionSeverity,
  type SellerAttentionSourceId,
} from "@chase-sets/seller-attention-queue";
import type { PostageLabelStatus, ShipmentStatus } from "../domain/common";
import { resolveShipmentActionPlan, type ShipmentActionPlan } from "../domain/shipment-action";

// The fulfillment source in the Seller Desk attention contract. Resolved from the shared
// registry so this read model and the contract can never disagree about the source id.
const FULFILLMENT_ATTENTION_SOURCE: SellerAttentionSourceId = (() => {
  const source = SELLER_ATTENTION_SOURCES.find((candidate) => candidate.ownerContext === "fulfillment");
  if (!source) {
    throw new Error("Seller Desk attention contract is missing the fulfillment source.");
  }
  return source.id;
})();

export type FulfillmentCommandCenterBucketId = "needs-packing" | "needs-label" | "ready-to-dispatch" | "exceptions";

export const FULFILLMENT_COMMAND_CENTER_BUCKET_ORDER: readonly FulfillmentCommandCenterBucketId[] = [
  "exceptions",
  "ready-to-dispatch",
  "needs-label",
  "needs-packing",
];

// The minimal shipment shape the command center reads. Compatible with the seller
// shipment list row; only these fields drive work ordering and the action plan.
export type FulfillmentCommandCenterShipmentInput = Readonly<{
  shipment_id: string;
  order_id: string;
  display_reference: string;
  status: string;
  label_status: string;
  tracking_identifier: string | null;
  carrier_name: string | null;
  buyer_display_name: string | null;
  current_exception_type: string | null;
  current_exception_notes: string | null;
  line_count: number;
  total_quantity: number;
  created_at: string;
  updated_at: string;
}>;

export type FulfillmentCommandCenterItem = Readonly<{
  shipmentId: string;
  orderId: string;
  displayReference: string;
  status: ShipmentStatus;
  labelStatus: PostageLabelStatus;
  trackingIdentifier: string | null;
  carrierName: string | null;
  buyerDisplayName: string | null;
  currentExceptionType: string | null;
  currentExceptionNotes: string | null;
  lineCount: number;
  totalQuantity: number;
  bucket: FulfillmentCommandCenterBucketId;
  severity: SellerAttentionSeverity;
  observedAt: string;
  // The context-aware action plan (primary next action + disclosed actions).
  plan: ShipmentActionPlan;
  // The shared Seller Desk attention item this shipment contributes to the queue,
  // built through the seller-attention-queue contract so id, severity cap, deep link,
  // and ordering all match the cross-context aggregation.
  attention: SellerAttentionItem;
}>;

export type FulfillmentCommandCenterBucket = Readonly<{
  id: FulfillmentCommandCenterBucketId;
  items: readonly FulfillmentCommandCenterItem[];
  count: number;
}>;

export type FulfillmentCommandCenter = Readonly<{
  source: SellerAttentionSourceId;
  buckets: readonly FulfillmentCommandCenterBucket[];
  // Every actionable item, ordered by the shared Seller Desk attention policy — the flat
  // queue the Desk home and the MCP tool consume.
  queue: readonly FulfillmentCommandCenterItem[];
  totalNeedingAttention: number;
}>;

function bucketForStatus(status: ShipmentStatus): FulfillmentCommandCenterBucketId | null {
  switch (status) {
    case "awaiting-package":
    case "packing":
      return "needs-packing";
    case "awaiting-label":
      return "needs-label";
    case "label-attached":
      return "ready-to-dispatch";
    case "exception":
      return "exceptions";
    default:
      // dispatched / delivered / returned / cancelled need no seller action here.
      return null;
  }
}

function severityForBucket(bucket: FulfillmentCommandCenterBucketId): SellerAttentionSeverity {
  return bucket === "exceptions" ? "critical" : "warning";
}

function toCommandCenterItem(shipment: FulfillmentCommandCenterShipmentInput): FulfillmentCommandCenterItem | null {
  const status = shipment.status as ShipmentStatus;
  const bucket = bucketForStatus(status);
  if (!bucket) {
    return null;
  }
  const labelStatus = shipment.label_status as PostageLabelStatus;
  const severity = severityForBucket(bucket);
  const observedAt = shipment.created_at;
  const plan = resolveShipmentActionPlan({ status, labelStatus });

  return {
    shipmentId: shipment.shipment_id,
    orderId: shipment.order_id,
    displayReference: shipment.display_reference,
    status,
    labelStatus,
    trackingIdentifier: shipment.tracking_identifier,
    carrierName: shipment.carrier_name,
    buyerDisplayName: shipment.buyer_display_name,
    currentExceptionType: shipment.current_exception_type,
    currentExceptionNotes: shipment.current_exception_notes,
    lineCount: shipment.line_count,
    totalQuantity: shipment.total_quantity,
    bucket,
    severity,
    observedAt,
    plan,
    attention: buildSellerAttentionItem({
      source: FULFILLMENT_ATTENTION_SOURCE,
      entityId: shipment.shipment_id,
      severity,
      summary: {
        code: `fulfillment.command-center.${bucket}`,
        params: { reference: shipment.display_reference, quantity: shipment.total_quantity },
      },
      // The shipment read model carries no ship-by column yet; ordering falls through to
      // source priority and age until a ship-by deadline is projected.
      dueAt: null,
      observedAt,
    }),
  };
}

function compareItems(a: FulfillmentCommandCenterItem, b: FulfillmentCommandCenterItem): number {
  const byAttention = compareSellerAttentionItems(a.attention, b.attention);
  if (byAttention !== 0) {
    return byAttention;
  }
  // Stable, deterministic tiebreak within an otherwise-equal ordering.
  return a.shipmentId.localeCompare(b.shipmentId, "en");
}

// Builds the work-ordered command center from the seller's shipments. Terminal and
// in-transit shipments are excluded; the remaining actionable shipments are bucketed by
// work state and ordered by the shared Seller Desk attention policy.
export function buildFulfillmentCommandCenter(
  shipments: readonly FulfillmentCommandCenterShipmentInput[],
): FulfillmentCommandCenter {
  const items = shipments
    .map(toCommandCenterItem)
    .filter((item): item is FulfillmentCommandCenterItem => item !== null);

  const buckets = FULFILLMENT_COMMAND_CENTER_BUCKET_ORDER.map((id) => {
    const bucketItems = items.filter((item) => item.bucket === id).sort(compareItems);
    return { id, items: bucketItems, count: bucketItems.length } satisfies FulfillmentCommandCenterBucket;
  });

  const queue = [...items].sort(compareItems);

  return {
    source: FULFILLMENT_ATTENTION_SOURCE,
    buckets,
    queue,
    totalNeedingAttention: items.length,
  };
}
