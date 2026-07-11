import type { PgQueryable } from "@chase-sets/event-core-postgres";

export const MAX_REFERENCE_EXPANSION_DEPTH = 4;

// Reference types that carry a set-level natural key across today's provider
// integrations: Magic, Lorcana, and One Piece promote through the "set"
// reference type; Pokemon has no top-level "set" concept and promotes through
// "expansion" instead (see provider-integration-profiles.ts reference hierarchy
// mappings). Extend this set if a future game introduces another top-level
// set-like reference type key. Single source of truth for "is this reference
// record a browsable set/expansion" consumed by natural-key extraction, the
// search projection's slug generation, and the set browse page read model.
export const SET_LIKE_REFERENCE_TYPE_KEYS: ReadonlySet<string> = new Set(["set", "expansion"]);

export function isSetLikeReferenceType(typeKey: string): boolean {
  return SET_LIKE_REFERENCE_TYPE_KEYS.has(typeKey);
}

// Provider reference-hierarchy attributes carry the printed set code under a
// provider-prefixed key (mtgjson-set-code, scryfall-set-code, lorcast-set-code,
// lorcanajson-set-code, scrydex-<game>-set-code) or, for TCGdex/Pokemon
// expansions, the plain "abbreviation" key (provider-integration-profiles.ts).
// Matching on this naming convention lets Discovery read the code without
// importing Catalog's provider-integration internals at runtime.
export function setCodeFromReferenceAttributes(attributes: unknown): string | null {
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    return null;
  }

  for (const [attributeKey, value] of Object.entries(attributes as Record<string, unknown>)) {
    if (isSetCodeAttributeKey(attributeKey) && typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}

function isSetCodeAttributeKey(attributeKey: string): boolean {
  return attributeKey === "abbreviation" || attributeKey === "code" || attributeKey.endsWith("-set-code");
}

/**
 * Walks a resolved reference's relationship graph breadth-first to find the
 * nearest ancestor of a given type (for example "product-line", used to
 * surface the collector-facing game name on a set/expansion browse page).
 * Assumes `reference` was built by {@link loadReferenceRecordMap}, whose depth
 * cap already bounds this traversal.
 */
export function findAncestorReferenceByTypeKey(
  reference: ReferenceRecordRef,
  typeKey: string,
): ReferenceRecordRef | null {
  const visited = new Set<string>([reference.referenceId]);
  const queue: ReferenceRecordRef[] = [reference];

  while (queue.length > 0) {
    const current = queue.shift()!;

    for (const relationship of current.relationships) {
      const related = relationship.reference;
      if (!related || visited.has(related.referenceId)) {
        continue;
      }

      if (related.typeKey === typeKey) {
        return related;
      }

      visited.add(related.referenceId);
      queue.push(related);
    }
  }

  return null;
}

export type ReferenceRelationship = Readonly<{
  relationshipType: string;
  referenceId: string;
}>;

export type ReferenceRecordRow = Readonly<{
  reference_record_id: string;
  type_key: string;
  key: string;
  name: string;
  attributes: unknown;
  relationships: unknown;
  status: string;
}>;

export type ReferenceRecordRef = Readonly<{
  referenceId: string;
  typeKey: string;
  key: string;
  name: string;
  attributes: unknown;
  relationships: readonly (ReferenceRelationship & {
    reference?: ReferenceRecordRef;
  })[];
  status: string;
}>;

export function referenceIdFromValue(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const candidate = value as { referenceId?: unknown; reference_record_id?: unknown };

  if (typeof candidate.referenceId === "string" && candidate.referenceId.length > 0) {
    return candidate.referenceId;
  }

  if (typeof candidate.reference_record_id === "string" && candidate.reference_record_id.length > 0) {
    return candidate.reference_record_id;
  }

  return null;
}

export async function loadReferenceRecordMap(
  db: PgQueryable,
  tableName: string,
  ids: readonly string[],
): Promise<Map<string, ReferenceRecordRef>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const rowsById = await loadReferenceRecordRowsByGraph(db, tableName, uniqueIds);
  const buildReference = (row: ReferenceRecordRow, depth: number, path: ReadonlySet<string>): ReferenceRecordRef => {
    const nextPath = new Set(path);
    nextPath.add(row.reference_record_id);

    return {
      referenceId: row.reference_record_id,
      typeKey: row.type_key,
      key: row.key,
      name: row.name,
      attributes: row.attributes,
      relationships: asArray<ReferenceRelationship>(row.relationships).map((relationship) => {
        const related = rowsById.get(relationship.referenceId);
        const canExpand = related && depth < MAX_REFERENCE_EXPANSION_DEPTH && !nextPath.has(relationship.referenceId);

        return {
          relationshipType: relationship.relationshipType,
          referenceId: relationship.referenceId,
          reference: canExpand ? buildReference(related, depth + 1, nextPath) : undefined,
        };
      }),
      status: row.status,
    };
  };

  return new Map(
    uniqueIds.flatMap((referenceId) => {
      const row = rowsById.get(referenceId);

      return row ? [[row.reference_record_id, buildReference(row, 0, new Set())] as const] : [];
    }),
  );
}

export function flattenReferenceRecordText(reference: ReferenceRecordRef | undefined): string[] {
  if (!reference) {
    return [];
  }

  const values: string[] = [];
  const visit = (record: ReferenceRecordRef, path: ReadonlySet<string>) => {
    if (path.has(record.referenceId)) {
      return;
    }

    const nextPath = new Set(path);
    nextPath.add(record.referenceId);
    values.push(record.name, record.key, record.typeKey);
    values.push(...recordValueText(record.attributes));

    for (const relationship of record.relationships) {
      values.push(relationship.relationshipType);
      if (relationship.reference) {
        visit(relationship.reference, nextPath);
      }
    }
  };

  visit(reference, new Set());

  return values.filter((value) => value.trim().length > 0);
}

export function collectReferenceRecords(reference: ReferenceRecordRef | undefined): ReferenceRecordRef[] {
  if (!reference) {
    return [];
  }

  const records: ReferenceRecordRef[] = [];
  const visited = new Set<string>();
  const visit = (record: ReferenceRecordRef) => {
    if (visited.has(record.referenceId)) {
      return;
    }

    visited.add(record.referenceId);
    records.push(record);

    for (const relationship of record.relationships) {
      if (relationship.reference) {
        visit(relationship.reference);
      }
    }
  };

  visit(reference);

  return records;
}

export async function findCatalogItemIdsByReferenceRecord(
  db: PgQueryable,
  catalogItemsTableName: string,
  referenceRecordId: string,
): Promise<string[]> {
  const result = await db.query<{ catalog_item_id: string }>(
    `SELECT DISTINCT catalog_item_id
     FROM ${catalogItemsTableName}, jsonb_array_elements(field_values) AS field_value
     WHERE field_value->'value'->>'referenceId' = $1
        OR field_value->'value'->>'reference_record_id' = $1`,
    [referenceRecordId],
  );

  return result.rows.map((row) => row.catalog_item_id);
}

export async function findReferenceRecordIdsByRelatedReferenceGraph(
  db: PgQueryable,
  referenceRecordsTableName: string,
  referenceRecordId: string,
): Promise<string[]> {
  const visited = new Set<string>();
  let frontier = [referenceRecordId];

  for (let depth = 0; depth < MAX_REFERENCE_EXPANSION_DEPTH && frontier.length > 0; depth++) {
    const result = await db.query<{ reference_record_id: string }>(
      `SELECT DISTINCT reference_record_id
       FROM ${referenceRecordsTableName}, jsonb_array_elements(relationships) AS relationship
       WHERE relationship->>'referenceId' = ANY($1::text[])`,
      [frontier],
    );
    const next = result.rows.map((row) => row.reference_record_id).filter((recordId) => !visited.has(recordId));

    for (const recordId of next) {
      visited.add(recordId);
    }

    frontier = next;
  }

  return [...visited];
}

async function loadReferenceRecordRowsByGraph(
  db: PgQueryable,
  tableName: string,
  ids: readonly string[],
): Promise<Map<string, ReferenceRecordRow>> {
  const rowsById = new Map<string, ReferenceRecordRow>();
  let frontier = [...new Set(ids)];

  for (let depth = 0; depth <= MAX_REFERENCE_EXPANSION_DEPTH && frontier.length > 0; depth++) {
    const rows = await loadReferenceRecordRows(
      db,
      tableName,
      frontier.filter((referenceId) => !rowsById.has(referenceId)),
    );

    for (const row of rows) {
      rowsById.set(row.reference_record_id, row);
    }

    frontier = [
      ...new Set(
        rows.flatMap((row) =>
          asArray<ReferenceRelationship>(row.relationships)
            .map((relationship) => relationship.referenceId)
            .filter((referenceId): referenceId is string => typeof referenceId === "string"),
        ),
      ),
    ].filter((referenceId) => !rowsById.has(referenceId));
  }

  return rowsById;
}

async function loadReferenceRecordRows(
  db: PgQueryable,
  tableName: string,
  ids: readonly string[],
): Promise<ReferenceRecordRow[]> {
  if (ids.length === 0) {
    return [];
  }

  const result = await db.query<ReferenceRecordRow>(
    `SELECT reference_record_id, type_key, key, name, attributes, relationships, status
     FROM ${tableName}
     WHERE reference_record_id = ANY($1)`,
    [ids],
  );

  return result.rows;
}

function recordValueText(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => recordValueText(entry));
  }

  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => [key, ...recordValueText(entry)]);
  }

  return [];
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}
