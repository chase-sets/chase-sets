import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import { normalizeSupportRequestRemedyAuthorizedV1 } from "@chase-sets/event-core/platform-coverage-facts";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import { syncReviewEligibilityForOrder, type ReviewEligibilityNotify } from "./eligibility-sync";

const ID_SUFFIX_LABEL_LENGTH = 24;

/**
 * Slugifies a display name into a marketplace-safe, ASCII, kebab-case label.
 * Kept local to the reviews source integration (single-slice usage): the
 * algorithm mirrors discovery's `createMarketplaceSlug` (and checkout's
 * `createSellerSlug`) so a seller resolves to the same public slug across
 * read models, but the helper is intentionally not shared across contexts --
 * reviews only subscribes to the identity events it already consumes here,
 * rather than adding a cross-context runtime dependency on discovery just to
 * resolve `subjectAccountSlug`.
 */
function createSlugBase(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function hashId(id: string): string {
  let hash = 0x811c9dc5;

  for (const character of id) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(36);
}

function compactIdSuffix(id: string): string {
  const suffix = createSlugBase(id).slice(-ID_SUFFIX_LABEL_LENGTH).replace(/^-+/, "");

  return `${suffix || "item"}-${hashId(id)}`;
}

function createReviewAccountSlug(displayName: string, accountId: string): string {
  const base = createSlugBase(displayName) || "marketplace";

  return `${base}-${compactIdSuffix(accountId)}`;
}

export function buildReviewAccountProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.account.created": async (event) => {
      const { accountId, displayName } = event.data as {
        accountId: string;
        displayName: string;
      };
      const slug = createReviewAccountSlug(displayName, accountId);

      await db.query(
        `INSERT INTO marketplace_review_account_sources (
           account_id,
           display_name,
           slug,
           status,
           updated_at
         ) VALUES ($1, $2, $3, 'active', $4)
         ON CONFLICT (account_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           slug = EXCLUDED.slug,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at`,
        [accountId, displayName, slug, event.timing.recordedAt],
      );
    },
    "identity.account.profile-updated": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, "identity.account-");
      const { displayName } = event.data as { displayName: string };
      const slug = createReviewAccountSlug(displayName, accountId);

      await db.query(
        `INSERT INTO marketplace_review_account_sources (
           account_id,
           display_name,
           slug,
           status,
           updated_at
         ) VALUES (
           $1,
           $2,
           $3,
           COALESCE((SELECT status FROM marketplace_review_account_sources WHERE account_id = $1), 'active'),
           $4
         )
         ON CONFLICT (account_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           slug = EXCLUDED.slug,
           updated_at = EXCLUDED.updated_at`,
        [accountId, displayName, slug, event.timing.recordedAt],
      );
    },
    "identity.account.suspended": async (event) => {
      await db.query(
        `UPDATE marketplace_review_account_sources
         SET status = 'suspended',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
    "identity.account.reactivated": async (event) => {
      await db.query(
        `UPDATE marketplace_review_account_sources
         SET status = 'active',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
    "identity.account.closed": async (event) => {
      await db.query(
        `UPDATE marketplace_review_account_sources
         SET status = 'closed',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
  };
}

export function buildReviewOrderSourceProjectionHandlers(
  db: PgQueryable,
  notify?: ReviewEligibilityNotify,
): ProjectorHandlerMap {
  return {
    "ordering.order.created": async (event) => {
      const data = event.data as {
        orderId: string;
        buyerAccountId: string;
        sellerAccountId: string;
        shippingDestinationSnapshot?: Readonly<{ email?: string | null }>;
      };

      await db.query(
        `INSERT INTO marketplace_review_order_sources (
           order_id,
           buyer_account_id,
           seller_account_id,
           status,
           created_at,
           updated_at,
           cancelled_at,
           ready_for_fulfillment_at,
           buyer_email
         ) VALUES ($1, $2, $3, 'pending-reservation', $4, $4, NULL, NULL, $5)
         ON CONFLICT (order_id) DO UPDATE SET
           buyer_account_id = EXCLUDED.buyer_account_id,
           seller_account_id = EXCLUDED.seller_account_id,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at,
           cancelled_at = EXCLUDED.cancelled_at,
           buyer_email = EXCLUDED.buyer_email`,
        [
          data.orderId,
          data.buyerAccountId,
          data.sellerAccountId,
          event.timing.recordedAt,
          data.shippingDestinationSnapshot?.email ?? null,
        ],
      );

      // The shipment projection drops the eligibility upsert when the order
      // source row has not landed yet, so heal that race once the order shows up.
      await syncReviewEligibilityForOrder(db, data.orderId, event.timing.recordedAt, notify);
    },
    "ordering.order.pending-payment-recorded": async (event) => {
      const data = event.data as {
        orderId: string;
        pendingPaymentAt: string;
      };

      await db.query(
        `UPDATE marketplace_review_order_sources
         SET status = 'pending-payment',
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.pendingPaymentAt],
      );
    },
    "ordering.order.cancelled": async (event) => {
      const data = event.data as { orderId: string; cancelledAt: string };

      await db.query(
        `UPDATE marketplace_review_order_sources
         SET status = 'cancelled',
             cancelled_at = $2,
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.cancelledAt],
      );

      await syncReviewEligibilityForOrder(db, data.orderId, data.cancelledAt, notify);
    },
    "ordering.order.ready-for-fulfillment-recorded": async (event) => {
      const data = event.data as {
        orderId: string;
        readyForFulfillmentAt: string;
      };

      await db.query(
        `UPDATE marketplace_review_order_sources
         SET status = 'ready-for-fulfillment',
             ready_for_fulfillment_at = $2,
             updated_at = $2
         WHERE order_id = $1`,
        [data.orderId, data.readyForFulfillmentAt],
      );
    },
  };
}

export function buildReviewShipmentSourceProjectionHandlers(
  db: PgQueryable,
  options: Readonly<{
    onDeliveredShipment?: (params: { shipmentId: string; deliveredAt: string }) => Promise<void>;
  }> = {},
): ProjectorHandlerMap {
  return {
    "fulfillment.shipment.created": async (event) => {
      const data = event.data as {
        shipmentId: string;
        orderId: string;
        createdAt: string;
      };

      await db.query(
        `INSERT INTO marketplace_review_shipment_sources (
           shipment_id,
           order_id,
           status,
           created_at,
           updated_at,
           dispatched_at,
           delivered_at,
           returned_at,
           exception_raised_at
         ) VALUES ($1, $2, 'awaiting-package', $3, $3, NULL, NULL, NULL, NULL)
         ON CONFLICT (shipment_id) DO UPDATE SET
           order_id = EXCLUDED.order_id,
           updated_at = EXCLUDED.updated_at`,
        [data.shipmentId, data.orderId, data.createdAt],
      );
    },
    "fulfillment.shipment.dispatched": async (event) => {
      const data = event.data as {
        shipmentId: string;
        dispatchedAt: string;
      };

      await db.query(
        `UPDATE marketplace_review_shipment_sources
         SET status = 'dispatched',
             dispatched_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.dispatchedAt],
      );
    },
    "fulfillment.shipment.delivered": async (event) => {
      const data = event.data as {
        shipmentId: string;
        deliveredAt: string;
      };

      await db.query(
        `UPDATE marketplace_review_shipment_sources
         SET status = 'delivered',
             delivered_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.deliveredAt],
      );

      await options.onDeliveredShipment?.(data);
    },
    "fulfillment.shipment.returned": async (event) => {
      const data = event.data as {
        shipmentId: string;
        returnedAt: string;
      };

      await db.query(
        `UPDATE marketplace_review_shipment_sources
         SET status = 'returned',
             returned_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.returnedAt],
      );
    },
    "fulfillment.shipment.exception-raised": async (event) => {
      const data = event.data as {
        shipmentId: string;
        raisedAt: string;
      };

      await db.query(
        `UPDATE marketplace_review_shipment_sources
         SET status = 'exception',
             exception_raised_at = $2,
             updated_at = $2
         WHERE shipment_id = $1`,
        [data.shipmentId, data.raisedAt],
      );
    },
  };
}

export function buildReviewSupportSourceProjectionHandlers(
  db: PgQueryable,
  notify?: ReviewEligibilityNotify,
): ProjectorHandlerMap {
  return {
    "support.support-request.opened": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        orderId: string;
        openedAt: string;
        reviewDirections?: readonly ("buyer-to-seller" | "seller-to-buyer")[];
      };
      const reviewDirections =
        data.reviewDirections?.filter(
          (direction) => direction === "buyer-to-seller" || direction === "seller-to-buyer",
        ) ?? [];

      await db.query(
        `INSERT INTO marketplace_review_support_request_sources (
           support_request_id,
           order_id,
           status,
           responsibility,
           resolution_type,
           review_directions,
           opened_at,
           updated_at,
           cancelled_at,
           resolved_at
         ) VALUES ($1, $2, 'open', NULL, NULL, $4, $3, $3, NULL, NULL)
         ON CONFLICT (support_request_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             status = CASE
               WHEN GREATEST(
                 COALESCE(marketplace_review_support_request_sources.resolved_at, '-infinity'::timestamptz),
                 COALESCE(marketplace_review_support_request_sources.cancelled_at, '-infinity'::timestamptz)
               ) >= EXCLUDED.opened_at
                 THEN marketplace_review_support_request_sources.status
               ELSE 'open'
             END,
             responsibility = CASE
               WHEN GREATEST(
                 COALESCE(marketplace_review_support_request_sources.resolved_at, '-infinity'::timestamptz),
                 COALESCE(marketplace_review_support_request_sources.cancelled_at, '-infinity'::timestamptz)
               ) >= EXCLUDED.opened_at
                 THEN marketplace_review_support_request_sources.responsibility
               ELSE NULL
             END,
             resolution_type = CASE
               WHEN GREATEST(
                 COALESCE(marketplace_review_support_request_sources.resolved_at, '-infinity'::timestamptz),
                 COALESCE(marketplace_review_support_request_sources.cancelled_at, '-infinity'::timestamptz)
               ) >= EXCLUDED.opened_at
                 THEN marketplace_review_support_request_sources.resolution_type
               ELSE NULL
             END,
             review_directions = EXCLUDED.review_directions,
             opened_at = CASE
               WHEN EXCLUDED.opened_at > COALESCE(marketplace_review_support_request_sources.cancelled_at, '-infinity'::timestamptz)
                 AND EXCLUDED.opened_at > COALESCE(marketplace_review_support_request_sources.resolved_at, '-infinity'::timestamptz)
                 THEN EXCLUDED.opened_at
               ELSE COALESCE(marketplace_review_support_request_sources.opened_at, EXCLUDED.opened_at)
             END,
             updated_at = GREATEST(marketplace_review_support_request_sources.updated_at, EXCLUDED.updated_at),
             cancelled_at = CASE
               WHEN EXCLUDED.opened_at > COALESCE(marketplace_review_support_request_sources.cancelled_at, '-infinity'::timestamptz)
                 AND EXCLUDED.opened_at > COALESCE(marketplace_review_support_request_sources.resolved_at, '-infinity'::timestamptz)
                 THEN NULL
               ELSE marketplace_review_support_request_sources.cancelled_at
             END,
             resolved_at = CASE
               WHEN EXCLUDED.opened_at > COALESCE(marketplace_review_support_request_sources.cancelled_at, '-infinity'::timestamptz)
                 AND EXCLUDED.opened_at > COALESCE(marketplace_review_support_request_sources.resolved_at, '-infinity'::timestamptz)
                 THEN NULL
               ELSE marketplace_review_support_request_sources.resolved_at
             END`,
        [
          data.supportRequestId,
          data.orderId,
          data.openedAt,
          reviewDirections.length > 0 ? reviewDirections : ["buyer-to-seller", "seller-to-buyer"],
        ],
      );

      await syncReviewEligibilityForOrder(db, data.orderId, data.openedAt, notify);
    },
    "support.support-request.cancelled": async (event) => {
      const data = event.data as { supportRequestId: string; orderId: string; cancelledAt: string };

      await db.query(
        `INSERT INTO marketplace_review_support_request_sources (
           support_request_id,
           order_id,
           status,
           responsibility,
           resolution_type,
           review_directions,
           opened_at,
           updated_at,
           cancelled_at,
           resolved_at
         ) VALUES ($1, $2, 'cancelled', NULL, NULL, ARRAY['buyer-to-seller', 'seller-to-buyer']::text[], NULL, $3, $3, NULL)
         ON CONFLICT (support_request_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             status = CASE
               WHEN EXCLUDED.cancelled_at >= COALESCE(marketplace_review_support_request_sources.opened_at, '-infinity'::timestamptz)
                 AND EXCLUDED.cancelled_at >= GREATEST(
                   COALESCE(marketplace_review_support_request_sources.resolved_at, '-infinity'::timestamptz),
                   COALESCE(marketplace_review_support_request_sources.cancelled_at, '-infinity'::timestamptz)
                 ) THEN 'cancelled'
               ELSE marketplace_review_support_request_sources.status
             END,
             responsibility = CASE
               WHEN EXCLUDED.cancelled_at >= COALESCE(marketplace_review_support_request_sources.opened_at, '-infinity'::timestamptz)
                 THEN NULL
               ELSE marketplace_review_support_request_sources.responsibility
             END,
             resolution_type = CASE
               WHEN EXCLUDED.cancelled_at >= COALESCE(marketplace_review_support_request_sources.opened_at, '-infinity'::timestamptz)
                 THEN NULL
               ELSE marketplace_review_support_request_sources.resolution_type
             END,
             updated_at = GREATEST(marketplace_review_support_request_sources.updated_at, EXCLUDED.updated_at),
             cancelled_at = CASE
               WHEN EXCLUDED.cancelled_at >= COALESCE(marketplace_review_support_request_sources.opened_at, '-infinity'::timestamptz)
                 AND EXCLUDED.cancelled_at >= COALESCE(marketplace_review_support_request_sources.resolved_at, '-infinity'::timestamptz)
                 THEN EXCLUDED.cancelled_at
               ELSE marketplace_review_support_request_sources.cancelled_at
             END,
             resolved_at = CASE
               WHEN EXCLUDED.cancelled_at >= COALESCE(marketplace_review_support_request_sources.opened_at, '-infinity'::timestamptz)
                 AND EXCLUDED.cancelled_at >= COALESCE(marketplace_review_support_request_sources.resolved_at, '-infinity'::timestamptz)
                 THEN NULL
               ELSE marketplace_review_support_request_sources.resolved_at
             END`,
        [data.supportRequestId, data.orderId, data.cancelledAt],
      );

      await syncReviewEligibilityForOrder(db, data.orderId, data.cancelledAt, notify);
    },
    "support.support-request.resolved": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        orderId: string;
        resolution: { resolutionType: string; responsibility?: unknown; resolvedAt: string };
      };

      await db.query(
        `INSERT INTO marketplace_review_support_request_sources (
           support_request_id,
           order_id,
           status,
           responsibility,
           resolution_type,
           review_directions,
           opened_at,
           updated_at,
           cancelled_at,
           resolved_at
         ) VALUES ($1, $2, 'resolved', $3, $4, ARRAY['buyer-to-seller', 'seller-to-buyer']::text[], NULL, $5, NULL, $5)
         ON CONFLICT (support_request_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             status = CASE
               WHEN EXCLUDED.resolved_at >= COALESCE(marketplace_review_support_request_sources.opened_at, '-infinity'::timestamptz)
                 AND EXCLUDED.resolved_at >= GREATEST(
                   COALESCE(marketplace_review_support_request_sources.resolved_at, '-infinity'::timestamptz),
                   COALESCE(marketplace_review_support_request_sources.cancelled_at, '-infinity'::timestamptz)
                 ) THEN 'resolved'
               ELSE marketplace_review_support_request_sources.status
             END,
             responsibility = CASE
               WHEN EXCLUDED.resolved_at >= COALESCE(marketplace_review_support_request_sources.opened_at, '-infinity'::timestamptz)
                 AND EXCLUDED.resolved_at >= COALESCE(marketplace_review_support_request_sources.cancelled_at, '-infinity'::timestamptz)
                 THEN EXCLUDED.responsibility
               ELSE marketplace_review_support_request_sources.responsibility
             END,
             resolution_type = CASE
               WHEN EXCLUDED.resolved_at >= COALESCE(marketplace_review_support_request_sources.opened_at, '-infinity'::timestamptz)
                 AND EXCLUDED.resolved_at >= COALESCE(marketplace_review_support_request_sources.cancelled_at, '-infinity'::timestamptz)
                 THEN EXCLUDED.resolution_type
               ELSE marketplace_review_support_request_sources.resolution_type
             END,
             updated_at = GREATEST(marketplace_review_support_request_sources.updated_at, EXCLUDED.updated_at),
             cancelled_at = CASE
               WHEN EXCLUDED.resolved_at >= COALESCE(marketplace_review_support_request_sources.opened_at, '-infinity'::timestamptz)
                 AND EXCLUDED.resolved_at >= COALESCE(marketplace_review_support_request_sources.cancelled_at, '-infinity'::timestamptz)
                 THEN NULL
               ELSE marketplace_review_support_request_sources.cancelled_at
             END,
             resolved_at = CASE
               WHEN EXCLUDED.resolved_at >= COALESCE(marketplace_review_support_request_sources.opened_at, '-infinity'::timestamptz)
                 AND EXCLUDED.resolved_at >= COALESCE(marketplace_review_support_request_sources.cancelled_at, '-infinity'::timestamptz)
                 THEN EXCLUDED.resolved_at
               ELSE marketplace_review_support_request_sources.resolved_at
             END`,
        [
          data.supportRequestId,
          data.orderId,
          typeof data.resolution.responsibility === "string" ? data.resolution.responsibility : null,
          data.resolution.resolutionType,
          data.resolution.resolvedAt,
        ],
      );

      await syncReviewEligibilityForOrder(db, data.orderId, data.resolution.resolvedAt, notify);
    },
    "support.support-request.remedy-authorized.v1": async (event) => {
      const data = normalizeSupportRequestRemedyAuthorizedV1(
        event.data as Parameters<typeof normalizeSupportRequestRemedyAuthorizedV1>[0],
      );
      const remedyId = parseTypedId(data.remedyId, "rmd");
      const coverageId = data.coverageId === null ? null : parseTypedId(data.coverageId, "cov");

      await db.query(
        `INSERT INTO marketplace_review_remedy_sources (
           support_request_id,
           remedy_id,
           coverage_id,
           remedy_kind,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (support_request_id) DO UPDATE
         SET remedy_id = EXCLUDED.remedy_id,
             coverage_id = EXCLUDED.coverage_id,
             remedy_kind = EXCLUDED.remedy_kind,
             updated_at = EXCLUDED.updated_at`,
        [data.supportRequestId, remedyId, coverageId, data.remedy.kind, data.occurredAt],
      );

      const supportResult = await db.query<{ order_id: string }>(
        `SELECT order_id
         FROM marketplace_review_support_request_sources
         WHERE support_request_id = $1`,
        [data.supportRequestId],
      );
      const orderId = supportResult.rows[0]?.order_id;
      if (orderId) {
        await syncReviewEligibilityForOrder(db, orderId, data.occurredAt, notify);
      }
    },
  };
}
