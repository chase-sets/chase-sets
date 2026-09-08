import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { deriveChannelSelectedOptionKey } from "../domain/canonical";

type Transport = Parameters<ProjectorHandlerMap[string]>[0];

export function buildChannelMarketplaceFactsProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "marketplace.listing.created": async (event) => projectListingCreated(db, event),
    "marketplace.listing.price-updated": async (event) => projectListingPrice(db, event),
    "marketplace.listing.quantity-cap-updated": async (event) => projectListingQuantity(db, event),
    "marketplace.listing.published": async (event) => projectListingStatus(db, event, "active", null),
    "marketplace.listing.paused": async (event) =>
      projectListingStatus(db, event, "paused", textOrNull(record(event.data).reason)),
    "marketplace.listing.auto-unlisted": async (event) => projectListingStatus(db, event, "auto-unlisted", null),
    "marketplace.listing.withdrawn": async (event) => projectListingStatus(db, event, "withdrawn", null),
    "marketplace.seller-listing-availability.disabled": async (event) => projectAvailability(db, event, "unavailable"),
    "marketplace.seller-listing-availability.enabled": async (event) => projectAvailability(db, event, "available"),
  };
}

export function buildChannelCatalogFactsProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.catalog-item.category-assigned": async (event) => projectCategory(db, event, true),
    "catalog.catalog-item.category-removed": async (event) => projectCategory(db, event, false),
    "catalog.catalog-item.external-product-reference-linked": async (event) =>
      projectProductReference(db, event, "linked"),
    "catalog.catalog-item.external-product-reference-unlinked": async (event) =>
      projectProductReference(db, event, "unlinked"),
    "catalog.catalog-item.external-catalog-item-reference-linked": async (event) =>
      projectCatalogReference(db, event, "linked"),
    "catalog.catalog-item.external-catalog-item-reference-unlinked": async (event) =>
      projectCatalogReference(db, event, "unlinked"),
  };
}

export function buildChannelInventoryFactsProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "inventory.item.created": async (event) => {
      const data = record(event.data);
      await db.query(
        `INSERT INTO channels_inventory_item_facts
           (item_id, account_id, catalog_item_id, total_quantity, updated_at, item_stream_version)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (item_id) DO UPDATE SET
           account_id = EXCLUDED.account_id, catalog_item_id = EXCLUDED.catalog_item_id,
           total_quantity = EXCLUDED.total_quantity, updated_at = EXCLUDED.updated_at,
           item_stream_version = EXCLUDED.item_stream_version
         WHERE channels_inventory_item_facts.item_stream_version < EXCLUDED.item_stream_version`,
        [
          data.itemId,
          data.accountId,
          data.catalogItemId,
          data.totalQuantity,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "inventory.item.adjusted": async (event) => {
      const data = record(event.data);
      await db.query(
        `UPDATE channels_inventory_item_facts
         SET total_quantity = total_quantity + $2, updated_at = $3, item_stream_version = $4
         WHERE item_id = $1 AND item_stream_version < $4`,
        [data.itemId, data.quantityDelta, event.timing.recordedAt, event.streamVersion],
      );
    },
    "inventory.hold.placed": async (event) => {
      const data = record(event.data);
      await db.query(
        `INSERT INTO channels_inventory_hold_facts
           (hold_id, item_id, quantity, status, updated_at, hold_stream_version)
         VALUES ($1,$2,$3,'active',$4,$5)
         ON CONFLICT (hold_id) DO UPDATE SET
           item_id = EXCLUDED.item_id, quantity = EXCLUDED.quantity, status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at, hold_stream_version = EXCLUDED.hold_stream_version
         WHERE channels_inventory_hold_facts.hold_stream_version < EXCLUDED.hold_stream_version`,
        [data.holdId, data.itemId, data.quantity, event.timing.recordedAt, event.streamVersion],
      );
    },
    "inventory.hold.converted": async (event) => projectHoldStatus(db, event, "active"),
    "inventory.hold.extended": async (event) => projectHoldStatus(db, event, "active"),
    "inventory.hold.released": async (event) => projectHoldStatus(db, event, "released"),
    "inventory.hold.expired": async (event) => projectHoldStatus(db, event, "expired"),
    "inventory.hold.consumed": async (event) => projectHoldStatus(db, event, "consumed"),
  };
}

export function buildChannelConnectionFactsProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "channels.connection.connected": async (event) => {
      const data = record(event.data);
      await db.query(
        `INSERT INTO channels_connection_facts
           (connection_id, account_id, provider_key, environment, status, updated_at, connection_stream_version)
         VALUES ($1,$2,$3,$4,'pending-setup',$5,$6)
         ON CONFLICT (connection_id) DO UPDATE SET
           account_id=EXCLUDED.account_id, provider_key=EXCLUDED.provider_key, environment=EXCLUDED.environment,
           status=EXCLUDED.status, updated_at=EXCLUDED.updated_at,
           connection_stream_version=EXCLUDED.connection_stream_version
         WHERE channels_connection_facts.connection_stream_version < EXCLUDED.connection_stream_version`,
        [
          data.connectionId,
          data.accountId,
          data.providerKey,
          data.environment,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "channels.connection.activated": async (event) => projectConnectionStatus(db, event, "active"),
    "channels.connection.paused": async (event) => projectConnectionStatus(db, event, "paused"),
    "channels.connection.resumed": async (event) => projectConnectionStatus(db, event, "active"),
    "channels.connection.disconnected": async (event) => projectConnectionStatus(db, event, "disconnected"),
  };
}

async function projectListingCreated(db: PgQueryable, event: Transport): Promise<void> {
  const data = record(event.data);
  const selectedOptions = selections(data.selectedOptions);
  await db.query(
    `INSERT INTO channels_listing_publication_facts (
       listing_id, account_id, inventory_item_id, catalog_item_id, price_amount, price_currency_code,
       quantity_cap, selected_options, selected_option_key, listing_status, pause_reason,
       item_title, item_subtitle, product_summary, graded_card, updated_at, listing_stream_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'draft',NULL,$10,$11,$12,$13::jsonb,$14,$15)
     ON CONFLICT (listing_id) DO UPDATE SET
       account_id=EXCLUDED.account_id, inventory_item_id=EXCLUDED.inventory_item_id,
       catalog_item_id=EXCLUDED.catalog_item_id, price_amount=EXCLUDED.price_amount,
       price_currency_code=EXCLUDED.price_currency_code, quantity_cap=EXCLUDED.quantity_cap,
       selected_options=EXCLUDED.selected_options, selected_option_key=EXCLUDED.selected_option_key,
       listing_status=EXCLUDED.listing_status, pause_reason=NULL, item_title=EXCLUDED.item_title,
       item_subtitle=EXCLUDED.item_subtitle, product_summary=EXCLUDED.product_summary,
       graded_card=EXCLUDED.graded_card, updated_at=EXCLUDED.updated_at,
       listing_stream_version=EXCLUDED.listing_stream_version
     WHERE channels_listing_publication_facts.listing_stream_version < EXCLUDED.listing_stream_version`,
    [
      data.listingId,
      data.accountId,
      data.inventoryItemId,
      data.catalogItemId,
      data.priceAmount,
      typeof data.priceCurrencyCode === "string" ? data.priceCurrencyCode : null,
      data.quantityCap,
      JSON.stringify(selectedOptions),
      deriveChannelSelectedOptionKey(selectedOptions),
      textOrNull(data.itemTitle),
      textOrNull(data.itemSubtitle),
      textOrNull(data.productSummary),
      data.gradedCard && typeof data.gradedCard === "object" ? JSON.stringify(data.gradedCard) : null,
      event.timing.recordedAt,
      event.streamVersion,
    ],
  );
}

async function projectListingPrice(db: PgQueryable, event: Transport): Promise<void> {
  const data = record(event.data);
  await db.query(
    `UPDATE channels_listing_publication_facts
     SET price_amount=$2, price_currency_code=$3, updated_at=$4, listing_stream_version=$5
     WHERE listing_id=$1 AND listing_stream_version < $5`,
    [
      listingId(event),
      data.priceAmount,
      typeof data.priceCurrencyCode === "string" ? data.priceCurrencyCode : null,
      event.timing.recordedAt,
      event.streamVersion,
    ],
  );
}

async function projectListingQuantity(db: PgQueryable, event: Transport): Promise<void> {
  const data = record(event.data);
  await db.query(
    `UPDATE channels_listing_publication_facts
     SET quantity_cap=$2, price_amount=$3, price_currency_code=$4, updated_at=$5, listing_stream_version=$6
     WHERE listing_id=$1 AND listing_stream_version < $6`,
    [
      listingId(event),
      data.quantityCap,
      data.priceAmount,
      typeof data.priceCurrencyCode === "string" ? data.priceCurrencyCode : null,
      event.timing.recordedAt,
      event.streamVersion,
    ],
  );
}

async function projectListingStatus(
  db: PgQueryable,
  event: Transport,
  status: "active" | "paused" | "withdrawn" | "auto-unlisted",
  pauseReason: string | null,
): Promise<void> {
  await db.query(
    `UPDATE channels_listing_publication_facts
     SET listing_status=$2, pause_reason=$3, updated_at=$4, listing_stream_version=$5
     WHERE listing_id=$1 AND listing_stream_version < $5`,
    [listingId(event), status, pauseReason, event.timing.recordedAt, event.streamVersion],
  );
}

async function projectAvailability(
  db: PgQueryable,
  event: Transport,
  status: "available" | "unavailable",
): Promise<void> {
  const data = record(event.data);
  await db.query(
    `INSERT INTO channels_seller_availability_facts
       (account_id,status,reason_category,available_again_at,updated_at,availability_stream_version)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (account_id) DO UPDATE SET status=EXCLUDED.status, reason_category=EXCLUDED.reason_category,
       available_again_at=EXCLUDED.available_again_at, updated_at=EXCLUDED.updated_at,
       availability_stream_version=EXCLUDED.availability_stream_version
     WHERE channels_seller_availability_facts.availability_stream_version < EXCLUDED.availability_stream_version`,
    [
      data.accountId,
      status,
      status === "unavailable" ? textOrNull(data.reasonCategory) : null,
      status === "unavailable" ? textOrNull(data.availableAgainAt) : null,
      event.timing.recordedAt,
      event.streamVersion,
    ],
  );
}

async function projectCategory(db: PgQueryable, event: Transport, assigned: boolean): Promise<void> {
  const data = record(event.data);
  await db.query(
    `INSERT INTO channels_catalog_item_category_facts
       (catalog_item_id,category_id,assigned,updated_at,catalog_item_stream_version)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (catalog_item_id,category_id) DO UPDATE SET assigned=EXCLUDED.assigned,
       updated_at=EXCLUDED.updated_at,catalog_item_stream_version=EXCLUDED.catalog_item_stream_version
     WHERE channels_catalog_item_category_facts.catalog_item_stream_version < EXCLUDED.catalog_item_stream_version`,
    [catalogItemId(event), data.categoryId, assigned, event.timing.recordedAt, event.streamVersion],
  );
}

async function projectProductReference(
  db: PgQueryable,
  event: Transport,
  linkState: "linked" | "unlinked",
): Promise<void> {
  const data = record(event.data);
  const selectedOptions = linkState === "linked" ? selections(data.selectedOptions) : [];
  await db.query(
    `INSERT INTO channels_external_product_reference_facts
       (provider_key,external_key,catalog_item_id,selected_options,selected_option_key,link_state,updated_at,reference_stream_version)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)
     ON CONFLICT (provider_key,external_key) DO UPDATE SET catalog_item_id=EXCLUDED.catalog_item_id,
       selected_options=CASE WHEN EXCLUDED.link_state='linked' THEN EXCLUDED.selected_options ELSE channels_external_product_reference_facts.selected_options END,
       selected_option_key=CASE WHEN EXCLUDED.link_state='linked' THEN EXCLUDED.selected_option_key ELSE channels_external_product_reference_facts.selected_option_key END,
       link_state=EXCLUDED.link_state,updated_at=EXCLUDED.updated_at,reference_stream_version=EXCLUDED.reference_stream_version
     WHERE channels_external_product_reference_facts.reference_stream_version < EXCLUDED.reference_stream_version`,
    [
      data.providerKey,
      data.externalKey,
      catalogItemId(event),
      JSON.stringify(selectedOptions),
      deriveChannelSelectedOptionKey(selectedOptions),
      linkState,
      event.timing.recordedAt,
      event.streamVersion,
    ],
  );
}

async function projectCatalogReference(
  db: PgQueryable,
  event: Transport,
  linkState: "linked" | "unlinked",
): Promise<void> {
  const data = record(event.data);
  await db.query(
    `INSERT INTO channels_external_catalog_item_reference_facts
       (provider_key,external_key,catalog_item_id,link_state,updated_at,reference_stream_version)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (provider_key,external_key) DO UPDATE SET catalog_item_id=EXCLUDED.catalog_item_id,
       link_state=EXCLUDED.link_state,updated_at=EXCLUDED.updated_at,reference_stream_version=EXCLUDED.reference_stream_version
     WHERE channels_external_catalog_item_reference_facts.reference_stream_version < EXCLUDED.reference_stream_version`,
    [data.providerKey, data.externalKey, catalogItemId(event), linkState, event.timing.recordedAt, event.streamVersion],
  );
}

async function projectHoldStatus(
  db: PgQueryable,
  event: Transport,
  status: "active" | "released" | "expired" | "consumed",
): Promise<void> {
  const data = record(event.data);
  await db.query(
    `UPDATE channels_inventory_hold_facts SET status=$2,updated_at=$3,hold_stream_version=$4
     WHERE hold_id=$1 AND hold_stream_version < $4`,
    [data.holdId, status, event.timing.recordedAt, event.streamVersion],
  );
}

async function projectConnectionStatus(
  db: PgQueryable,
  event: Transport,
  status: "active" | "paused" | "disconnected",
): Promise<void> {
  const data = record(event.data);
  await db.query(
    `UPDATE channels_connection_facts SET status=$2,updated_at=$3,connection_stream_version=$4
     WHERE connection_id=$1 AND connection_stream_version < $4`,
    [data.connectionId, status, event.timing.recordedAt, event.streamVersion],
  );
}

function listingId(event: Transport): string {
  return event.streamId.replace("marketplace.listing-", "");
}
function catalogItemId(event: Transport): string {
  return event.streamId.replace("catalog.catalog-item-", "");
}
function record(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}
function textOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function selections(value: unknown): Array<{ dimensionId: string; optionId: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const data = record(entry);
    return typeof data.dimensionId === "string" && typeof data.optionId === "string"
      ? [{ dimensionId: data.dimensionId, optionId: data.optionId }]
      : [];
  });
}
