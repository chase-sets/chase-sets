import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CartReadinessSnapshot } from "../../cart/domain/readiness";
import type {
  CheckoutSessionLine,
  CheckoutSessionReservation,
  CheckoutShippingAddress,
  CheckoutSourceCommitPosition,
  CheckoutSplitGroupHandoff,
} from "../domain/domain";
import { readCheckoutFulfillmentPreview, type CheckoutFulfillmentPreview } from "../domain/fulfillment-preview";

export type CheckoutSessionRow = Readonly<{
  session_id: string;
  buyer_account_id: string;
  source_type: "cart" | "buy-now" | "offer-intent";
  optimization_goal: "lowest-total" | "fewest-shipments";
  fulfillment_preview_revision: string | null;
  fulfillment_preview_snapshot: CheckoutFulfillmentPreview | null;
  cart_readiness_snapshot?: CartReadinessSnapshot | null;
  split_group_handoff?: CheckoutSplitGroupHandoff | null;
  shipping_option: "standard" | "expedited" | "priority";
  shipping_address_id: string | null;
  shipping_address: CheckoutShippingAddress | null;
  lines: readonly CheckoutSessionLine[];
  order_ids: readonly string[];
  order_write_commit_positions: readonly CheckoutSourceCommitPosition[];
  checkout_reservations: readonly CheckoutSessionReservation[];
  payment_id: string | null;
  submitted_offer_id: string | null;
  created_at: string;
  updated_at: string;
}>;

type CheckoutSessionPageRow = Omit<
  CheckoutSessionRow,
  "lines" | "order_ids" | "order_write_commit_positions" | "source_type" | "shipping_option" | "optimization_goal"
> &
  Readonly<{
    source_type: string;
    optimization_goal: string;
    shipping_option: string;
    fulfillment_preview_snapshot: unknown;
    shipping_address: unknown;
    cart_readiness_snapshot: unknown;
    split_group_handoff: unknown;
    lines: unknown;
    order_ids: unknown;
    order_write_commit_positions: unknown;
    checkout_reservations: unknown;
  }>;

function mapCommitPositions(value: unknown): CheckoutSourceCommitPosition[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((position) => {
    if (typeof position !== "object" || position === null) {
      return [];
    }

    const source = position as Partial<CheckoutSourceCommitPosition>;
    const eventIds = Array.isArray(source.eventIds)
      ? source.eventIds.filter((eventId): eventId is string => typeof eventId === "string" && eventId.length > 0)
      : [];
    return typeof source.sourceContextName === "string" &&
      typeof source.maxGlobalPosition === "string" &&
      eventIds.length > 0
      ? [{ sourceContextName: source.sourceContextName, maxGlobalPosition: source.maxGlobalPosition, eventIds }]
      : [];
  });
}

function mapSessionRow(row: CheckoutSessionPageRow): CheckoutSessionRow {
  return {
    ...row,
    source_type:
      row.source_type === "buy-now" ? "buy-now" : row.source_type === "offer-intent" ? "offer-intent" : "cart",
    optimization_goal: row.optimization_goal === "fewest-shipments" ? "fewest-shipments" : "lowest-total",
    fulfillment_preview_snapshot: readCheckoutFulfillmentPreview(row.fulfillment_preview_snapshot),
    shipping_option:
      row.shipping_option === "expedited" || row.shipping_option === "priority" ? row.shipping_option : "standard",
    shipping_address:
      typeof row.shipping_address === "object" && row.shipping_address !== null
        ? (row.shipping_address as CheckoutShippingAddress)
        : null,
    cart_readiness_snapshot:
      typeof row.cart_readiness_snapshot === "object" && row.cart_readiness_snapshot !== null
        ? (row.cart_readiness_snapshot as CartReadinessSnapshot)
        : null,
    split_group_handoff:
      typeof row.split_group_handoff === "object" && row.split_group_handoff !== null
        ? (row.split_group_handoff as CheckoutSplitGroupHandoff)
        : null,
    lines: Array.isArray(row.lines) ? (row.lines as CheckoutSessionLine[]) : [],
    order_ids: Array.isArray(row.order_ids)
      ? row.order_ids.filter((value): value is string => typeof value === "string")
      : [],
    order_write_commit_positions: mapCommitPositions(row.order_write_commit_positions),
    checkout_reservations: Array.isArray(row.checkout_reservations)
      ? (row.checkout_reservations as CheckoutSessionReservation[])
      : [],
  };
}

export async function getCheckoutSession(
  db: PgQueryable,
  sessionId: string,
  buyerAccountId: string,
): Promise<CheckoutSessionRow | null> {
  const result = await db.query<CheckoutSessionPageRow>(
    `SELECT
       session_id,
       buyer_account_id,
       source_type,
       optimization_goal,
       fulfillment_preview_revision,
       fulfillment_preview_snapshot,
       cart_readiness_snapshot,
       split_group_handoff,
       shipping_option,
       shipping_address_id,
       shipping_address,
       lines,
       order_ids,
       order_write_commit_positions,
       checkout_reservations,
       payment_id,
       submitted_offer_id,
       created_at,
       updated_at
     FROM checkout_session_pages
     WHERE session_id = $1
       AND buyer_account_id = $2`,
    [sessionId, buyerAccountId],
  );

  const row = result.rows[0];
  return row ? mapSessionRow(row) : null;
}
