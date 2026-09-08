import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  parseMoney,
  parseResolveEconomicsRequest,
  requireRfc3339Instant,
  type ResolveEconomicsRequest,
} from "../domain/contracts";
import type { InventoryCostLot } from "../domain/derivation";
import type { AcquisitionLotObservation, SaleObservation } from "../domain/observations";
import { canonicalSha256 } from "../domain/revision";
import type { EconomicsEvidenceReader, EconomicsEvidenceSnapshot } from "../domain/resolution";

export const economicsInventoryCheckpointKey = "pricing-inventory-input-projection:inventory:v3";
export const economicsSalesCheckpointKey = "pricing-market-trades-projection:ordering:v2";

const NO_SOURCE_OBSERVATION_AT = "1970-01-01T00:00:00Z";

type AcquisitionRow = Readonly<{
  account_id: string;
  inventory_item_id: string;
  event_stream_version: number;
  quantity: number;
  occurrence_kind: string;
  acquired_at: string | null;
  occurrence_source: string | null;
  last_source_event_id: string;
}>;

type SaleRow = Readonly<{
  order_id: string;
  line_id: string;
  seller_account_id: string;
  inventory_item_id: string | null;
  quantity: number;
  sold_at: string;
  excluded: boolean;
}>;

type CostRow = Readonly<{
  item_id: string;
  seller_account_id: string;
  total_quantity: number;
  acquisition_cost_amount: string | null;
  updated_at: string;
  last_stream_version: number;
}>;

type CheckpointRow = Readonly<{
  checkpoint_key: string;
  last_global_position: string | number | bigint;
  updated_at: string;
}>;

export function createPostgresEconomicsEvidenceReader(db: PgQueryable): EconomicsEvidenceReader {
  return {
    resolve: async (rawRequest: ResolveEconomicsRequest): Promise<EconomicsEvidenceSnapshot> => {
      const request = parseResolveEconomicsRequest(rawRequest);
      const [acquisitionResult, saleResult, costResult, checkpointResult] = await Promise.all([
        db.query<AcquisitionRow>(
          `SELECT
             acquisition.account_id,
             acquisition.inventory_item_id,
             acquisition.event_stream_version,
             acquisition.quantity,
             acquisition.occurrence_kind,
             acquisition.acquired_at::text,
             acquisition.occurrence_source,
             acquisition.last_source_event_id
           FROM pricing_inventory_acquisition_lots AS acquisition
           WHERE acquisition.account_id = $1
             AND acquisition.last_source_event_recorded_at <= $2::timestamptz
             AND (acquisition.acquired_at IS NULL OR acquisition.acquired_at <= $2::timestamptz)
           ORDER BY acquisition.acquired_at ASC NULLS LAST,
                    acquisition.inventory_item_id ASC,
                    acquisition.event_stream_version ASC`,
          [request.accountId, request.effectiveAt],
        ),
        db.query<SaleRow>(
          `SELECT
             trade.order_id,
             trade.line_id,
             trade.seller_account_id,
             trade.inventory_item_id,
             trade.quantity,
             trade.sold_at::text,
             trade.excluded
           FROM pricing_market_trades AS trade
           WHERE trade.seller_account_id = $1
             AND trade.sold_at IS NOT NULL
             AND trade.sold_at <= $2::timestamptz
           ORDER BY trade.sold_at ASC, trade.order_id ASC, trade.line_id ASC`,
          [request.accountId, request.effectiveAt],
        ),
        db.query<CostRow>(
          `SELECT
             inventory_item.item_id,
             inventory_item.seller_account_id,
             inventory_item.total_quantity,
             inventory_item.acquisition_cost_amount::text,
             inventory_item.updated_at::text,
             inventory_item.last_stream_version
           FROM pricing_inventory_item_inputs AS inventory_item
           WHERE inventory_item.seller_account_id = $1
             AND inventory_item.item_id = $2
             AND inventory_item.catalog_catalog_item_id = $3
             AND inventory_item.total_quantity > 0
             AND inventory_item.updated_at <= $4::timestamptz`,
          [request.accountId, request.inventoryItemId, request.catalogItemId, request.effectiveAt],
        ),
        db.query<CheckpointRow>(
          `SELECT
             checkpoint.checkpoint_key,
             checkpoint.last_global_position,
             checkpoint.updated_at::text
           FROM event_subscription_checkpoints AS checkpoint
           WHERE checkpoint.checkpoint_key = ANY($1::text[])
             AND checkpoint.updated_at <= $2::timestamptz
           ORDER BY checkpoint.checkpoint_key ASC`,
          [[economicsInventoryCheckpointKey, economicsSalesCheckpointKey], request.effectiveAt],
        ),
      ]);

      const checkpoints = parseCheckpoints(checkpointResult.rows, request.effectiveAt);
      return {
        acquisitions: acquisitionResult.rows.map(parseAcquisition),
        sales: saleResult.rows.map((row) => parseSale(row, request.marketUnitPrice.currency)),
        costLots: costResult.rows.map((row) => parseCost(row, request.marketUnitPrice.currency)),
        inventoryWatermark: checkpoints.inventory.watermark,
        pricingWatermark: checkpoints.sales.watermark,
        inventoryObservedAt: checkpoints.inventory.observedAt,
        pricingObservedAt: checkpoints.sales.observedAt,
      };
    },
  };
}

function parseAcquisition(row: AcquisitionRow): AcquisitionLotObservation {
  const lotId = identity(row.last_source_event_id, "acquisition source event id");
  const occurrence = (() => {
    if (row.occurrence_kind === "unknown") {
      if (row.acquired_at !== null || row.occurrence_source !== null) {
        throw new Error(`Unknown acquisition ${lotId} cannot carry occurrence coordinates.`);
      }
      return { kind: "unknown" } as const;
    }
    if (row.occurrence_kind !== "occurred" || row.acquired_at === null) {
      throw new Error(`Acquisition ${lotId} has an invalid occurrence posture.`);
    }
    if (row.occurrence_source !== "seller-supplied" && row.occurrence_source !== "import-supplied") {
      throw new Error(`Acquisition ${lotId} has an unknown occurrence source.`);
    }
    return {
      kind: "occurred",
      occurredAt: databaseInstant(row.acquired_at, `Acquisition ${lotId} acquiredAt`),
      source: row.occurrence_source,
    } as const;
  })();
  return {
    accountId: identity(row.account_id, "acquisition account id"),
    inventoryItemId: identity(row.inventory_item_id, "acquisition inventory item id"),
    lotId,
    quantity: positiveInteger(row.quantity, `Acquisition ${lotId} quantity`),
    occurrence,
  };
}

function parseSale(row: SaleRow, currency: string): SaleObservation {
  const orderId = identity(row.order_id, "sale order id");
  const lineId = identity(row.line_id, "sale line id");
  if (typeof row.excluded !== "boolean") throw new Error(`Sale ${orderId}:${lineId} excluded must be boolean.`);
  return {
    accountId: identity(row.seller_account_id, "sale seller account id"),
    inventoryItemId: row.inventory_item_id === null ? null : identity(row.inventory_item_id, "sale inventory item id"),
    saleId: `${orderId}:${lineId}`,
    quantity: positiveInteger(row.quantity, `Sale ${orderId}:${lineId} quantity`),
    soldAt: databaseInstant(row.sold_at, `Sale ${orderId}:${lineId} soldAt`),
    currency,
    excluded: row.excluded,
  };
}

function parseCost(row: CostRow, currency: string): InventoryCostLot {
  const itemId = identity(row.item_id, "cost inventory item id");
  const observedAt = databaseInstant(row.updated_at, `Cost ${itemId} observedAt`);
  const quantity = positiveInteger(row.total_quantity, `Cost ${itemId} quantity`);
  const cost =
    row.acquisition_cost_amount === null
      ? null
      : parseMoney({ amount: row.acquisition_cost_amount, currency }, `Cost ${itemId} acquisitionCostPerUnit`);
  return {
    accountId: identity(row.seller_account_id, "cost seller account id"),
    inventoryItemId: itemId,
    lotId: `${itemId}:v${positiveInteger(row.last_stream_version, `Cost ${itemId} stream version`)}`,
    quantity,
    acquisitionCostPerUnit: cost,
    observedAt,
    revision: canonicalSha256({ itemId, quantity, cost, observedAt, streamVersion: row.last_stream_version }),
  };
}

function parseCheckpoints(rows: readonly CheckpointRow[], effectiveAt: string) {
  const byKey = new Map<string, Readonly<{ watermark: string; observedAt: string }>>();
  for (const row of rows) {
    if (row.checkpoint_key !== economicsInventoryCheckpointKey && row.checkpoint_key !== economicsSalesCheckpointKey) {
      throw new Error(`Economics received an unexpected projection checkpoint ${row.checkpoint_key}.`);
    }
    if (byKey.has(row.checkpoint_key))
      throw new Error(`Economics projection checkpoint ${row.checkpoint_key} is duplicated.`);
    const position = String(row.last_global_position);
    if (!/^(?:0|[1-9]\d*)$/.test(position)) {
      throw new Error(`Economics projection checkpoint ${row.checkpoint_key} has an invalid global position.`);
    }
    const observedAt = databaseInstant(row.updated_at, `${row.checkpoint_key} updatedAt`);
    if (Date.parse(observedAt) > Date.parse(effectiveAt)) {
      throw new Error(`Economics projection checkpoint ${row.checkpoint_key} is later than effectiveAt.`);
    }
    byKey.set(row.checkpoint_key, { watermark: `${row.checkpoint_key}@${position}`, observedAt });
  }
  const missing = (key: string) => ({ watermark: `${key}@0`, observedAt: NO_SOURCE_OBSERVATION_AT });
  return {
    inventory: byKey.get(economicsInventoryCheckpointKey) ?? missing(economicsInventoryCheckpointKey),
    sales: byKey.get(economicsSalesCheckpointKey) ?? missing(economicsSalesCheckpointKey),
  };
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer.`);
  return value;
}

function identity(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`${name} must be non-empty and already trimmed.`);
  }
  return value;
}

function databaseInstant(value: string, name: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a valid database instant.`);
  return requireRfc3339Instant(new Date(parsed).toISOString(), name);
}
