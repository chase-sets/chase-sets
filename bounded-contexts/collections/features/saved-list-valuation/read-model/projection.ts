import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { SavedListEventPayloads, SavedListProductSelection } from "../../saved-lists/domain";
import { marketPriceEstimatedEventType, type SavedListValuationProjectionFanoutObservation } from "../domain/contracts";
import { decodeMarketPriceEstimated } from "../integrations/pricing/market-price-estimated";

export type SavedListValuationProjectionObserver = Readonly<{
  marketEstimateProjected?: (observation: SavedListValuationProjectionFanoutObservation) => void;
}>;

export function buildSavedListValuationCollectionProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "collections.saved-list.created": async (event) => {
      const data = event.data as SavedListEventPayloads["collections.saved-list.created"];
      await db.query(
        `INSERT INTO collections_saved_list_valuation_lists (
           list_id, owner_account_id, visibility, lifecycle, source_version, changed_at
         ) VALUES ($1, $2, $3, 'active', $4, $5)
         ON CONFLICT (list_id) DO UPDATE SET
           owner_account_id = EXCLUDED.owner_account_id,
           visibility = EXCLUDED.visibility,
           lifecycle = EXCLUDED.lifecycle,
           source_version = EXCLUDED.source_version,
           changed_at = EXCLUDED.changed_at
         WHERE collections_saved_list_valuation_lists.source_version < EXCLUDED.source_version`,
        [data.listId, data.ownerAccountId, data.visibility, event.streamVersion, data.createdAt],
      );
    },
    "collections.saved-list.archived": async (event) => {
      const data = event.data as SavedListEventPayloads["collections.saved-list.archived"];
      await updateList(db, data.listId, event.streamVersion, data.archivedAt, "lifecycle", "archived");
    },
    "collections.saved-list.visibility-changed": async (event) => {
      const data = event.data as SavedListEventPayloads["collections.saved-list.visibility-changed"];
      await updateList(db, data.listId, event.streamVersion, data.changedAt, "visibility", data.visibility);
    },
    "collections.saved-list.line-added": async (event) => {
      const data = event.data as SavedListEventPayloads["collections.saved-list.line-added"];
      await upsertLine(db, {
        listId: data.listId,
        lineId: data.lineId,
        product: data.product,
        trackedQuantity: data.trackedQuantity,
        sourceVersion: event.streamVersion,
        changedAt: data.addedAt,
      });
    },
    "collections.saved-list.line-changed": async (event) => {
      const data = event.data as SavedListEventPayloads["collections.saved-list.line-changed"];
      await db.query(
        `UPDATE collections_saved_list_valuation_lines
         SET tracked_quantity = $3, source_version = $4, changed_at = $5
         WHERE list_id = $1 AND line_id = $2 AND source_version < $4`,
        [data.listId, data.lineId, data.trackedQuantity, event.streamVersion, data.changedAt],
      );
    },
    "collections.saved-list.line-removed": async (event) => {
      const data = event.data as SavedListEventPayloads["collections.saved-list.line-removed"];
      await db.query(
        `UPDATE collections_saved_list_valuation_lines
         SET active = false, source_version = $3, changed_at = $4
         WHERE list_id = $1 AND line_id = $2 AND source_version < $3`,
        [data.listId, data.lineId, event.streamVersion, data.changedAt],
      );
    },
  };
}

export function buildSavedListValuationPricingProjectionHandlers(
  db: PgQueryable,
  observer: SavedListValuationProjectionObserver = {},
): ProjectorHandlerMap {
  return {
    [marketPriceEstimatedEventType]: async (event) => {
      const estimate = decodeMarketPriceEstimated(event.data);
      await db.query(
        `INSERT INTO collections_saved_list_market_estimates (
           catalog_catalog_item_id, product_id, estimate_version, window_started_at, window_ended_at,
           amount, currency_code, band_low_amount, band_high_amount, confidence, estimated_at,
           fresh_until, disclosure, source_global_position, recorded_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::numeric, $15)
         ON CONFLICT (catalog_catalog_item_id, product_id) DO UPDATE SET
           estimate_version = EXCLUDED.estimate_version,
           window_started_at = EXCLUDED.window_started_at,
           window_ended_at = EXCLUDED.window_ended_at,
           amount = EXCLUDED.amount,
           currency_code = EXCLUDED.currency_code,
           band_low_amount = EXCLUDED.band_low_amount,
           band_high_amount = EXCLUDED.band_high_amount,
           confidence = EXCLUDED.confidence,
           estimated_at = EXCLUDED.estimated_at,
           fresh_until = EXCLUDED.fresh_until,
           disclosure = EXCLUDED.disclosure,
           source_global_position = EXCLUDED.source_global_position,
           recorded_at = EXCLUDED.recorded_at
         WHERE collections_saved_list_market_estimates.source_global_position < EXCLUDED.source_global_position`,
        [
          estimate.catalogItemId,
          estimate.productId,
          estimate.estimateVersion,
          estimate.windowStartedAt,
          estimate.windowEndedAt,
          estimate.amount,
          estimate.currencyCode,
          estimate.band?.lowAmount ?? null,
          estimate.band?.highAmount ?? null,
          estimate.confidence,
          estimate.estimatedAt,
          estimate.freshUntil,
          estimate.disclosure,
          event.globalPosition,
          event.timing.recordedAt,
        ],
      );

      if (observer.marketEstimateProjected) {
        const affected = await db.query<{ affected_list_count: string }>(
          `SELECT COUNT(DISTINCT list_id)::text AS affected_list_count
           FROM collections_saved_list_valuation_lines
           WHERE catalog_catalog_item_id = $1 AND product_id = $2 AND active`,
          [estimate.catalogItemId, estimate.productId],
        );
        observer.marketEstimateProjected({
          productId: estimate.productId,
          affectedListCount: Number(affected.rows[0]?.affected_list_count ?? 0),
          strategy: "join-on-read",
        });
      }
    },
  };
}

async function updateList(
  db: PgQueryable,
  listId: string,
  sourceVersion: number,
  changedAt: string,
  column: "lifecycle" | "visibility",
  value: string,
): Promise<void> {
  await db.query(
    `UPDATE collections_saved_list_valuation_lists
     SET ${column} = $2, source_version = $3, changed_at = $4
     WHERE list_id = $1 AND source_version < $3`,
    [listId, value, sourceVersion, changedAt],
  );
}

async function upsertLine(
  db: PgQueryable,
  input: Readonly<{
    listId: string;
    lineId: string;
    product: SavedListProductSelection;
    trackedQuantity: number;
    sourceVersion: number;
    changedAt: string;
  }>,
): Promise<void> {
  await db.query(
    `INSERT INTO collections_saved_list_valuation_lines (
       list_id, line_id, catalog_catalog_item_id, product_id, tracked_quantity, active, source_version, changed_at
     ) VALUES ($1, $2, $3, $4, $5, true, $6, $7)
     ON CONFLICT (list_id, line_id) DO UPDATE SET
       catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
       product_id = EXCLUDED.product_id,
       tracked_quantity = EXCLUDED.tracked_quantity,
       active = true,
       source_version = EXCLUDED.source_version,
       changed_at = EXCLUDED.changed_at
     WHERE collections_saved_list_valuation_lines.source_version < EXCLUDED.source_version`,
    [
      input.listId,
      input.lineId,
      input.product.catalogItemId,
      input.product.productId,
      input.trackedQuantity,
      input.sourceVersion,
      input.changedAt,
    ],
  );
}
