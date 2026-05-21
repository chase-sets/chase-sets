import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { coerceLocalizedTextMap, resolveLocalizedTextMap, type LocalizedTextMap } from "@chase-sets/localization";
import { extractIdFromStreamId } from "../../../support/projection-support/extract-id-from-stream";

const STREAM_PREFIX = "catalog.dimension-";

export function buildDimensionProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.dimension.created": async (event) => {
      const { dimensionId, key, name, description, valueKind } = event.data as {
        dimensionId: string;
        key: string;
        name: LocalizedTextMap | string;
        description: LocalizedTextMap | string;
        valueKind?: string;
      };
      const nameI18n = coerceLocalizedTextMap(name);
      const descriptionI18n = coerceLocalizedTextMap(description ?? "");

      await db.query(
        `INSERT INTO catalog_dimensions (dimension_id, key, name_i18n, name, description_i18n, description, value_kind, status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8)
         ON CONFLICT (dimension_id) DO UPDATE SET key = $2, name_i18n = $3, name = $4, description_i18n = $5, description = $6, value_kind = $7, updated_at = $8`,
        [
          dimensionId,
          key,
          JSON.stringify(nameI18n),
          resolveLocalizedTextMap(nameI18n),
          JSON.stringify(descriptionI18n),
          resolveLocalizedTextMap(descriptionI18n),
          valueKind ?? "unordered",
          event.timing.recordedAt,
        ],
      );
    },

    "catalog.dimension.revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { key, name, description, valueKind } = event.data as {
        key: string;
        name: LocalizedTextMap | string;
        description: LocalizedTextMap | string;
        valueKind?: string;
      };
      const nameI18n = coerceLocalizedTextMap(name);
      const descriptionI18n = coerceLocalizedTextMap(description ?? "");

      await db.query(
        `UPDATE catalog_dimensions
         SET key = $2, name_i18n = $3, name = $4, description_i18n = $5, description = $6, value_kind = COALESCE($7, value_kind), updated_at = $8
         WHERE dimension_id = $1`,
        [
          dimensionId,
          key,
          JSON.stringify(nameI18n),
          resolveLocalizedTextMap(nameI18n),
          JSON.stringify(descriptionI18n),
          resolveLocalizedTextMap(descriptionI18n),
          valueKind ?? null,
          event.timing.recordedAt,
        ],
      );
    },

    "catalog.dimension.option-added": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { optionId, code, label, labels, displayOrder, numericValue, status } = event.data as {
        optionId: string;
        code: string;
        label?: LocalizedTextMap | string;
        labels?: unknown;
        displayOrder: number;
        numericValue: number | null;
        status: string;
      };
      const labelI18n = coerceDimensionOptionLabel(label ?? labels);

      await db.query(
        `INSERT INTO catalog_dimension_options (option_id, dimension_id, code, label_i18n, label, display_order, numeric_value, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (dimension_id, option_id) DO UPDATE
         SET code = $3, label_i18n = $4, label = $5, display_order = $6, numeric_value = $7, status = $8`,
        [
          optionId,
          dimensionId,
          code,
          JSON.stringify(labelI18n),
          resolveLocalizedTextMap(labelI18n),
          displayOrder,
          numericValue,
          status,
        ],
      );
    },

    "catalog.dimension.option-revised": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { optionId, code, label, labels, displayOrder, numericValue, status } = event.data as {
        optionId: string;
        code: string;
        label?: LocalizedTextMap | string;
        labels?: unknown;
        displayOrder: number;
        numericValue: number | null;
        status: string;
      };
      const labelI18n = coerceDimensionOptionLabel(label ?? labels);

      await db.query(
        `UPDATE catalog_dimension_options
         SET code = $3, label_i18n = $4, label = $5, display_order = $6, numeric_value = $7, status = $8
         WHERE dimension_id = $1 AND option_id = $2`,
        [
          dimensionId,
          optionId,
          code,
          JSON.stringify(labelI18n),
          resolveLocalizedTextMap(labelI18n),
          displayOrder,
          numericValue,
          status,
        ],
      );
    },

    "catalog.dimension.options-reordered": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { optionIds } = event.data as { optionIds: string[] };

      for (let i = 0; i < optionIds.length; i++) {
        await db.query(
          `UPDATE catalog_dimension_options SET display_order = $3 WHERE dimension_id = $1 AND option_id = $2`,
          [dimensionId, optionIds[i], i],
        );
      }
    },

    "catalog.dimension.option-deprecated": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { optionId } = event.data as { optionId: string };

      await db.query(
        `UPDATE catalog_dimension_options SET status = 'deprecated' WHERE dimension_id = $1 AND option_id = $2`,
        [dimensionId, optionId],
      );
    },

    "catalog.dimension.option-reactivated": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { optionId } = event.data as { optionId: string };

      await db.query(
        `UPDATE catalog_dimension_options SET status = 'active' WHERE dimension_id = $1 AND option_id = $2`,
        [dimensionId, optionId],
      );
    },

    "catalog.dimension.activated": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(`UPDATE catalog_dimensions SET status = 'active', updated_at = $2 WHERE dimension_id = $1`, [
        dimensionId,
        event.timing.recordedAt,
      ]);
    },

    "catalog.dimension.deprecated": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(`UPDATE catalog_dimensions SET status = 'deprecated', updated_at = $2 WHERE dimension_id = $1`, [
        dimensionId,
        event.timing.recordedAt,
      ]);
    },

    "catalog.dimension.archived": async (event) => {
      const dimensionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);

      await db.query(`UPDATE catalog_dimensions SET status = 'archived', updated_at = $2 WHERE dimension_id = $1`, [
        dimensionId,
        event.timing.recordedAt,
      ]);
    },
  };
}

function coerceDimensionOptionLabel(value: unknown): LocalizedTextMap {
  if (Array.isArray(value)) {
    return coerceLocalizedTextMap({
      defaultLocale: "en",
      values: Object.fromEntries(
        value
          .map((entry) => {
            if (typeof entry !== "object" || entry === null) {
              return null;
            }

            const candidate = entry as { locale?: unknown; value?: unknown };
            return typeof candidate.locale === "string" && typeof candidate.value === "string"
              ? [candidate.locale, candidate.value]
              : null;
          })
          .filter((entry): entry is [string, string] => entry !== null),
      ),
    });
  }

  return coerceLocalizedTextMap(value);
}
