import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  coerceLocalizedTextMap,
  resolveLocalizedTextMap,
  type LocalizedTextMap,
} from "@chase-sets/localization";
import { extractIdFromStreamId } from "../../../support/projection-support/extract-id-from-stream";

const REFERENCE_TYPE_STREAM_PREFIX = "catalog.reference-type-";
const REFERENCE_RECORD_STREAM_PREFIX = "catalog.reference-record-";

export function buildReferenceDataProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.reference-type.created": async (event) => {
      const { referenceTypeId, key, name, description, attributeKeys } = event.data as {
        referenceTypeId: string;
        key: string;
        name: LocalizedTextMap | string;
        description: LocalizedTextMap | string;
        attributeKeys: unknown;
      };
      const nameI18n = coerceLocalizedTextMap(name);
      const descriptionI18n = coerceLocalizedTextMap(description ?? "");

      await db.query(
        `INSERT INTO catalog_reference_types (
           reference_type_id, key, name_i18n, name, description_i18n, description, attribute_keys, status, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8)
         ON CONFLICT (reference_type_id) DO UPDATE SET
           key = EXCLUDED.key,
           name_i18n = EXCLUDED.name_i18n,
           name = EXCLUDED.name,
           description_i18n = EXCLUDED.description_i18n,
           description = EXCLUDED.description,
           attribute_keys = EXCLUDED.attribute_keys,
           updated_at = EXCLUDED.updated_at`,
        [
          referenceTypeId,
          key,
          JSON.stringify(nameI18n),
          resolveLocalizedTextMap(nameI18n),
          JSON.stringify(descriptionI18n),
          resolveLocalizedTextMap(descriptionI18n),
          JSON.stringify(Array.isArray(attributeKeys) ? attributeKeys : []),
          event.timing.recordedAt,
        ],
      );
    },
    "catalog.reference-type.revised": async (event) => {
      const referenceTypeId = extractIdFromStreamId(event.streamId, REFERENCE_TYPE_STREAM_PREFIX);
      const { key, name, description, attributeKeys } = event.data as {
        key: string;
        name: LocalizedTextMap | string;
        description: LocalizedTextMap | string;
        attributeKeys: unknown;
      };
      const nameI18n = coerceLocalizedTextMap(name);
      const descriptionI18n = coerceLocalizedTextMap(description ?? "");

      await db.query(
        `UPDATE catalog_reference_types
         SET key = $2,
             name_i18n = $3,
             name = $4,
             description_i18n = $5,
             description = $6,
             attribute_keys = $7,
             updated_at = $8
         WHERE reference_type_id = $1`,
        [
          referenceTypeId,
          key,
          JSON.stringify(nameI18n),
          resolveLocalizedTextMap(nameI18n),
          JSON.stringify(descriptionI18n),
          resolveLocalizedTextMap(descriptionI18n),
          JSON.stringify(Array.isArray(attributeKeys) ? attributeKeys : []),
          event.timing.recordedAt,
        ],
      );
    },
    "catalog.reference-type.published": async (event) => {
      await setReferenceTypeStatus(db, extractIdFromStreamId(event.streamId, REFERENCE_TYPE_STREAM_PREFIX), "active", event.timing.recordedAt);
    },
    "catalog.reference-type.deprecated": async (event) => {
      await setReferenceTypeStatus(db, extractIdFromStreamId(event.streamId, REFERENCE_TYPE_STREAM_PREFIX), "deprecated", event.timing.recordedAt);
    },
    "catalog.reference-type.archived": async (event) => {
      await setReferenceTypeStatus(db, extractIdFromStreamId(event.streamId, REFERENCE_TYPE_STREAM_PREFIX), "archived", event.timing.recordedAt);
    },

    "catalog.reference-record.created": async (event) => {
      const { referenceRecordId, typeKey, key, name, description, attributes, relationships } = event.data as {
        referenceRecordId: string;
        typeKey: string;
        key: string;
        name: LocalizedTextMap | string;
        description: LocalizedTextMap | string;
        attributes: unknown;
        relationships: unknown;
      };
      const nameI18n = coerceLocalizedTextMap(name);
      const descriptionI18n = coerceLocalizedTextMap(description ?? "");

      await db.query(
        `INSERT INTO catalog_reference_records (
           reference_record_id,
           type_key,
           key,
           name_i18n,
           name,
           description_i18n,
           description,
           attributes,
           relationships,
           status,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft', $10)
         ON CONFLICT (reference_record_id) DO UPDATE SET
           type_key = EXCLUDED.type_key,
           key = EXCLUDED.key,
           name_i18n = EXCLUDED.name_i18n,
           name = EXCLUDED.name,
           description_i18n = EXCLUDED.description_i18n,
           description = EXCLUDED.description,
           attributes = EXCLUDED.attributes,
           relationships = EXCLUDED.relationships,
           updated_at = EXCLUDED.updated_at`,
        [
          referenceRecordId,
          typeKey,
          key,
          JSON.stringify(nameI18n),
          resolveLocalizedTextMap(nameI18n),
          JSON.stringify(descriptionI18n),
          resolveLocalizedTextMap(descriptionI18n),
          JSON.stringify(isRecord(attributes) ? attributes : {}),
          JSON.stringify(Array.isArray(relationships) ? relationships : []),
          event.timing.recordedAt,
        ],
      );
    },
    "catalog.reference-record.revised": async (event) => {
      const referenceRecordId = extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX);
      const { typeKey, key, name, description, attributes, relationships } = event.data as {
        typeKey: string;
        key: string;
        name: LocalizedTextMap | string;
        description: LocalizedTextMap | string;
        attributes: unknown;
        relationships: unknown;
      };
      const nameI18n = coerceLocalizedTextMap(name);
      const descriptionI18n = coerceLocalizedTextMap(description ?? "");

      await db.query(
        `UPDATE catalog_reference_records
         SET type_key = $2,
             key = $3,
             name_i18n = $4,
             name = $5,
             description_i18n = $6,
             description = $7,
             attributes = $8,
             relationships = $9,
             updated_at = $10
         WHERE reference_record_id = $1`,
        [
          referenceRecordId,
          typeKey,
          key,
          JSON.stringify(nameI18n),
          resolveLocalizedTextMap(nameI18n),
          JSON.stringify(descriptionI18n),
          resolveLocalizedTextMap(descriptionI18n),
          JSON.stringify(isRecord(attributes) ? attributes : {}),
          JSON.stringify(Array.isArray(relationships) ? relationships : []),
          event.timing.recordedAt,
        ],
      );
    },
    "catalog.reference-record.published": async (event) => {
      await setReferenceRecordStatus(db, extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX), "active", event.timing.recordedAt);
    },
    "catalog.reference-record.deprecated": async (event) => {
      await setReferenceRecordStatus(db, extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX), "deprecated", event.timing.recordedAt);
    },
    "catalog.reference-record.archived": async (event) => {
      await setReferenceRecordStatus(db, extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX), "archived", event.timing.recordedAt);
    },
  };
}

async function setReferenceTypeStatus(
  db: PgQueryable,
  referenceTypeId: string,
  status: string,
  updatedAt: string,
): Promise<void> {
  await db.query(
    `UPDATE catalog_reference_types SET status = $2, updated_at = $3 WHERE reference_type_id = $1`,
    [referenceTypeId, status, updatedAt],
  );
}

async function setReferenceRecordStatus(
  db: PgQueryable,
  referenceRecordId: string,
  status: string,
  updatedAt: string,
): Promise<void> {
  await db.query(
    `UPDATE catalog_reference_records SET status = $2, updated_at = $3 WHERE reference_record_id = $1`,
    [referenceRecordId, status, updatedAt],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
