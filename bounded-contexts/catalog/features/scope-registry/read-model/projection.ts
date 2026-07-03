import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { coerceLocalizedTextMap, resolveLocalizedTextMap, type LocalizedTextMap } from "@chase-sets/localization";
import type { CatalogLifecycleStatus, CatalogValue } from "../../../support/runtime-support/common";
import {
  catalogScopeProductDomainForProductLineKey,
  catalogScopeRecordKindForReferenceTypeKey,
  extractCatalogScopeRecordAttributes,
  isReferenceTypeKeyAllowedForCatalogScopeProductDomain,
  normalizeCatalogScopeProductDomain,
  type CatalogScopeProductDomain,
  type CatalogScopeRecordKind,
} from "../domain/contract";

const REFERENCE_RECORD_STREAM_PREFIX = "catalog.reference-record-";

type ReferenceRelationship = Readonly<{
  relationshipType: string;
  referenceId: string;
}>;

type ReferenceRecordProjectionSnapshot = Readonly<{
  referenceRecordId: string;
  typeKey: string;
  key: string;
  name: LocalizedTextMap | string;
  attributes: Readonly<Record<string, CatalogValue>>;
  relationships: readonly ReferenceRelationship[];
  status?: CatalogLifecycleStatus;
}>;

type ParentScopeRecordRow = Readonly<{
  scope_record_id: string;
  reference_record_id: string;
  product_domain: CatalogScopeProductDomain;
  scope_kind: CatalogScopeRecordKind;
  product_line_scope_record_id: string | null;
  series_scope_record_id: string | null;
}>;

type ReferenceRecordReadModelRow = Readonly<{
  reference_record_id: string;
  type_key: string;
  key: string;
  name_i18n: unknown;
  name: string;
  attributes: unknown;
  relationships: unknown;
  status: CatalogLifecycleStatus;
  updated_at: string;
}>;

export function buildCatalogScopeRegistryProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.reference-record.created": async (event) => {
      await projectReferenceRecordSnapshot(db, snapshotFromEventData(event.data), "draft", event.timing.recordedAt);
    },
    "catalog.reference-record.revised": async (event) => {
      await projectReferenceRecordSnapshot(
        db,
        {
          ...snapshotFromEventData(event.data),
          referenceRecordId: extractIdFromStreamId(event.streamId, REFERENCE_RECORD_STREAM_PREFIX),
        },
        undefined,
        event.timing.recordedAt,
      );
    },
    "catalog.reference-record.published": async (event) => {
      await setCatalogScopeRecordStatus(db, event.streamId, "active", event.timing.recordedAt);
    },
    "catalog.reference-record.deprecated": async (event) => {
      await setCatalogScopeRecordStatus(db, event.streamId, "deprecated", event.timing.recordedAt);
    },
    "catalog.reference-record.archived": async (event) => {
      await setCatalogScopeRecordStatus(db, event.streamId, "archived", event.timing.recordedAt);
    },
  };
}

async function projectReferenceRecordSnapshot(
  db: PgQueryable,
  snapshot: ReferenceRecordProjectionSnapshot,
  lifecycleStatus: CatalogLifecycleStatus | undefined,
  updatedAt: string,
  visitedReferenceRecordIds: Set<string> = new Set(),
): Promise<void> {
  if (visitedReferenceRecordIds.has(snapshot.referenceRecordId)) {
    return;
  }
  visitedReferenceRecordIds.add(snapshot.referenceRecordId);

  const projection = await buildScopeRecordProjection(db, snapshot, lifecycleStatus);
  if (projection) {
    await upsertScopeRecord(db, projection, updatedAt);
  }

  await refreshDependentScopeRecords(db, snapshot.referenceRecordId, updatedAt, visitedReferenceRecordIds);
}

async function buildScopeRecordProjection(
  db: PgQueryable,
  snapshot: ReferenceRecordProjectionSnapshot,
  lifecycleStatus: CatalogLifecycleStatus | undefined,
) {
  const scopeKind = catalogScopeRecordKindForReferenceTypeKey(snapshot.typeKey);
  if (!scopeKind) {
    return null;
  }

  const parent = await resolveParentScopeRecord(db, snapshot.relationships);
  const explicitProductDomain = normalizeCatalogScopeProductDomain(
    stringAttribute(snapshot.attributes["product-domain"]),
  );
  const productDomain =
    scopeKind === "product-line"
      ? (catalogScopeProductDomainForProductLineKey(snapshot.key) ?? explicitProductDomain)
      : (parent?.product_domain ?? explicitProductDomain);

  if (!productDomain || !isReferenceTypeKeyAllowedForCatalogScopeProductDomain(productDomain, snapshot.typeKey)) {
    return null;
  }

  const nameI18n = coerceLocalizedTextMap(snapshot.name);
  const scopeAttributes = extractCatalogScopeRecordAttributes(snapshot.attributes);
  const productLineScopeRecordId =
    scopeKind === "product-line"
      ? snapshot.referenceRecordId
      : parent?.scope_kind === "product-line"
        ? parent.scope_record_id
        : (parent?.product_line_scope_record_id ?? null);
  const seriesScopeRecordId =
    scopeKind === "series"
      ? snapshot.referenceRecordId
      : parent?.scope_kind === "series"
        ? parent.scope_record_id
        : (parent?.series_scope_record_id ?? null);

  return {
    scopeRecordId: snapshot.referenceRecordId,
    productDomain,
    scopeKind,
    referenceTypeKey: snapshot.typeKey,
    referenceRecordId: snapshot.referenceRecordId,
    referenceRecordKey: snapshot.key,
    nameI18n,
    name: resolveLocalizedTextMap(nameI18n),
    parentScopeRecordId: parent?.scope_record_id ?? null,
    productLineScopeRecordId,
    seriesScopeRecordId,
    releaseDate: scopeAttributes.releaseDate,
    officialSetCode: scopeAttributes.officialSetCode,
    languageEditions: scopeAttributes.languageEditions,
    attributes: snapshot.attributes,
    relationships: snapshot.relationships,
    lifecycleStatus,
  } as const;
}

async function resolveParentScopeRecord(
  db: PgQueryable,
  relationships: readonly ReferenceRelationship[],
): Promise<ParentScopeRecordRow | null> {
  const parentReferenceIds = relationships
    .filter((relationship) => relationship.relationshipType === "part-of")
    .map((relationship) => relationship.referenceId);
  if (parentReferenceIds.length === 0) {
    return null;
  }

  const result = await db.query<ParentScopeRecordRow>(
    `SELECT scope_record_id,
            reference_record_id,
            product_domain,
            scope_kind,
            product_line_scope_record_id,
            series_scope_record_id
     FROM catalog_scope_records
     WHERE reference_record_id = ANY($1::text[])
     ORDER BY CASE scope_kind
       WHEN 'series' THEN 0
       WHEN 'product-line' THEN 1
       ELSE 2
     END,
     scope_record_id ASC`,
    [[...new Set(parentReferenceIds)]],
  );

  return result.rows[0] ?? null;
}

async function upsertScopeRecord(
  db: PgQueryable,
  projection: NonNullable<Awaited<ReturnType<typeof buildScopeRecordProjection>>>,
  updatedAt: string,
): Promise<void> {
  await db.query(
    `INSERT INTO catalog_scope_records (
       scope_record_id,
       product_domain,
       scope_kind,
       reference_type_key,
       reference_record_id,
       reference_record_key,
       name_i18n,
       name,
       parent_scope_record_id,
       product_line_scope_record_id,
       series_scope_record_id,
       release_date,
       official_set_code,
       language_editions,
       attributes,
       relationships,
       lifecycle_status,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date, $13, $14, $15, $16, COALESCE($17, 'draft'), $18)
     ON CONFLICT (scope_record_id) DO UPDATE SET
       product_domain = EXCLUDED.product_domain,
       scope_kind = EXCLUDED.scope_kind,
       reference_type_key = EXCLUDED.reference_type_key,
       reference_record_id = EXCLUDED.reference_record_id,
       reference_record_key = EXCLUDED.reference_record_key,
       name_i18n = EXCLUDED.name_i18n,
       name = EXCLUDED.name,
       parent_scope_record_id = EXCLUDED.parent_scope_record_id,
       product_line_scope_record_id = EXCLUDED.product_line_scope_record_id,
       series_scope_record_id = EXCLUDED.series_scope_record_id,
       release_date = EXCLUDED.release_date,
       official_set_code = EXCLUDED.official_set_code,
       language_editions = EXCLUDED.language_editions,
       attributes = EXCLUDED.attributes,
       relationships = EXCLUDED.relationships,
       lifecycle_status = COALESCE(EXCLUDED.lifecycle_status, catalog_scope_records.lifecycle_status),
       updated_at = EXCLUDED.updated_at`,
    [
      projection.scopeRecordId,
      projection.productDomain,
      projection.scopeKind,
      projection.referenceTypeKey,
      projection.referenceRecordId,
      projection.referenceRecordKey,
      JSON.stringify(projection.nameI18n),
      projection.name,
      projection.parentScopeRecordId,
      projection.productLineScopeRecordId,
      projection.seriesScopeRecordId,
      projection.releaseDate,
      projection.officialSetCode,
      JSON.stringify(projection.languageEditions),
      JSON.stringify(projection.attributes),
      JSON.stringify(projection.relationships),
      projection.lifecycleStatus ?? null,
      updatedAt,
    ],
  );
}

async function setCatalogScopeRecordStatus(
  db: PgQueryable,
  streamId: string,
  lifecycleStatus: CatalogLifecycleStatus,
  updatedAt: string,
): Promise<void> {
  const referenceRecordId = extractIdFromStreamId(streamId, REFERENCE_RECORD_STREAM_PREFIX);
  await db.query(
    `UPDATE catalog_scope_records
     SET lifecycle_status = $2,
         updated_at = $3
     WHERE reference_record_id = $1`,
    [referenceRecordId, lifecycleStatus, updatedAt],
  );
}

async function refreshDependentScopeRecords(
  db: PgQueryable,
  parentReferenceRecordId: string,
  updatedAt: string,
  visitedReferenceRecordIds: Set<string>,
): Promise<void> {
  const result = await db.query<ReferenceRecordReadModelRow>(
    `SELECT reference_record_id,
            type_key,
            key,
            name_i18n,
            name,
            attributes,
            relationships,
            status,
            updated_at
     FROM catalog_reference_records
     WHERE relationships @> $1::jsonb
     ORDER BY type_key ASC, key ASC`,
    [JSON.stringify([{ referenceId: parentReferenceRecordId }])],
  );

  for (const row of result.rows) {
    await projectReferenceRecordSnapshot(
      db,
      {
        referenceRecordId: row.reference_record_id,
        typeKey: row.type_key,
        key: row.key,
        name: row.name,
        attributes: recordFromUnknown(row.attributes),
        relationships: relationshipsFromUnknown(row.relationships),
        status: row.status,
      },
      row.status,
      row.updated_at ?? updatedAt,
      visitedReferenceRecordIds,
    );
  }
}

function snapshotFromEventData(data: unknown): ReferenceRecordProjectionSnapshot {
  const eventData = recordFromUnknown(data);
  return {
    referenceRecordId: stringAttribute(eventData.referenceRecordId) ?? "",
    typeKey: stringAttribute(eventData.typeKey) ?? "",
    key: stringAttribute(eventData.key) ?? "",
    name: typeof eventData.name === "string" || isRecord(eventData.name) ? (eventData.name as LocalizedTextMap) : "",
    attributes: recordFromUnknown(eventData.attributes),
    relationships: relationshipsFromUnknown(eventData.relationships),
  };
}

function relationshipsFromUnknown(value: unknown): readonly ReferenceRelationship[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!isRecord(entry)) {
        return null;
      }
      const relationshipType = stringAttribute(entry.relationshipType);
      const referenceId = stringAttribute(entry.referenceId);
      return relationshipType && referenceId ? { relationshipType, referenceId } : null;
    })
    .filter((entry): entry is ReferenceRelationship => entry !== null);
}

function recordFromUnknown(value: unknown): Record<string, CatalogValue> {
  return isRecord(value) ? (value as Record<string, CatalogValue>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAttribute(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
