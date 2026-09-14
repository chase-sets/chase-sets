import type { PgQueryable } from "@chase-sets/event-core-postgres";

export const channelExternalSaleUnmappableReasons = [
  "link-not-found",
  "duplicate-link",
  "account-mismatch",
  "item-not-found",
  "storage-location-not-found",
  "storage-location-not-bound",
] as const;
export type ChannelExternalSaleUnmappableReason = (typeof channelExternalSaleUnmappableReasons)[number];

export type ChannelExternalSaleTarget =
  | Readonly<{
      kind: "mapped";
      accountId: string;
      channelListingId: string;
      listingId: string;
      inventoryItemId: string;
      storageLocationId: string;
    }>
  | Readonly<{ kind: "unmappable"; reason: ChannelExternalSaleUnmappableReason }>;

export async function resolveChannelExternalSaleTarget(
  db: PgQueryable,
  input: Readonly<{ connectionId: string; externalListingId: string; externalOfferId: string | null }>,
): Promise<ChannelExternalSaleTarget> {
  const result = await db.query<{
    connection_account_id: string;
    link_account_id: string;
    listing_account_id: string;
    item_account_id: string | null;
    channel_listing_id: string;
    listing_id: string;
    inventory_item_id: string;
    storage_location_id: string | null;
    bindings: unknown;
  }>(
    `SELECT connection.account_id AS connection_account_id,connection_fact.account_id AS link_account_id,
            listing.account_id AS listing_account_id,item.account_id AS item_account_id,
            link.channel_listing_id,link.listing_id,listing.inventory_item_id,item.storage_location_id,
            connection.bindings
     FROM channels_channel_listing_links AS link
     JOIN channel_connections AS connection ON connection.connection_id=link.connection_id
     JOIN channels_connection_facts AS connection_fact ON connection_fact.connection_id=link.connection_id
     JOIN channels_listing_publication_facts AS listing ON listing.listing_id=link.listing_id
     LEFT JOIN channels_inventory_item_facts AS item ON item.item_id=listing.inventory_item_id
     WHERE link.connection_id=$1 AND link.external_listing_id=$2
       AND (($3::text IS NULL AND link.external_offer_id IS NULL) OR link.external_offer_id=$3)
     ORDER BY link.channel_listing_id LIMIT 2`,
    [input.connectionId, input.externalListingId, input.externalOfferId],
  );
  if (result.rows.length === 0) return { kind: "unmappable", reason: "link-not-found" };
  if (result.rows.length > 1) return { kind: "unmappable", reason: "duplicate-link" };
  const row = result.rows[0]!;
  if (row.item_account_id === null) return { kind: "unmappable", reason: "item-not-found" };
  if (
    row.connection_account_id !== row.link_account_id ||
    row.connection_account_id !== row.listing_account_id ||
    row.connection_account_id !== row.item_account_id
  ) {
    return { kind: "unmappable", reason: "account-mismatch" };
  }
  if (!row.storage_location_id) return { kind: "unmappable", reason: "storage-location-not-found" };
  if (!bindingIds(row.bindings).has(row.storage_location_id)) {
    return { kind: "unmappable", reason: "storage-location-not-bound" };
  }
  return {
    kind: "mapped",
    accountId: row.connection_account_id,
    channelListingId: row.channel_listing_id,
    listingId: row.listing_id,
    inventoryItemId: row.inventory_item_id,
    storageLocationId: row.storage_location_id,
  };
}

function bindingIds(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.flatMap((candidate) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return [];
      const id = (candidate as Record<string, unknown>).storageLocationId;
      return typeof id === "string" ? [id] : [];
    }),
  );
}
