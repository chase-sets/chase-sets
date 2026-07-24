import { createHash } from "node:crypto";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { asArray, asStringArray, type FieldValue } from "../../../support/projection-support/read-model-support";
import type { CatalogItemDisplayResolutionStatus } from "../domain/domain";
import {
  composeDisplayWithNativeSecondary,
  loadCatalogItemDisplayAlias,
  loadReferenceRecordDisplayAliasesById,
  type ResolvedDisplayAlias,
} from "./display-alias-policy";

const MAX_REFERENCE_EXPANSION_DEPTH = 4;
// Bump this version whenever the resolved hash depends on a new input (e.g. the
// chosen display alias, or the resolution-outcome metadata), so a resolver
// upgrade re-resolves every item even when the template output is unchanged.
const DISPLAY_IDENTITY_RESOLVER_VERSION = 3;

// Sentinel recorded in missing_tokens when no display template targeted the item
// at all (as opposed to a targeted template whose required fields were missing).
const NO_TEMPLATE_MATCHED_TOKEN = "template";

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
  /** Whether a template fully resolved the display title, or it fell back. */
  resolutionStatus: CatalogItemDisplayResolutionStatus;
  /** Required tokens/fields left unsatisfied when degraded; empty when resolved. */
  missingTokens: readonly string[];
}>;

export type PersistedDisplayIdentityResult = Readonly<{
  identity: ResolvedDisplayIdentity;
  changed: boolean;
  publicationRequired: boolean;
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
  /** Chosen accepted English alias for the item, if any qualifies and the locale prefers it. */
  itemDisplayAlias: ResolvedDisplayAlias | null;
  /** Chosen accepted English alias per Reference Record (set/series display). */
  referenceDisplayAliasesById: ReadonlyMap<string, ResolvedDisplayAlias>;
}>;

/**
 * Catalog Item + Reference Record display aliases the resolver folds into the
 * resolved title/subtitle for an English-locale viewer. Loaded from the
 * publishable alias queries and selected by the display policy.
 */
export type DisplayIdentityAliases = Readonly<{
  itemDisplayAlias: ResolvedDisplayAlias | null;
  referenceDisplayAliasesById: ReadonlyMap<string, ResolvedDisplayAlias>;
}>;

const NO_DISPLAY_ALIASES: DisplayIdentityAliases = {
  itemDisplayAlias: null,
  referenceDisplayAliasesById: new Map(),
};

type ExistingDisplayIdentityHashRow = Readonly<{
  catalog_item_id: string;
  language_code: string;
  display_identity_hash: string;
  last_published_display_identity_hash: string | null;
}>;

export async function resolveCatalogItemDisplayIdentity(
  db: PgQueryable,
  item: DisplayIdentityItem,
): Promise<ResolvedDisplayIdentity> {
  const fieldValues = asArray<FieldValue>(item.field_values);
  const referenceIds = fieldValues
    .map((fieldValue) => referenceIdFromValue(fieldValue.value))
    .filter((referenceId): referenceId is string => referenceId !== null);
  const [fieldDefinitions, templates, references, itemDisplayAlias, referenceDisplayAliasesById] = await Promise.all([
    loadFieldDefinitions(
      db,
      fieldValues.map((fieldValue) => fieldValue.fieldId),
    ),
    loadActiveDisplayTemplates(db),
    loadReferenceRecordMap(db, referenceIds),
    loadCatalogItemDisplayAlias(db, item.catalog_item_id),
    loadReferenceRecordDisplayAliasesById(db, referenceIds),
  ]);

  return resolveCatalogItemDisplayIdentityWithLoadedData(item, fieldValues, fieldDefinitions, templates, references, {
    itemDisplayAlias,
    referenceDisplayAliasesById,
  });
}

export async function resolveAndPersistCatalogItemDisplayIdentities<TItem extends DisplayIdentityItem>(
  db: PgQueryable,
  items: readonly TItem[],
  resolvedAt: string | ((item: TItem) => string),
): Promise<Map<string, PersistedDisplayIdentityResult>> {
  const uniqueItems = [...new Map(items.map((item) => [item.catalog_item_id, item])).values()];
  if (uniqueItems.length === 0) {
    return new Map();
  }

  const fieldValuesByItemId = new Map(
    uniqueItems.map((item) => [item.catalog_item_id, asArray<FieldValue>(item.field_values)] as const),
  );
  const directReferenceIdsByItemId = new Map(
    uniqueItems.map((item) => {
      const fieldValues = fieldValuesByItemId.get(item.catalog_item_id) ?? [];
      return [
        item.catalog_item_id,
        fieldValues
          .map((fieldValue) => referenceIdFromValue(fieldValue.value))
          .filter((referenceId): referenceId is string => referenceId !== null),
      ] as const;
    }),
  );

  const fieldDefinitions = await loadFieldDefinitions(
    db,
    uniqueItems.flatMap((item) =>
      (fieldValuesByItemId.get(item.catalog_item_id) ?? []).map((fieldValue) => fieldValue.fieldId),
    ),
  );
  const templates = await loadActiveDisplayTemplates(db);
  const referenceRowsById = await loadReferenceRecordRowsByGraph(
    db,
    uniqueItems.flatMap((item) => directReferenceIdsByItemId.get(item.catalog_item_id) ?? []),
  );
  // Sequential alias loads: the admin projection refresh runs on one DB
  // connection with backpressure, so these must not fan out concurrent queries.
  const itemDisplayAliasesById = new Map<string, Awaited<ReturnType<typeof loadCatalogItemDisplayAlias>>>();
  for (const item of uniqueItems) {
    itemDisplayAliasesById.set(item.catalog_item_id, await loadCatalogItemDisplayAlias(db, item.catalog_item_id));
  }
  const referenceDisplayAliasesById = await loadReferenceRecordDisplayAliasesById(
    db,
    uniqueItems.flatMap((item) => directReferenceIdsByItemId.get(item.catalog_item_id) ?? []),
  );
  const identities = uniqueItems.map((item) =>
    resolveCatalogItemDisplayIdentityWithLoadedData(
      item,
      fieldValuesByItemId.get(item.catalog_item_id) ?? [],
      fieldDefinitions,
      templates,
      buildReferenceRecordMap(directReferenceIdsByItemId.get(item.catalog_item_id) ?? [], referenceRowsById),
      {
        itemDisplayAlias: itemDisplayAliasesById.get(item.catalog_item_id) ?? null,
        referenceDisplayAliasesById,
      },
    ),
  );
  const existingHashes = await loadExistingDisplayIdentityHashes(db, identities);
  const resolvedAtForItem = typeof resolvedAt === "function" ? resolvedAt : () => resolvedAt;
  const results = new Map<string, PersistedDisplayIdentityResult>(
    identities.map((identity, index) => {
      const item = uniqueItems[index];
      if (!item) {
        throw new Error(`Missing Catalog Item for display identity ${identity.catalogItemId}.`);
      }

      const resolvedAtValue = resolvedAtForItem(item);
      const existing = existingHashes.get(displayIdentityKey(identity.catalogItemId, identity.languageCode));
      const changed = existing?.displayIdentityHash !== identity.hash;

      return [
        identity.catalogItemId,
        {
          identity,
          changed,
          publicationRequired: existing?.lastPublishedDisplayIdentityHash !== identity.hash,
          resolvedAt: resolvedAtValue,
        },
      ];
    }),
  );

  await persistDisplayIdentities(db, [...results.values()]);

  return results;
}

function resolveCatalogItemDisplayIdentityWithLoadedData(
  item: DisplayIdentityItem,
  fieldValues: readonly FieldValue[],
  fieldDefinitions: ReadonlyMap<string, FieldDefinitionRow>,
  templates: readonly DisplayTemplateRow[],
  references: ReadonlyMap<string, ReferenceRecordRef>,
  aliases: DisplayIdentityAliases = NO_DISPLAY_ALIASES,
): ResolvedDisplayIdentity {
  const fieldsByKey = fieldValueMap(fieldValues, fieldDefinitions);
  const languageCode = normalizeLanguageCode(item.language_code);
  const prefersEnglishAlias = isEnglishDisplayLocale(languageCode);
  const context: ResolutionContext = {
    item,
    fieldsByKey,
    referencesByType: referencesByType(references),
    referencesById: references,
    referenceDepths: new Map(
      [...references.entries()].map(([referenceId, reference]) => [referenceId, reference.depth]),
    ),
    itemDisplayAlias: prefersEnglishAlias ? aliases.itemDisplayAlias : null,
    referenceDisplayAliasesById: prefersEnglishAlias ? aliases.referenceDisplayAliasesById : new Map(),
  };
  const selection = selectDisplayTemplate(context, templates);
  const template = selection.template;

  if (!template) {
    // Degraded: no template resolved this item, so the bare native title (still
    // displayable) is a fallback. Record which required keys were unsatisfied,
    // or the no-template sentinel when nothing targeted the item at all.
    const missingTokens =
      selection.missingRequiredFieldKeys.length > 0 ? selection.missingRequiredFieldKeys : [NO_TEMPLATE_MATCHED_TOKEN];
    return withDisplayIdentityMetadata(item, languageCode, {
      title: applyItemDisplayAlias(context, item.title),
      subtitle: item.subtitle?.trim() || null,
      templateKey: null,
      templateTargetKind: null,
      templateTargetId: null,
      displayAlias: context.itemDisplayAlias,
      resolutionStatus: "degraded",
      missingTokens,
    });
  }

  // A template matched. Degradation here means a non-optional title token
  // rendered empty (an empty subtitle is allowed and never degrades). The
  // rendered title still falls back to the bare native title for display.
  const missingTitleTokens = unresolvedNonOptionalTitleTokens(template, context);
  const nativeTitle = renderTemplate(template.title_template, context).trim() || item.title;
  const subtitle = template.subtitle_template ? renderTemplate(template.subtitle_template, context).trim() : "";

  return withDisplayIdentityMetadata(item, languageCode, {
    title: applyItemDisplayAlias(context, nativeTitle),
    subtitle: subtitle || null,
    templateKey: template.key,
    templateTargetKind: template.target_kind,
    templateTargetId: template.target_id,
    displayAlias: context.itemDisplayAlias,
    resolutionStatus: missingTitleTokens.length > 0 ? "degraded" : "resolved",
    missingTokens: missingTitleTokens,
  });
}

/**
 * Fold the chosen English display alias into the resolved title, keeping the
 * native (template-resolved) name as secondary: `Cacnea (サボネア)`. When no alias
 * qualifies the native name stays the primary display name untouched.
 */
function applyItemDisplayAlias(context: ResolutionContext, nativeTitle: string): string {
  if (!context.itemDisplayAlias) {
    return nativeTitle;
  }
  return composeDisplayWithNativeSecondary(context.itemDisplayAlias.aliasText, nativeTitle);
}

function isEnglishDisplayLocale(languageCode: string): boolean {
  return languageCode === "en" || languageCode.startsWith("en-");
}

export async function resolveAndPersistCatalogItemDisplayIdentity(
  db: PgQueryable,
  item: DisplayIdentityItem,
  resolvedAt: string,
): Promise<PersistedDisplayIdentityResult> {
  const identity = await resolveCatalogItemDisplayIdentity(db, item);
  const existing = await db.query<{
    display_identity_hash: string;
    last_published_display_identity_hash: string | null;
  }>(
    `SELECT display_identity_hash, last_published_display_identity_hash
     FROM catalog_item_display_identities
     WHERE catalog_item_id = $1 AND language_code = $2`,
    [identity.catalogItemId, identity.languageCode],
  );
  const changed = existing.rows[0]?.display_identity_hash !== identity.hash;
  const publicationRequired = existing.rows[0]?.last_published_display_identity_hash !== identity.hash;

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
       resolution_status,
       missing_tokens,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $10)
     ON CONFLICT (catalog_item_id, language_code) DO UPDATE SET
       title = EXCLUDED.title,
       subtitle = EXCLUDED.subtitle,
       display_template_key = EXCLUDED.display_template_key,
       display_template_target_kind = EXCLUDED.display_template_target_kind,
       display_template_target_id = EXCLUDED.display_template_target_id,
       display_identity_hash = EXCLUDED.display_identity_hash,
       resolver_version = EXCLUDED.resolver_version,
       resolved_at = EXCLUDED.resolved_at,
       resolution_status = EXCLUDED.resolution_status,
       missing_tokens = EXCLUDED.missing_tokens,
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
      identity.resolutionStatus,
      JSON.stringify(identity.missingTokens),
    ],
  );

  return { identity, changed, publicationRequired, resolvedAt };
}

async function loadExistingDisplayIdentityHashes(
  db: PgQueryable,
  identities: readonly ResolvedDisplayIdentity[],
): Promise<Map<string, { displayIdentityHash: string; lastPublishedDisplayIdentityHash: string | null }>> {
  const catalogItemIds = [...new Set(identities.map((identity) => identity.catalogItemId))];
  if (catalogItemIds.length === 0) {
    return new Map();
  }

  const existing = await db.query<ExistingDisplayIdentityHashRow>(
    `SELECT catalog_item_id,
       language_code,
       display_identity_hash,
       last_published_display_identity_hash
     FROM catalog_item_display_identities
     WHERE catalog_item_id = ANY($1)`,
    [catalogItemIds],
  );

  return new Map(
    existing.rows.map((row) => [
      displayIdentityKey(row.catalog_item_id, row.language_code),
      {
        displayIdentityHash: row.display_identity_hash,
        lastPublishedDisplayIdentityHash: row.last_published_display_identity_hash,
      },
    ]),
  );
}

async function persistDisplayIdentities(
  db: PgQueryable,
  results: readonly PersistedDisplayIdentityResult[],
): Promise<void> {
  if (results.length === 0) {
    return;
  }

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
       resolution_status,
       missing_tokens,
       updated_at
     )
     SELECT
       input.catalog_item_id,
       input.language_code,
       input.title,
       input.subtitle,
       input.display_template_key,
       input.display_template_target_kind,
       input.display_template_target_id,
       input.display_identity_hash,
       input.resolver_version,
       input.resolved_at,
       input.resolution_status,
       input.missing_tokens::jsonb,
       input.resolved_at
     FROM unnest(
       $1::text[],
       $2::text[],
       $3::text[],
       $4::text[],
       $5::text[],
       $6::text[],
       $7::text[],
       $8::text[],
       $9::integer[],
       $10::timestamptz[],
       $11::text[],
       $12::text[]
     ) AS input(
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
       resolution_status,
       missing_tokens
     )
     ON CONFLICT (catalog_item_id, language_code) DO UPDATE SET
       title = EXCLUDED.title,
       subtitle = EXCLUDED.subtitle,
       display_template_key = EXCLUDED.display_template_key,
       display_template_target_kind = EXCLUDED.display_template_target_kind,
       display_template_target_id = EXCLUDED.display_template_target_id,
       display_identity_hash = EXCLUDED.display_identity_hash,
       resolver_version = EXCLUDED.resolver_version,
       resolved_at = EXCLUDED.resolved_at,
       resolution_status = EXCLUDED.resolution_status,
       missing_tokens = EXCLUDED.missing_tokens,
       updated_at = EXCLUDED.updated_at`,
    [
      results.map((result) => result.identity.catalogItemId),
      results.map((result) => result.identity.languageCode),
      results.map((result) => result.identity.title),
      results.map((result) => result.identity.subtitle),
      results.map((result) => result.identity.templateKey),
      results.map((result) => result.identity.templateTargetKind),
      results.map((result) => result.identity.templateTargetId),
      results.map((result) => result.identity.hash),
      results.map((result) => result.identity.resolverVersion),
      results.map((result) => result.resolvedAt),
      results.map((result) => result.identity.resolutionStatus),
      results.map((result) => JSON.stringify(result.identity.missingTokens)),
    ],
  );
}

function displayIdentityKey(catalogItemId: string, languageCode: string): string {
  return `${catalogItemId}\u0000${languageCode}`;
}

function withDisplayIdentityMetadata(
  item: DisplayIdentityItem,
  languageCode: string,
  identity: Pick<
    ResolvedDisplayIdentity,
    "title" | "subtitle" | "templateKey" | "templateTargetKind" | "templateTargetId" | "resolutionStatus"
  > & { displayAlias: ResolvedDisplayAlias | null; missingTokens: readonly string[] },
): ResolvedDisplayIdentity {
  // Deterministic ordering keeps the persisted list and hash stable regardless
  // of the order tokens were discovered, so replay/backfill reproduce the fact.
  const missingTokens = [...new Set(identity.missingTokens)].sort((left, right) => left.localeCompare(right));
  const snapshot = {
    catalogItemId: item.catalog_item_id,
    languageCode,
    title: identity.title,
    subtitle: identity.subtitle,
    templateKey: identity.templateKey,
    templateTargetKind: identity.templateTargetKind,
    templateTargetId: identity.templateTargetId,
    resolverVersion: DISPLAY_IDENTITY_RESOLVER_VERSION,
    resolutionStatus: identity.resolutionStatus,
    missingTokens,
  };

  return {
    ...snapshot,
    hash: displayIdentityHash({ ...snapshot, displayAlias: identity.displayAlias }),
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
  resolutionStatus: CatalogItemDisplayResolutionStatus;
  missingTokens: readonly string[];
  displayAlias: ResolvedDisplayAlias | null;
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
        // Resolution outcome is display truth: fold it into the hash so a status
        // transition (e.g. resolved -> degraded) republishes even when the
        // rendered title/subtitle happen to be identical.
        resolutionStatus: input.resolutionStatus,
        missingTokens: input.missingTokens,
        // The chosen display alias is part of resolved display truth: include its
        // identity so the hash changes when the display-relevant alias changes,
        // even if the rendered title text happens to collide.
        displayAlias: input.displayAlias
          ? {
              normalizedAliasText: input.displayAlias.normalizedAliasText,
              aliasType: input.displayAlias.aliasType,
              confidence: input.displayAlias.confidence,
            }
          : null,
      }),
    )
    .digest("hex");
}

function normalizeLanguageCode(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : "en";
}

type DisplayTemplateSelection = Readonly<{
  /** The chosen template whose requirements are satisfied, or null. */
  template: DisplayTemplateRow | null;
  /**
   * When no template was chosen but one targeted this item, the required field
   * keys that were unsatisfied (why it was excluded). Empty when a template was
   * chosen or when nothing targeted the item.
   */
  missingRequiredFieldKeys: readonly string[];
}>;

function selectDisplayTemplate(
  context: ResolutionContext,
  templates: readonly DisplayTemplateRow[],
): DisplayTemplateSelection {
  const categoryIds = new Set(asStringArray(context.item.category_ids));

  const targeted = templates
    .map((template) => ({ template, score: templateScore(template, context, categoryIds) }))
    .filter((candidate): candidate is { template: DisplayTemplateRow; score: number } => candidate.score !== null)
    .sort((left, right) => right.score - left.score || left.template.key.localeCompare(right.template.key));

  const chosen = targeted.find((candidate) => templateRequirementsSatisfied(candidate.template, context));
  if (chosen) {
    return { template: chosen.template, missingRequiredFieldKeys: [] };
  }

  // No targeted template satisfied its requirements. Surface the missing
  // required keys of the best-scoring targeted template for degradation
  // diagnostics; when nothing targeted the item there are none to report.
  const bestTargeted = targeted[0];
  return {
    template: null,
    missingRequiredFieldKeys: bestTargeted ? missingRequiredFieldKeys(bestTargeted.template, context) : [],
  };
}

function missingRequiredFieldKeys(template: DisplayTemplateRow, context: ResolutionContext): string[] {
  return asStringArray(template.required_field_keys).filter(
    (fieldKey) => !formatCatalogValue(context.fieldsByKey.get(fieldKey)?.value, context.referencesById),
  );
}

/**
 * The non-optional title tokens (outside `[...]` optional segments) that render
 * empty for this item. A non-empty result means the resolved title degraded to
 * the bare native title for one or more required tokens.
 */
function unresolvedNonOptionalTitleTokens(template: DisplayTemplateRow, context: ResolutionContext): string[] {
  const withoutOptionalSegments = template.title_template.replace(/\[[^\[\]]+\]/g, "");
  const unresolved = new Set<string>();

  withoutOptionalSegments.replace(/\{([^{}]+)\}/g, (_match, token: string) => {
    const trimmed = token.trim();
    const rendered = resolveToken(trimmed, context);
    if (!rendered || rendered.trim().length === 0) {
      unresolved.add(trimmed);
    }
    return "";
  });

  return [...unresolved];
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

    return resolveReferencePath(reference, parts.slice(2), context);
  }

  if (parts[0] === "item" && parts[1] === "title") {
    return context.item.title;
  }

  if (parts[0] === "item" && parts[1] === "subtitle") {
    return context.item.subtitle;
  }

  return null;
}

function resolveReferencePath(
  reference: ReferenceRecordRef,
  path: readonly string[],
  context: ResolutionContext,
): string | null {
  if (path.length === 0 || path[0] === "name") {
    return referenceDisplayName(reference, context);
  }

  if (path[0] === "key") {
    return reference.key;
  }

  if (path[0] === "attributes" && path[1]) {
    return formatPlainValue(reference.attributes[path.slice(1).join(".")]);
  }

  if (path[0] === "relationship" && path[1]) {
    const relationship = reference.relationships.find((entry) => entry.relationshipType === path[1]);
    return relationship?.reference ? resolveReferencePath(relationship.reference, path.slice(2), context) : null;
  }

  return null;
}

/**
 * The display name for a Reference Record (set/series): the accepted English
 * alias as primary with the native provider name as secondary when one qualifies
 * (`Triplet Beat (トリプレットビート)`), otherwise the native name unchanged. Mirrors
 * the Catalog Item display policy so set/series display follows the same rule.
 */
function referenceDisplayName(reference: ReferenceRecordRef, context: ResolutionContext): string {
  const alias = context.referenceDisplayAliasesById.get(reference.referenceId);
  return alias ? composeDisplayWithNativeSecondary(alias.aliasText, reference.name) : reference.name;
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

  return buildReferenceRecordMap(uniqueIds, await loadReferenceRecordRowsByGraph(db, uniqueIds));
}

function buildReferenceRecordMap(
  ids: readonly string[],
  rowsById: ReadonlyMap<string, ReferenceRecordRow>,
): Map<string, ReferenceRecordRef> {
  const uniqueIds = [...new Set(ids)];
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
    .trim()
    .replace(/^[,/:]+\s*|\s*[,/:]+$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
