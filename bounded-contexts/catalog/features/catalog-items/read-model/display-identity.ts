import { createHash } from "node:crypto";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { asArray, asStringArray, type FieldValue } from "../../../support/projection-support/read-model-support";

const MAX_REFERENCE_EXPANSION_DEPTH = 4;
const DISPLAY_IDENTITY_RESOLVER_VERSION = 1;

export type DisplayIdentityItem = Readonly<{
  catalog_item_id: string;
  language_code?: string;
  title: string;
  subtitle: string | null;
  blueprint_id: string | null;
  field_values: unknown;
  category_ids: unknown;
}>;

export type ResolvedDisplayIdentity = Readonly<{
  catalogItemId: string;
  languageCode: string;
  title: string;
  subtitle: string | null;
  templateKey: string | null;
  templateTargetKind: string | null;
  templateTargetId: string | null;
  hash: string;
  resolverVersion: number;
}>;

export type PersistedDisplayIdentityResult = Readonly<{
  identity: ResolvedDisplayIdentity;
  changed: boolean;
  resolvedAt: string;
}>;

type FieldDefinitionRow = Readonly<{
  field_id: string;
  key: string;
}>;

type DisplayTemplateRow = Readonly<{
  key: string;
  target_kind: string;
  target_id: string | null;
  priority: number;
  title_template: string;
  subtitle_template: string | null;
  required_field_keys: unknown;
}>;

type ReferenceRecordRow = Readonly<{
  reference_record_id: string;
  type_key: string;
  key: string;
  name: string;
  attributes: unknown;
  relationships: unknown;
  status: string;
}>;

type ReferenceRelationship = Readonly<{
  relationshipType: string;
  referenceId: string;
}>;

type ReferenceRecordRef = Readonly<{
  referenceId: string;
  typeKey: string;
  key: string;
  name: string;
  attributes: Record<string, unknown>;
  relationships: readonly (ReferenceRelationship & { reference?: ReferenceRecordRef })[];
  depth: number;
}>;

type ResolutionContext = Readonly<{
  item: DisplayIdentityItem;
  fieldsByKey: ReadonlyMap<string, FieldValue>;
  referencesByType: ReadonlyMap<string, ReferenceRecordRef>;
  referencesById: ReadonlyMap<string, ReferenceRecordRef>;
  referenceDepths: ReadonlyMap<string, number>;
}>;

export async function resolveCatalogItemDisplayIdentity(
  db: PgQueryable,
  item: DisplayIdentityItem,
): Promise<ResolvedDisplayIdentity> {
  const fieldValues = asArray<FieldValue>(item.field_values);
  const [fieldDefinitions, templates, references] = await Promise.all([
    loadFieldDefinitions(
      db,
      fieldValues.map((fieldValue) => fieldValue.fieldId),
    ),
    loadActiveDisplayTemplates(db),
    loadReferenceRecordMap(
      db,
      fieldValues
        .map((fieldValue) => referenceIdFromValue(fieldValue.value))
        .filter((referenceId): referenceId is string => referenceId !== null),
    ),
  ]);
  const fieldsByKey = fieldValueMap(fieldValues, fieldDefinitions);
  const context: ResolutionContext = {
    item,
    fieldsByKey,
    referencesByType: referencesByType(references),
    referencesById: references,
    referenceDepths: new Map(
      [...references.entries()].map(([referenceId, reference]) => [referenceId, reference.depth]),
    ),
  };
  const template = chooseTemplate(context, templates);
  const languageCode = normalizeLanguageCode(item.language_code);

  if (!template) {
    return withDisplayIdentityMetadata(item, languageCode, {
      title: item.title,
      subtitle: item.subtitle?.trim() || null,
      templateKey: null,
      templateTargetKind: null,
      templateTargetId: null,
    });
  }

  const title = renderTemplate(template.title_template, context).trim();
  const subtitle = template.subtitle_template ? renderTemplate(template.subtitle_template, context).trim() : "";

  return withDisplayIdentityMetadata(item, languageCode, {
    title: title || item.title,
    subtitle: subtitle || null,
    templateKey: template.key,
    templateTargetKind: template.target_kind,
    templateTargetId: template.target_id,
  });
}

export async function resolveAndPersistCatalogItemDisplayIdentity(
  db: PgQueryable,
  item: DisplayIdentityItem,
  resolvedAt: string,
): Promise<PersistedDisplayIdentityResult> {
  const identity = await resolveCatalogItemDisplayIdentity(db, item);
  const existing = await db.query<{ display_identity_hash: string }>(
    `SELECT display_identity_hash
     FROM catalog_item_display_identities
     WHERE catalog_item_id = $1 AND language_code = $2`,
    [identity.catalogItemId, identity.languageCode],
  );
  const changed = existing.rows[0]?.display_identity_hash !== identity.hash;

  await db.query(
    `INSERT INTO catalog_item_display_identities (
       catalog_item_id,
       language_code,
       title,
       subtitle,
       display_template_key,
       display_template_target_kind,
       display_template_target_id,
       display_identity_hash,
       resolver_version,
       resolved_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
     ON CONFLICT (catalog_item_id, language_code) DO UPDATE SET
       title = EXCLUDED.title,
       subtitle = EXCLUDED.subtitle,
       display_template_key = EXCLUDED.display_template_key,
       display_template_target_kind = EXCLUDED.display_template_target_kind,
       display_template_target_id = EXCLUDED.display_template_target_id,
       display_identity_hash = EXCLUDED.display_identity_hash,
       resolver_version = EXCLUDED.resolver_version,
       resolved_at = EXCLUDED.resolved_at,
       updated_at = EXCLUDED.updated_at`,
    [
      identity.catalogItemId,
      identity.languageCode,
      identity.title,
      identity.subtitle,
      identity.templateKey,
      identity.templateTargetKind,
      identity.templateTargetId,
      identity.hash,
      identity.resolverVersion,
      resolvedAt,
    ],
  );

  return { identity, changed, resolvedAt };
}

function withDisplayIdentityMetadata(
  item: DisplayIdentityItem,
  languageCode: string,
  identity: Pick<
    ResolvedDisplayIdentity,
    "title" | "subtitle" | "templateKey" | "templateTargetKind" | "templateTargetId"
  >,
): ResolvedDisplayIdentity {
  const snapshot = {
    catalogItemId: item.catalog_item_id,
    languageCode,
    title: identity.title,
    subtitle: identity.subtitle,
    templateKey: identity.templateKey,
    templateTargetKind: identity.templateTargetKind,
    templateTargetId: identity.templateTargetId,
    resolverVersion: DISPLAY_IDENTITY_RESOLVER_VERSION,
  };

  return {
    ...snapshot,
    hash: displayIdentityHash(snapshot),
  };
}

function displayIdentityHash(input: {
  catalogItemId: string;
  languageCode: string;
  title: string;
  subtitle: string | null;
  templateKey: string | null;
  templateTargetKind: string | null;
  templateTargetId: string | null;
  resolverVersion: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        catalogItemId: input.catalogItemId,
        languageCode: input.languageCode,
        title: input.title,
        subtitle: input.subtitle,
        templateKey: input.templateKey,
        templateTargetKind: input.templateTargetKind,
        templateTargetId: input.templateTargetId,
        resolverVersion: input.resolverVersion,
      }),
    )
    .digest("hex");
}

function normalizeLanguageCode(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : "en";
}

function chooseTemplate(
  context: ResolutionContext,
  templates: readonly DisplayTemplateRow[],
): DisplayTemplateRow | null {
  const categoryIds = new Set(asStringArray(context.item.category_ids));

  const candidates = templates
    .map((template) => ({ template, score: templateScore(template, context, categoryIds) }))
    .filter((candidate) => candidate.score !== null)
    .filter((candidate): candidate is { template: DisplayTemplateRow; score: number } =>
      Boolean(candidate.score !== null && templateRequirementsSatisfied(candidate.template, context)),
    )
    .sort((left, right) => right.score - left.score || left.template.key.localeCompare(right.template.key));

  return candidates[0]?.template ?? null;
}

function templateScore(
  template: DisplayTemplateRow,
  context: ResolutionContext,
  categoryIds: ReadonlySet<string>,
): number | null {
  switch (template.target_kind) {
    case "catalog-item":
      return template.target_id === context.item.catalog_item_id ? 400_000 + template.priority : null;
    case "reference-record": {
      if (!template.target_id || !context.referencesById.has(template.target_id)) {
        return null;
      }

      return (
        300_000 -
        (context.referenceDepths.get(template.target_id) ?? MAX_REFERENCE_EXPANSION_DEPTH) * 1_000 +
        template.priority
      );
    }
    case "category":
      return template.target_id && categoryIds.has(template.target_id) ? 200_000 + template.priority : null;
    case "blueprint":
      return template.target_id === context.item.blueprint_id ? 100_000 + template.priority : null;
    case "global":
      return template.priority;
    default:
      return null;
  }
}

function templateRequirementsSatisfied(template: DisplayTemplateRow, context: ResolutionContext): boolean {
  return asStringArray(template.required_field_keys).every((fieldKey) =>
    Boolean(formatCatalogValue(context.fieldsByKey.get(fieldKey)?.value, context.referencesById)),
  );
}

function renderTemplate(template: string, context: ResolutionContext): string {
  const withOptionalSegments = template.replace(/\[([^\[\]]+)\]/g, (_match, segment: string) => {
    const rendered = renderTokens(segment, context);
    return rendered.includes("{") ? "" : rendered;
  });

  return collapseDisplayWhitespace(renderTokens(withOptionalSegments, context));
}

function renderTokens(template: string, context: ResolutionContext): string {
  return template.replace(/\{([^{}]+)\}/g, (_match, token: string) => resolveToken(token.trim(), context) ?? "");
}

function resolveToken(token: string, context: ResolutionContext): string | null {
  const parts = token.split(".");
  if (parts[0] === "field" && parts[1]) {
    return formatCatalogValue(context.fieldsByKey.get(parts.slice(1).join("."))?.value, context.referencesById);
  }

  if (parts[0] === "reference" && parts[1]) {
    const reference = context.referencesByType.get(parts[1]);
    if (!reference) {
      return null;
    }

    return resolveReferencePath(reference, parts.slice(2));
  }

  if (parts[0] === "item" && parts[1] === "title") {
    return context.item.title;
  }

  if (parts[0] === "item" && parts[1] === "subtitle") {
    return context.item.subtitle;
  }

  return null;
}

function resolveReferencePath(reference: ReferenceRecordRef, path: readonly string[]): string | null {
  if (path.length === 0 || path[0] === "name") {
    return reference.name;
  }

  if (path[0] === "key") {
    return reference.key;
  }

  if (path[0] === "attributes" && path[1]) {
    return formatPlainValue(reference.attributes[path.slice(1).join(".")]);
  }

  if (path[0] === "relationship" && path[1]) {
    const relationship = reference.relationships.find((entry) => entry.relationshipType === path[1]);
    return relationship?.reference ? resolveReferencePath(relationship.reference, path.slice(2)) : null;
  }

  return null;
}

function fieldValueMap(
  fieldValues: readonly FieldValue[],
  fieldDefinitions: ReadonlyMap<string, FieldDefinitionRow>,
): Map<string, FieldValue> {
  const fields = new Map<string, FieldValue>();

  for (const fieldValue of fieldValues) {
    fields.set(fieldValue.fieldId, fieldValue);
    const definition = fieldDefinitions.get(fieldValue.fieldId);
    if (definition) {
      fields.set(definition.key, fieldValue);
    }
  }

  return fields;
}

async function loadFieldDefinitions(
  db: PgQueryable,
  fieldIds: readonly string[],
): Promise<Map<string, FieldDefinitionRow>> {
  const uniqueIds = [...new Set(fieldIds)].filter(Boolean);
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const result = await db.query<FieldDefinitionRow>(
    `SELECT field_id, key
     FROM catalog_fields
     WHERE field_id = ANY($1)`,
    [uniqueIds],
  );

  return new Map(result.rows.map((row) => [row.field_id, row]));
}

async function loadActiveDisplayTemplates(db: PgQueryable): Promise<DisplayTemplateRow[]> {
  const result = await db.query<DisplayTemplateRow>(
    `SELECT key,
       target_kind,
       target_id,
       priority,
       title_template,
       subtitle_template,
       required_field_keys
     FROM catalog_display_templates
     WHERE status = 'active'
     ORDER BY priority DESC, key ASC`,
  );

  return result.rows;
}

async function loadReferenceRecordMap(
  db: PgQueryable,
  ids: readonly string[],
): Promise<Map<string, ReferenceRecordRef>> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) {
    return new Map();
  }

  const rowsById = await loadReferenceRecordRowsByGraph(db, uniqueIds);
  const buildReference = (row: ReferenceRecordRow, depth: number, path: ReadonlySet<string>): ReferenceRecordRef => {
    const nextPath = new Set(path);
    nextPath.add(row.reference_record_id);

    return {
      referenceId: row.reference_record_id,
      typeKey: row.type_key,
      key: row.key,
      name: row.name,
      attributes: isRecord(row.attributes) ? row.attributes : {},
      relationships: asArray<ReferenceRelationship>(row.relationships).map((relationship) => {
        const related = rowsById.get(relationship.referenceId);
        const canExpand = related && depth < MAX_REFERENCE_EXPANSION_DEPTH && !nextPath.has(relationship.referenceId);

        return {
          relationshipType: relationship.relationshipType,
          referenceId: relationship.referenceId,
          reference: canExpand ? buildReference(related, depth + 1, nextPath) : undefined,
        };
      }),
      depth,
    };
  };

  const references = new Map<string, ReferenceRecordRef>();
  for (const referenceId of uniqueIds) {
    const row = rowsById.get(referenceId);
    if (row) {
      addReferenceGraph(references, buildReference(row, 0, new Set()));
    }
  }

  return references;
}

async function loadReferenceRecordRowsByGraph(
  db: PgQueryable,
  ids: readonly string[],
): Promise<Map<string, ReferenceRecordRow>> {
  const rowsById = new Map<string, ReferenceRecordRow>();
  let frontier = [...new Set(ids)];

  for (let depth = 0; depth <= MAX_REFERENCE_EXPANSION_DEPTH && frontier.length > 0; depth++) {
    const rows = await loadReferenceRecordRows(
      db,
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

async function loadReferenceRecordRows(db: PgQueryable, ids: readonly string[]): Promise<ReferenceRecordRow[]> {
  if (ids.length === 0) {
    return [];
  }

  const result = await db.query<ReferenceRecordRow>(
    `SELECT reference_record_id, type_key, key, name, attributes, relationships, status
     FROM catalog_reference_records
     WHERE reference_record_id = ANY($1)`,
    [ids],
  );

  return result.rows;
}

function addReferenceGraph(references: Map<string, ReferenceRecordRef>, reference: ReferenceRecordRef): void {
  const existing = references.get(reference.referenceId);
  if (!existing || reference.depth < existing.depth) {
    references.set(reference.referenceId, reference);
  }

  for (const relationship of reference.relationships) {
    if (relationship.reference) {
      addReferenceGraph(references, relationship.reference);
    }
  }
}

function referencesByType(referencesById: ReadonlyMap<string, ReferenceRecordRef>): Map<string, ReferenceRecordRef> {
  const references = [...referencesById.values()].sort(
    (left, right) => left.depth - right.depth || left.typeKey.localeCompare(right.typeKey),
  );

  return new Map(references.map((reference) => [reference.typeKey, reference]));
}

function referenceIdFromValue(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }

  const referenceId = value.referenceId ?? value.reference_record_id;
  return typeof referenceId === "string" && referenceId.length > 0 ? referenceId : null;
}

function formatCatalogValue(value: unknown, referencesById: ReadonlyMap<string, ReferenceRecordRef>): string | null {
  const referenceId = referenceIdFromValue(value);
  if (referenceId) {
    return referencesById.get(referenceId)?.name ?? referenceId;
  }

  if (isRecord(value) && isRecord(value.values)) {
    return formatPlainValue(
      value.values.en ?? value.values[value.defaultLocale as string] ?? Object.values(value.values)[0],
    );
  }

  return formatPlainValue(value);
}

function formatPlainValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
}

function collapseDisplayWhitespace(value: string): string {
  return value
    .replace(/\s+([,/:])/g, "$1")
    .replace(/([,:])(?=\S)/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
