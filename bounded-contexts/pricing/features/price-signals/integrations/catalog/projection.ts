import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId, type PgQueryable } from "@chase-sets/event-core-postgres";

const ITEM_STREAM_PREFIX = "catalog.item-";

export type PricingSelectedOptionEntry = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

export function derivePricingCatalogProductKey(
  catalogItemId: string,
  selectedOptions: readonly PricingSelectedOptionEntry[],
): string {
  const entries = selectedOptions
    .map((entry) => ({
      dimensionId: entry.dimensionId.trim(),
      optionId: entry.optionId.trim(),
    }))
    .filter((entry) => entry.dimensionId && entry.optionId)
    .sort(
      (left, right) => left.dimensionId.localeCompare(right.dimensionId) || left.optionId.localeCompare(right.optionId),
    );

  if (entries.length === 0) {
    return `${catalogItemId}::`;
  }

  return `${catalogItemId}::${entries.map((entry) => `${entry.dimensionId}:${entry.optionId}`).join("|")}`;
}

function parseSelectedOptions(value: unknown): PricingSelectedOptionEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return null;
      }
      const record = entry as Record<string, unknown>;
      const dimensionId = typeof record.dimensionId === "string" ? record.dimensionId : "";
      const optionId = typeof record.optionId === "string" ? record.optionId : "";
      if (!dimensionId.trim() || !optionId.trim()) {
        return null;
      }
      return { dimensionId, optionId };
    })
    .filter((entry): entry is PricingSelectedOptionEntry => entry !== null);
}

export function buildPricingPriceSignalCatalogProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.catalog-item.external-product-reference-linked": async (event) => {
      const catalogItemId = extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX);
      const data = event.data as {
        providerKey: string;
        externalKey: string;
        selectedOptions: unknown;
      };
      const selectedOptions = parseSelectedOptions(data.selectedOptions);

      await db.query(
        `INSERT INTO pricing_external_product_reference_inputs (
           provider_key,
           external_key,
           catalog_item_id,
           catalog_product_key,
           selected_options,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (provider_key, external_key) DO UPDATE SET
           catalog_item_id = EXCLUDED.catalog_item_id,
           catalog_product_key = EXCLUDED.catalog_product_key,
           selected_options = EXCLUDED.selected_options,
           updated_at = EXCLUDED.updated_at`,
        [
          data.providerKey,
          data.externalKey,
          catalogItemId,
          derivePricingCatalogProductKey(catalogItemId, selectedOptions),
          JSON.stringify(selectedOptions),
          event.timing.recordedAt,
        ],
      );
    },
    "catalog.catalog-item.external-product-reference-unlinked": async (event) => {
      const data = event.data as {
        providerKey: string;
        externalKey: string;
      };

      await db.query(
        `DELETE FROM pricing_external_product_reference_inputs
         WHERE provider_key = $1
           AND external_key = $2`,
        [data.providerKey, data.externalKey],
      );
    },
  };
}
