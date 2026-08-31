import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AddressSnapshot } from "@chase-sets/primitives/address-snapshot";
import type { InventoryAdjustmentReason } from "@chase-sets/event-core/public-event-payloads";
import type { GradedCardDetails } from "../domain/domain";
import type { InventoryHoldRow } from "../../holds/read-model/queries";
import {
  summarizeSelectedOptions,
  type InventoryProductSchema,
  type InventorySelectedOptionEntry,
} from "../integrations/catalog/versioning";

export type InventoryItemListRow = Readonly<{
  item_id: string;
  account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  language_code: string | null;
  item_title: string | null;
  item_subtitle: string | null;
  selected_options: readonly InventorySelectedOptionEntry[];
  product_summary: string | null;
  graded_card: GradedCardDetails | null;
  storage_location_id: string;
  storage_location_name: string;
  ship_from_code: string;
  ship_from_address: AddressSnapshot;
  total_quantity: number;
  held_quantity: number;
  available_quantity: number;
  acquisition_cost_amount: string | null;
  created_at: string;
  updated_at: string;
}>;

export type InventoryItemDetailRow = InventoryItemListRow &
  Readonly<{
    holds: readonly InventoryHoldRow[];
    ledger: readonly InventoryItemLedgerRow[];
  }>;

export type InventoryItemLedgerKind =
  | "created"
  | "adjusted"
  | "offline-sale"
  | "hold-placed"
  | "hold-converted"
  | "hold-consumed"
  | "hold-released"
  | "hold-expired"
  | "restock-decision";

export type InventoryItemLedgerRow = Readonly<{
  ledger_entry_id: string;
  item_id: string;
  account_id: string;
  occurred_at: string;
  kind: InventoryItemLedgerKind;
  quantity_delta: number | null;
  hold_quantity: number | null;
  purpose: string | null;
  reason: string;
  reason_code: InventoryAdjustmentReason | null;
  note: string | null;
  sale_price_amount: string | null;
  channel: string | null;
  source_ref: unknown;
  actor: "seller" | "system";
  event_type: string;
  stream_id: string;
  stream_version: number;
  recorded_at: string;
}>;

type BaseInventoryItemRow = Readonly<{
  total_count: number;
  item_id: string;
  account_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  selected_options: unknown;
  graded_card: unknown;
  storage_location_id: string;
  storage_location_name: string;
  ship_from_code: string;
  ship_from_address: unknown;
  total_quantity: number;
  held_quantity: number;
  available_quantity: number;
  acquisition_cost_amount: string | null;
  created_at: string;
  updated_at: string;
}>;

export type InventoryListingStockItemRow = Readonly<{
  item_id: string;
  total_quantity: number;
  held_quantity: number;
  available_quantity: number;
}>;

export type InventoryHoldableItemRow = Readonly<{
  item_id: string;
  account_id: string;
  total_quantity: number;
  held_quantity: number;
  available_quantity: number;
}>;

export type NativeInventoryExportItemRow = Readonly<{
  catalog_item_id: string;
  storage_location_id: string;
  total_quantity: number;
  selected_options: readonly InventorySelectedOptionEntry[];
  acquisition_cost_amount: string | null;
}>;

type CatalogItemSummaryRow = Readonly<{
  catalog_item_id: string;
  language_code: string;
  title: string;
  subtitle: string | null;
  product_schema: unknown;
}>;

async function loadCatalogItemSummaries(db: PgQueryable, catalogItemIds: readonly string[]) {
  if (catalogItemIds.length === 0) {
    return new Map<string, CatalogItemSummaryRow>();
  }

  const tableResult = await db.query<{ table_name: string | null }>(
    `SELECT to_regclass('public.inventory_catalog_items') AS table_name`,
  );

  if (!tableResult.rows[0]?.table_name) {
    return new Map<string, CatalogItemSummaryRow>();
  }

  const result = await db.query<CatalogItemSummaryRow>(
    `SELECT catalog_item_id, language_code, title, subtitle, product_schema
     FROM inventory_catalog_items
     WHERE catalog_item_id = ANY($1::text[])`,
    [catalogItemIds],
  );

  return new Map(result.rows.map((row) => [row.catalog_item_id, row]));
}

function enrichInventoryItemRows(
  rows: readonly BaseInventoryItemRow[],
  catalogItems: ReadonlyMap<string, CatalogItemSummaryRow>,
): InventoryItemListRow[] {
  return rows.map((row) => {
    const { total_count: _totalCount, ...itemRow } = row;
    const catalogItem = catalogItems.get(row.catalog_catalog_item_id);
    const selectedOptions = Array.isArray(row.selected_options)
      ? (row.selected_options as InventorySelectedOptionEntry[])
      : [];
    const productSchema =
      typeof catalogItem?.product_schema === "object" && catalogItem.product_schema !== null
        ? (catalogItem.product_schema as InventoryProductSchema)
        : null;

    return {
      ...itemRow,
      language_code: catalogItem?.language_code ?? null,
      item_title: catalogItem?.title ?? null,
      item_subtitle: catalogItem?.subtitle ?? null,
      selected_options: selectedOptions,
      product_summary: summarizeSelectedOptions(productSchema, selectedOptions) || null,
      graded_card:
        typeof row.graded_card === "object" && row.graded_card !== null ? (row.graded_card as GradedCardDetails) : null,
      ship_from_address:
        typeof row.ship_from_address === "object" && row.ship_from_address !== null
          ? (row.ship_from_address as AddressSnapshot)
          : {
              name: "",
              line1: "",
              city: "",
              state: "",
              postalCode: "",
              country: "US",
            },
    };
  });
}

export async function listInventoryItems(
  db: PgQueryable,
  params: Readonly<{
    accountId: string;
    limit?: number;
    offset?: number;
    catalogItemId?: string | null;
    productId?: string | null;
    storageLocationId?: string | null;
    availability?: "available" | "held" | "out-of-stock" | null;
  }>,
) {
  const limit = Math.max(1, Math.min(params.limit ?? 50, 250));
  const offset = Math.max(0, params.offset ?? 0);
  const catalogItemId = params.catalogItemId?.trim() || null;
  const productId = params.productId?.trim() || null;
  const storageLocationId = params.storageLocationId?.trim() || null;
  const availability = params.availability ?? null;

  const itemsResult = await db.query<BaseInventoryItemRow>(
    `WITH matching_items AS (
         SELECT
           item.item_id,
           item.account_id,
           item.catalog_catalog_item_id,
           item.product_id,
           item.selected_options,
           item.graded_card,
           item.storage_location_id,
           item.total_quantity,
           COALESCE(active_holds.held_quantity, 0) AS held_quantity,
           item.total_quantity - COALESCE(active_holds.held_quantity, 0) AS available_quantity,
           item.acquisition_cost_amount,
           item.created_at,
           item.updated_at,
           COUNT(*) OVER()::integer AS total_count
         FROM inventory_items AS item
         LEFT JOIN LATERAL (
           SELECT SUM(quantity)::integer AS held_quantity
           FROM inventory_holds
           WHERE inventory_holds.item_id = item.item_id
             AND status = 'active'
         ) AS active_holds
           ON true
         WHERE item.account_id = $1
           AND ($4::text IS NULL OR item.catalog_catalog_item_id = $4)
           AND ($5::text IS NULL OR item.product_id = $5)
           AND ($6::text IS NULL OR item.storage_location_id = $6)
           AND (
             $7::text IS NULL
             OR ($7 = 'available' AND item.total_quantity - COALESCE(active_holds.held_quantity, 0) > 0)
             OR ($7 = 'held' AND COALESCE(active_holds.held_quantity, 0) > 0)
             OR ($7 = 'out-of-stock' AND item.total_quantity - COALESCE(active_holds.held_quantity, 0) = 0)
           )
       ),
       paged_items AS (
         SELECT *
         FROM matching_items
         ORDER BY updated_at DESC, item_id ASC
         LIMIT $2
         OFFSET $3
       )
       SELECT
         item.total_count,
         item.item_id,
         item.account_id,
         item.catalog_catalog_item_id,
         item.product_id,
         item.selected_options,
         item.graded_card,
         item.storage_location_id,
         location.name AS storage_location_name,
         location.ship_from_code,
         location.ship_from_address,
         item.total_quantity,
         item.held_quantity,
         item.available_quantity,
         item.acquisition_cost_amount::text AS acquisition_cost_amount,
         item.created_at,
         item.updated_at
       FROM paged_items AS item
       INNER JOIN inventory_storage_locations AS location
         ON location.storage_location_id = item.storage_location_id
       ORDER BY item.updated_at DESC, item.item_id ASC
       `,
    [params.accountId, limit, offset, catalogItemId, productId, storageLocationId, availability],
  );

  const catalogItems = await loadCatalogItemSummaries(db, [
    ...new Set(itemsResult.rows.map((row) => row.catalog_catalog_item_id)),
  ]);
  const items = enrichInventoryItemRows(itemsResult.rows, catalogItems);

  return {
    items,
    total: Number(itemsResult.rows[0]?.total_count ?? 0),
  };
}

export async function listNativeInventoryExportItems(
  db: PgQueryable,
  params: Readonly<{
    accountId: string;
  }>,
): Promise<NativeInventoryExportItemRow[]> {
  const result = await db.query<
    Readonly<{
      catalog_item_id: string;
      storage_location_id: string;
      total_quantity: number;
      selected_options: unknown;
      acquisition_cost_amount: string | null;
    }>
  >(
    `SELECT
       item.catalog_catalog_item_id AS catalog_item_id,
       item.storage_location_id,
       item.total_quantity,
       item.selected_options,
       item.acquisition_cost_amount::text AS acquisition_cost_amount
     FROM inventory_items AS item
     WHERE item.account_id = $1
     ORDER BY item.updated_at DESC, item.item_id ASC`,
    [params.accountId],
  );

  return result.rows.map((row) => ({
    ...row,
    selected_options: Array.isArray(row.selected_options)
      ? (row.selected_options as InventorySelectedOptionEntry[])
      : [],
  }));
}

export async function getInventoryItem(db: PgQueryable, itemId: string, accountId: string) {
  const result = await db.query<BaseInventoryItemRow>(
    `SELECT
       item.item_id,
       item.account_id,
       item.catalog_catalog_item_id,
       item.product_id,
       item.selected_options,
       item.graded_card,
       item.storage_location_id,
       location.name AS storage_location_name,
       location.ship_from_code,
       location.ship_from_address,
       item.total_quantity,
       COALESCE(active_holds.held_quantity, 0) AS held_quantity,
       item.total_quantity - COALESCE(active_holds.held_quantity, 0) AS available_quantity,
       item.acquisition_cost_amount::text AS acquisition_cost_amount,
       item.created_at,
       item.updated_at
     FROM inventory_items AS item
     INNER JOIN inventory_storage_locations AS location
       ON location.storage_location_id = item.storage_location_id
     LEFT JOIN LATERAL (
       SELECT SUM(quantity)::integer AS held_quantity
       FROM inventory_holds
       WHERE inventory_holds.item_id = item.item_id
         AND status = 'active'
     ) AS active_holds
       ON true
     WHERE item.item_id = $1
       AND item.account_id = $2`,
    [itemId, accountId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const holdsResult = await db.query<InventoryHoldRow>(
    `SELECT
       hold_id,
       account_id,
       item_id,
       quantity,
       reason,
       notes,
       purpose,
       source_ref,
       expires_at,
       status,
       created_at,
       updated_at,
       released_at,
       release_reason
     FROM inventory_holds
     WHERE item_id = $1
       AND account_id = $2
     ORDER BY created_at DESC, hold_id DESC`,
    [itemId, accountId],
  );

  const ledgerResult = await db.query<InventoryItemLedgerRow>(
    `SELECT
       ledger_entry_id,
       item_id,
       account_id,
       occurred_at,
       kind,
       quantity_delta,
       hold_quantity,
       purpose,
       reason,
       CASE WHEN kind = 'adjusted' THEN COALESCE(reason_code, 'correction') ELSE reason_code END AS reason_code,
       note,
       sale_price_amount,
       channel,
       source_ref,
       actor,
       event_type,
       stream_id,
       stream_version,
       recorded_at
     FROM inventory_item_ledger
     WHERE item_id = $1
       AND account_id = $2
     ORDER BY occurred_at DESC, ledger_entry_id DESC
     LIMIT 50`,
    [itemId, accountId],
  );

  const catalogItems = await loadCatalogItemSummaries(db, [row.catalog_catalog_item_id]);
  const [enriched] = enrichInventoryItemRows([row], catalogItems);

  return {
    ...enriched,
    holds: holdsResult.rows,
    ledger: ledgerResult.rows,
  } satisfies InventoryItemDetailRow;
}

export async function getInventoryHoldableItem(
  db: PgQueryable,
  params: Readonly<{
    itemId: string;
    accountId: string;
  }>,
): Promise<InventoryHoldableItemRow | null> {
  const result = await db.query<InventoryHoldableItemRow>(
    `SELECT
       item.item_id,
       item.account_id,
       item.total_quantity,
       COALESCE(active_holds.held_quantity, 0)::integer AS held_quantity,
       item.total_quantity - COALESCE(active_holds.held_quantity, 0)::integer AS available_quantity
     FROM inventory_items AS item
     LEFT JOIN LATERAL (
       SELECT SUM(quantity)::integer AS held_quantity
       FROM inventory_holds
       WHERE inventory_holds.item_id = item.item_id
         AND status = 'active'
     ) AS active_holds
       ON true
     WHERE item.item_id = $1
       AND item.account_id = $2`,
    [params.itemId, params.accountId],
  );

  return result.rows[0] ?? null;
}

export async function getInventoryItemForListingStock(
  db: PgQueryable,
  params: Readonly<{
    itemId: string;
    accountId: string;
    catalogItemId: string;
    productId: string;
    selectedOptions: readonly InventorySelectedOptionEntry[];
    gradedCard: GradedCardDetails | null;
    storageLocationId: string;
  }>,
): Promise<InventoryListingStockItemRow | null> {
  const result = await db.query<InventoryListingStockItemRow>(
    `SELECT
       item.item_id,
       item.total_quantity,
       COALESCE(active_holds.held_quantity, 0)::integer AS held_quantity,
       item.total_quantity - COALESCE(active_holds.held_quantity, 0)::integer AS available_quantity
     FROM inventory_items AS item
     LEFT JOIN LATERAL (
       SELECT SUM(quantity)::integer AS held_quantity
       FROM inventory_holds
       WHERE inventory_holds.item_id = item.item_id
         AND status = 'active'
     ) AS active_holds
       ON true
     WHERE item.account_id = $1
       AND item.item_id = $2
       AND item.catalog_catalog_item_id = $3
       AND item.product_id = $4
       AND item.selected_options = $5::jsonb
       AND item.graded_card IS NOT DISTINCT FROM $6::jsonb
       AND item.storage_location_id = $7
     ORDER BY item.created_at ASC, item.item_id ASC
     LIMIT 1`,
    [
      params.accountId,
      params.itemId,
      params.catalogItemId,
      params.productId,
      JSON.stringify(params.selectedOptions),
      params.gradedCard ? JSON.stringify(params.gradedCard) : null,
      params.storageLocationId,
    ],
  );

  return result.rows[0] ?? null;
}
