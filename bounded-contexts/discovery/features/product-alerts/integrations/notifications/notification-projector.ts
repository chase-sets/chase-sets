import type { NotificationOutbox } from "@chase-sets/notifications";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { mapProductAlertMatchToNotification } from "./notification-intents";

export const DISCOVERY_PRODUCT_ALERT_NOTIFICATION_PROJECTION = "discovery-product-alert-notification-projection";

type MarketSide = "listing" | "offer";

type MarketActivity = Readonly<{
  activity_id: string;
  market_side: MarketSide;
  owner_account_id: string | null;
  catalog_catalog_item_id: string;
  product_id: string;
  selected_options: unknown;
  item_title: string | null;
  item_subtitle: string | null;
  product_summary: string | null;
  price_amount: string;
  quantity: number;
  status: string;
  seller_listing_availability_status?: "available" | "unavailable" | null;
  created_at: string;
  updated_at: string;
}>;

type ProductAlertCandidate = Readonly<{
  alert_id: string;
  account_id: string;
  market_side: MarketSide;
  catalog_catalog_item_id: string;
  product_id: string;
  threshold_amount: string | null;
}>;

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

function listingIdFromEvent(event: TransportEvent, data: Record<string, unknown>) {
  return String(data.listingId ?? event.streamId.replace("marketplace.listing-", ""));
}

function normalizeSelectedOptions(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function isActiveForSide(
  activity: Pick<MarketActivity, "market_side" | "status" | "quantity" | "seller_listing_availability_status">,
) {
  return activity.market_side === "listing"
    ? activity.status === "active" &&
        activity.quantity > 0 &&
        (activity.seller_listing_availability_status ?? "available") === "available"
    : activity.status === "submitted" && activity.quantity > 0;
}

function thresholdMatches(alert: ProductAlertCandidate, activity: Pick<MarketActivity, "price_amount">) {
  if (alert.threshold_amount === null) {
    return true;
  }

  const threshold = Number.parseFloat(alert.threshold_amount);
  const price = Number.parseFloat(activity.price_amount);

  if (!Number.isFinite(threshold) || !Number.isFinite(price)) {
    return false;
  }

  return alert.market_side === "listing" ? price <= threshold : price >= threshold;
}

function shouldNotify(alert: ProductAlertCandidate, previous: MarketActivity | null, next: MarketActivity) {
  if (alert.account_id === next.owner_account_id) {
    return false;
  }

  if (!isActiveForSide(next) || !thresholdMatches(alert, next)) {
    return false;
  }

  if (!previous || !isActiveForSide(previous)) {
    return true;
  }

  if (alert.threshold_amount === null) {
    return false;
  }

  return !thresholdMatches(alert, previous);
}

export async function projectMarketplaceEventToProductAlertNotifications(
  db: PgQueryable,
  outbox: NotificationOutbox,
  event: TransportEvent,
  projectionName = DISCOVERY_PRODUCT_ALERT_NOTIFICATION_PROJECTION,
) {
  const previous = await upsertMarketActivityFromEvent(db, event);
  if (previous === undefined) {
    return;
  }

  const next = await loadMarketActivity(db, previous.activity_id);
  if (!next) {
    return;
  }

  const candidates = await loadProductAlertCandidates(db, next);

  for (const alert of candidates) {
    if (!shouldNotify(alert, previous.previous, next)) {
      continue;
    }

    const inserted = await recordNotificationMatch(db, {
      alertId: alert.alert_id,
      activityId: next.activity_id,
      matchKey: next.market_side,
      sourceGlobalPosition: event.globalPosition,
      notifiedAt: event.timing.recordedAt,
    });

    if (!inserted) {
      continue;
    }

    await outbox.enqueueNotification({
      message: mapProductAlertMatchToNotification({
        accountId: alert.account_id,
        alertId: alert.alert_id,
        marketSide: next.market_side,
        activityId: next.activity_id,
        catalogItemId: next.catalog_catalog_item_id,
        itemTitle: next.item_title,
        productSummary: next.product_summary,
        priceAmount: next.price_amount,
        correlationId: correlationIdFromEvent(event),
      }),
      source: {
        sourceEventId: event.id,
        sourceGlobalPosition: event.globalPosition,
        projectionName,
        occurredAt: event.timing.occurredAt,
      },
    });
  }
}

export function buildProductAlertNotificationProjectionHandlers(
  db: PgQueryable,
  outbox: NotificationOutbox,
  projectionName = DISCOVERY_PRODUCT_ALERT_NOTIFICATION_PROJECTION,
): ProjectorHandlerMap {
  return {
    "marketplace.listing.created": (event) =>
      projectMarketplaceEventToProductAlertNotifications(db, outbox, event, projectionName),
    "marketplace.listing.price-updated": (event) =>
      projectMarketplaceEventToProductAlertNotifications(db, outbox, event, projectionName),
    "marketplace.listing.quantity-cap-updated": (event) =>
      projectMarketplaceEventToProductAlertNotifications(db, outbox, event, projectionName),
    "marketplace.listing.published": (event) =>
      projectMarketplaceEventToProductAlertNotifications(db, outbox, event, projectionName),
    "marketplace.listing.paused": (event) =>
      projectMarketplaceEventToProductAlertNotifications(db, outbox, event, projectionName),
    "marketplace.listing.withdrawn": (event) =>
      projectMarketplaceEventToProductAlertNotifications(db, outbox, event, projectionName),
    "marketplace.offer.submitted": (event) =>
      projectMarketplaceEventToProductAlertNotifications(db, outbox, event, projectionName),
    "marketplace.offer.accepted": (event) =>
      projectMarketplaceEventToProductAlertNotifications(db, outbox, event, projectionName),
  };
}

async function upsertMarketActivityFromEvent(
  db: PgQueryable,
  event: TransportEvent,
): Promise<{ activity_id: string; previous: MarketActivity | null } | undefined> {
  const data = event.data as Record<string, unknown>;

  if (event.type === "marketplace.listing.created") {
    const activityId = listingIdFromEvent(event, data);
    const previous = await loadMarketActivity(db, activityId);

    await db.query(
      `INSERT INTO discovery_product_alert_market_activity (
        activity_id,
        market_side,
        owner_account_id,
        catalog_catalog_item_id,
        product_id,
        selected_options,
        item_title,
        item_subtitle,
        product_summary,
        price_amount,
        quantity,
        status,
        created_at,
        updated_at
      ) VALUES (
        $1, 'listing', $2, $3, $4, $5, $6, $7, $8, $9, $10, 'draft', $11, $11
      )
      ON CONFLICT (activity_id) DO UPDATE SET
        owner_account_id = EXCLUDED.owner_account_id,
        catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
        product_id = EXCLUDED.product_id,
        selected_options = EXCLUDED.selected_options,
        item_title = EXCLUDED.item_title,
        item_subtitle = EXCLUDED.item_subtitle,
        product_summary = EXCLUDED.product_summary,
        price_amount = EXCLUDED.price_amount,
        quantity = EXCLUDED.quantity,
        updated_at = EXCLUDED.updated_at`,
      [
        activityId,
        String(data.accountId ?? ""),
        String(data.catalogItemId ?? ""),
        String(data.productId ?? ""),
        JSON.stringify(normalizeSelectedOptions(data.selectedOptions)),
        data.itemTitle == null ? null : String(data.itemTitle),
        data.itemSubtitle == null ? null : String(data.itemSubtitle),
        data.productSummary == null ? null : String(data.productSummary),
        String(data.priceAmount ?? "0"),
        Number(data.quantityCap ?? 0),
        event.timing.recordedAt,
      ],
    );

    return { activity_id: activityId, previous };
  }

  if (event.type.startsWith("marketplace.listing.")) {
    const activityId = listingIdFromEvent(event, data);
    const previous = await loadMarketActivity(db, activityId);
    if (!previous) {
      return undefined;
    }

    if (event.type === "marketplace.listing.price-updated") {
      await db.query(
        `UPDATE discovery_product_alert_market_activity
         SET price_amount = $2,
             updated_at = $3
         WHERE activity_id = $1`,
        [activityId, String(data.priceAmount ?? previous.price_amount), event.timing.recordedAt],
      );
    } else if (event.type === "marketplace.listing.quantity-cap-updated") {
      await db.query(
        `UPDATE discovery_product_alert_market_activity
         SET quantity = $2,
             updated_at = $3
         WHERE activity_id = $1`,
        [activityId, Number(data.quantityCap ?? previous.quantity), event.timing.recordedAt],
      );
    } else if (event.type === "marketplace.listing.published") {
      await db.query(
        `UPDATE discovery_product_alert_market_activity
         SET status = 'active',
             updated_at = $2
         WHERE activity_id = $1`,
        [activityId, event.timing.recordedAt],
      );
    } else if (event.type === "marketplace.listing.paused") {
      await db.query(
        `UPDATE discovery_product_alert_market_activity
         SET status = 'paused',
             updated_at = $2
         WHERE activity_id = $1`,
        [activityId, event.timing.recordedAt],
      );
    } else if (event.type === "marketplace.listing.withdrawn") {
      await db.query(
        `UPDATE discovery_product_alert_market_activity
         SET status = 'withdrawn',
             updated_at = $2
         WHERE activity_id = $1`,
        [activityId, event.timing.recordedAt],
      );
    }

    return { activity_id: activityId, previous };
  }

  if (event.type === "marketplace.offer.submitted") {
    const activityId = String(data.offerId ?? "");
    const previous = await loadMarketActivity(db, activityId);

    await db.query(
      `INSERT INTO discovery_product_alert_market_activity (
        activity_id,
        market_side,
        owner_account_id,
        catalog_catalog_item_id,
        product_id,
        selected_options,
        item_title,
        item_subtitle,
        product_summary,
        price_amount,
        quantity,
        status,
        created_at,
        updated_at
      ) VALUES (
        $1, 'offer', $2, $3, $4, $5, $6, $7, $8, $9, $10, 'submitted', $11, $11
      )
      ON CONFLICT (activity_id) DO UPDATE SET
        owner_account_id = EXCLUDED.owner_account_id,
        catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
        product_id = EXCLUDED.product_id,
        selected_options = EXCLUDED.selected_options,
        item_title = EXCLUDED.item_title,
        item_subtitle = EXCLUDED.item_subtitle,
        product_summary = EXCLUDED.product_summary,
        price_amount = EXCLUDED.price_amount,
        quantity = EXCLUDED.quantity,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at`,
      [
        activityId,
        String(data.buyerAccountId ?? ""),
        String(data.catalogItemId ?? ""),
        String(data.productId ?? ""),
        JSON.stringify(normalizeSelectedOptions(data.selectedOptions)),
        data.itemTitle == null ? null : String(data.itemTitle),
        data.itemSubtitle == null ? null : String(data.itemSubtitle),
        data.productSummary == null ? null : String(data.productSummary),
        String(data.priceAmount ?? "0"),
        Number(data.quantityRequested ?? 0),
        event.timing.recordedAt,
      ],
    );

    return { activity_id: activityId, previous };
  }

  if (event.type === "marketplace.offer.accepted") {
    const activityId = String(data.offerId ?? "");
    const previous = await loadMarketActivity(db, activityId);
    if (!previous) {
      return undefined;
    }

    await db.query(
      `UPDATE discovery_product_alert_market_activity
       SET status = 'accepted',
           updated_at = $2
       WHERE activity_id = $1`,
      [activityId, event.timing.recordedAt],
    );

    return { activity_id: activityId, previous };
  }

  return undefined;
}

async function loadMarketActivity(db: PgQueryable, activityId: string): Promise<MarketActivity | null> {
  const result = await db.query<MarketActivity>(
    `SELECT
       activity.activity_id,
       activity.market_side,
       activity.owner_account_id,
       activity.catalog_catalog_item_id,
       activity.product_id,
       activity.selected_options,
       activity.item_title,
       activity.item_subtitle,
       activity.product_summary,
       activity.price_amount,
       activity.quantity,
       activity.status,
       COALESCE(account.seller_listing_availability_status, 'available') AS seller_listing_availability_status,
       activity.created_at,
       activity.updated_at
     FROM discovery_product_alert_market_activity AS activity
     LEFT JOIN discovery_market_accounts AS account
       ON account.account_id = activity.owner_account_id
     WHERE activity.activity_id = $1`,
    [activityId],
  );

  return result.rows[0] ?? null;
}

async function loadProductAlertCandidates(db: PgQueryable, activity: MarketActivity) {
  const result = await db.query<ProductAlertCandidate>(
    `SELECT
       alert_id,
       account_id,
       market_side,
       catalog_catalog_item_id,
       product_id,
       threshold_amount
     FROM discovery_product_alert_pages
     WHERE status = 'active'
       AND market_side = $1
       AND product_id = $2`,
    [activity.market_side, activity.product_id],
  );

  return result.rows;
}

async function recordNotificationMatch(
  db: PgQueryable,
  input: Readonly<{
    alertId: string;
    activityId: string;
    matchKey: string;
    sourceGlobalPosition: string;
    notifiedAt: string;
  }>,
) {
  const result = await db.query<{ inserted: number }>(
    `INSERT INTO discovery_product_alert_match_notifications (
      alert_id,
      activity_id,
      match_key,
      source_global_position,
      notified_at
    ) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT DO NOTHING
    RETURNING 1 AS inserted`,
    [input.alertId, input.activityId, input.matchKey, input.sourceGlobalPosition, input.notifiedAt],
  );

  return result.rows.length === 1;
}
