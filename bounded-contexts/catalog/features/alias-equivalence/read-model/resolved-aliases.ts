import { createHash } from "node:crypto";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogItemResolvedAliasEntry } from "../../catalog-items/domain/domain";
import type { ReferenceRecordResolvedAliasEntry } from "../../reference-data/domain/domain";
import {
  countCatalogItemsForAliasText,
  listPublishableCatalogItemAliases,
  listPublishableReferenceRecordAliases,
  type CatalogItemAliasRow,
  type CatalogReferenceRecordAliasRow,
} from "./queries";

// ---------------------------------------------------------------------------
// Resolved Alias facts
//
// The canonical resolver for the published alias fact, shared by live recompute,
// backfill, rebuild, replay, and tests. It reads only publishable
// (accepted / auto-accepted) aliases for a target and folds them into one stable
// fact per (target, alias language) with a deterministic resolved hash.
//
// Removal is explicit: when a target has no publishable aliases for a language
// (because every alias was revoked or rejected), the resolved fact is an empty
// alias list. That is still a fact change versus a prior non-empty fact, so the
// publish-on-change path emits a retraction that downstream search and
// display act on, instead of an alias silently disappearing.
//
// Downstream consumers read this fact and never inspect alias candidates,
// provider profiles, or the review state machine, mirroring the Resolved Display
// Identity boundary.
// ---------------------------------------------------------------------------

/** Resolver version. Bump when the fact shape or fold rules change. */
export const ALIAS_RESOLVER_VERSION = 1;

/** Multiple targets sharing a normalized alias text is the broad-alias case. */
const BROAD_ALIAS_FANOUT_THRESHOLD = 2;

export type ResolvedCatalogItemAliases = Readonly<{
  catalogItemId: string;
  aliasLanguageCode: string;
  aliases: readonly CatalogItemResolvedAliasEntry[];
  resolvedAliasHash: string;
  resolverVersion: number;
}>;

export type ResolvedReferenceRecordAliases = Readonly<{
  referenceRecordId: string;
  aliasLanguageCode: string;
  aliases: readonly ReferenceRecordResolvedAliasEntry[];
  resolvedAliasHash: string;
  resolverVersion: number;
}>;

export type PersistedResolvedCatalogItemAliasesResult = Readonly<{
  resolved: ResolvedCatalogItemAliases;
  changed: boolean;
  resolvedAt: string;
}>;

export type PersistedResolvedReferenceRecordAliasesResult = Readonly<{
  resolved: ResolvedReferenceRecordAliases;
  changed: boolean;
  resolvedAt: string;
}>;

type ExistingResolvedAliasHashRow = Readonly<{
  alias_language_code: string;
  resolved_alias_hash: string;
}>;

// --- Catalog Item resolved aliases -----------------------------------------

/**
 * Resolve the publishable aliases for one Catalog Item into resolved facts, one
 * per alias language. A Catalog Item with no publishable aliases resolves to a
 * single empty fact in the item's catalog language so downstream consumers can
 * drop any aliases they previously held. The broad flag is computed from
 * publishable cardinality so Discovery can down-weight species-style aliases.
 */
export async function resolveCatalogItemAliases(
  db: PgQueryable,
  catalogItemId: string,
  catalogLanguageCode: string,
): Promise<readonly ResolvedCatalogItemAliases[]> {
  const rows = await listPublishableCatalogItemAliases(db, catalogItemId);
  const broadByText = await broadFlagsByAliasText(db, rows);
  const byLanguage = groupByLanguage(rows, (row) => row.alias_language_code);

  if (byLanguage.size === 0) {
    return [emptyResolvedCatalogItemAliases(catalogItemId, normalizeLanguageCode(catalogLanguageCode))];
  }

  return [...byLanguage.entries()].map(([languageCode, languageRows]) => {
    const aliases = sortResolvedEntries(languageRows.map((row) => toCatalogItemResolvedAliasEntry(row, broadByText)));
    return {
      catalogItemId,
      aliasLanguageCode: languageCode,
      aliases,
      resolverVersion: ALIAS_RESOLVER_VERSION,
      resolvedAliasHash: resolvedAliasHash("catalog-item", catalogItemId, languageCode, aliases),
    };
  });
}

/**
 * Resolve and persist the Catalog Item alias facts, reporting which changed so
 * the caller publishes only changed facts. Removal of the last alias for a
 * language is preserved as an empty resolved fact (a change versus the prior
 * non-empty fact) rather than deleting the row, so backfill/replay stay
 * idempotent and the empty fact can be re-published if a consumer rebuilds.
 */
export async function resolveAndPersistCatalogItemAliases(
  db: PgQueryable,
  catalogItemId: string,
  catalogLanguageCode: string,
  resolvedAt: string,
): Promise<readonly PersistedResolvedCatalogItemAliasesResult[]> {
  const resolved = await resolveCatalogItemAliases(db, catalogItemId, catalogLanguageCode);
  const existing = await loadExistingCatalogItemResolvedAliasHashes(db, catalogItemId);
  const facts = mergeRetractions(resolved, existing, (languageCode) =>
    emptyResolvedCatalogItemAliases(catalogItemId, languageCode),
  );

  const results = facts.map((fact) => ({
    resolved: fact,
    changed: existing.get(fact.aliasLanguageCode) !== fact.resolvedAliasHash,
    resolvedAt,
  }));

  await persistCatalogItemResolvedAliases(db, results);

  return results;
}

async function loadExistingCatalogItemResolvedAliasHashes(
  db: PgQueryable,
  catalogItemId: string,
): Promise<Map<string, string>> {
  const result = await db.query<ExistingResolvedAliasHashRow>(
    `SELECT alias_language_code, resolved_alias_hash
     FROM catalog_item_resolved_aliases
     WHERE catalog_item_id = $1`,
    [catalogItemId],
  );

  return new Map(result.rows.map((row) => [row.alias_language_code, row.resolved_alias_hash]));
}

async function persistCatalogItemResolvedAliases(
  db: PgQueryable,
  results: readonly PersistedResolvedCatalogItemAliasesResult[],
): Promise<void> {
  for (const result of results) {
    const { resolved } = result;
    await db.query(
      `INSERT INTO catalog_item_resolved_aliases (
         catalog_item_id,
         alias_language_code,
         aliases,
         resolved_alias_hash,
         resolver_version,
         resolved_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (catalog_item_id, alias_language_code) DO UPDATE SET
         aliases = EXCLUDED.aliases,
         resolved_alias_hash = EXCLUDED.resolved_alias_hash,
         resolver_version = EXCLUDED.resolver_version,
         resolved_at = EXCLUDED.resolved_at,
         updated_at = EXCLUDED.updated_at`,
      [
        resolved.catalogItemId,
        resolved.aliasLanguageCode,
        JSON.stringify(resolved.aliases),
        resolved.resolvedAliasHash,
        resolved.resolverVersion,
        result.resolvedAt,
      ],
    );
  }
}

// --- Reference Record resolved aliases -------------------------------------

/**
 * Resolve the publishable aliases for one Reference Record (set-equivalent /
 * series-equivalent). A Reference Record with no publishable aliases resolves to
 * a single empty fact in the requested language so consumers can drop prior
 * aliases.
 */
export async function resolveReferenceRecordAliases(
  db: PgQueryable,
  referenceRecordId: string,
  defaultLanguageCode: string,
): Promise<readonly ResolvedReferenceRecordAliases[]> {
  const rows = await listPublishableReferenceRecordAliases(db, referenceRecordId);
  const broadByText = await broadFlagsByAliasText(db, rows);
  const byLanguage = groupByLanguage(rows, (row) => row.alias_language_code);

  if (byLanguage.size === 0) {
    return [emptyResolvedReferenceRecordAliases(referenceRecordId, normalizeLanguageCode(defaultLanguageCode))];
  }

  return [...byLanguage.entries()].map(([languageCode, languageRows]) => {
    const aliases = sortResolvedEntries(
      languageRows.map((row) => toReferenceRecordResolvedAliasEntry(row, broadByText)),
    );
    return {
      referenceRecordId,
      aliasLanguageCode: languageCode,
      aliases,
      resolverVersion: ALIAS_RESOLVER_VERSION,
      resolvedAliasHash: resolvedAliasHash("reference-record", referenceRecordId, languageCode, aliases),
    };
  });
}

export async function resolveAndPersistReferenceRecordAliases(
  db: PgQueryable,
  referenceRecordId: string,
  defaultLanguageCode: string,
  resolvedAt: string,
): Promise<readonly PersistedResolvedReferenceRecordAliasesResult[]> {
  const resolved = await resolveReferenceRecordAliases(db, referenceRecordId, defaultLanguageCode);
  const existing = await loadExistingReferenceRecordResolvedAliasHashes(db, referenceRecordId);
  const facts = mergeRetractions(resolved, existing, (languageCode) =>
    emptyResolvedReferenceRecordAliases(referenceRecordId, languageCode),
  );

  const results = facts.map((fact) => ({
    resolved: fact,
    changed: existing.get(fact.aliasLanguageCode) !== fact.resolvedAliasHash,
    resolvedAt,
  }));

  await persistReferenceRecordResolvedAliases(db, results);

  return results;
}

async function loadExistingReferenceRecordResolvedAliasHashes(
  db: PgQueryable,
  referenceRecordId: string,
): Promise<Map<string, string>> {
  const result = await db.query<ExistingResolvedAliasHashRow>(
    `SELECT alias_language_code, resolved_alias_hash
     FROM catalog_reference_record_resolved_aliases
     WHERE reference_record_id = $1`,
    [referenceRecordId],
  );

  return new Map(result.rows.map((row) => [row.alias_language_code, row.resolved_alias_hash]));
}

async function persistReferenceRecordResolvedAliases(
  db: PgQueryable,
  results: readonly PersistedResolvedReferenceRecordAliasesResult[],
): Promise<void> {
  for (const result of results) {
    const { resolved } = result;
    await db.query(
      `INSERT INTO catalog_reference_record_resolved_aliases (
         reference_record_id,
         alias_language_code,
         aliases,
         resolved_alias_hash,
         resolver_version,
         resolved_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (reference_record_id, alias_language_code) DO UPDATE SET
         aliases = EXCLUDED.aliases,
         resolved_alias_hash = EXCLUDED.resolved_alias_hash,
         resolver_version = EXCLUDED.resolver_version,
         resolved_at = EXCLUDED.resolved_at,
         updated_at = EXCLUDED.updated_at`,
      [
        resolved.referenceRecordId,
        resolved.aliasLanguageCode,
        JSON.stringify(resolved.aliases),
        resolved.resolvedAliasHash,
        resolved.resolverVersion,
        result.resolvedAt,
      ],
    );
  }
}

// --- Shared folding helpers ------------------------------------------------

/**
 * Combine the freshly resolved facts with explicit retractions for any
 * previously-resolved language that no longer has publishable aliases.
 *
 * `resolveCatalogItemAliases` / `resolveReferenceRecordAliases` return one
 * synthetic empty fact (in the target's default language) when nothing is
 * publishable, which is the correct "current view" for a target that never had
 * aliases. But when prior facts exist in other languages, that synthetic fact
 * would leave the prior non-empty facts stale. This folds the two cases:
 *
 * - non-empty resolved facts pass through unchanged
 * - every existing language without a non-empty resolved fact gets an empty
 *   retraction fact, so the removal is published for that exact language
 * - if there are neither existing facts nor non-empty resolved facts, the single
 *   synthetic empty fact is kept so a fresh empty fact is still resolved once
 */
function mergeRetractions<TFact extends { aliasLanguageCode: string; aliases: readonly unknown[] }>(
  resolved: readonly TFact[],
  existing: ReadonlyMap<string, string>,
  emptyFactFor: (languageCode: string) => TFact,
): TFact[] {
  const nonEmpty = resolved.filter((fact) => fact.aliases.length > 0);
  const nonEmptyLanguages = new Set(nonEmpty.map((fact) => fact.aliasLanguageCode));

  const retractedLanguages = [...existing.keys()].filter((languageCode) => !nonEmptyLanguages.has(languageCode));

  if (nonEmpty.length === 0 && retractedLanguages.length === 0) {
    // Fresh target with nothing publishable: keep the single synthetic empty
    // fact so replay/backfill record one resolved row.
    return [...resolved];
  }

  return [...nonEmpty, ...retractedLanguages.map((languageCode) => emptyFactFor(languageCode))];
}

async function broadFlagsByAliasText(
  db: PgQueryable,
  rows: readonly { normalized_alias_text: string; alias_language_code: string }[],
): Promise<Map<string, boolean>> {
  const uniqueTexts = new Map<string, { normalizedAliasText: string; aliasLanguageCode: string }>();
  for (const row of rows) {
    const key = aliasTextKey(row.normalized_alias_text, row.alias_language_code);
    if (!uniqueTexts.has(key)) {
      uniqueTexts.set(key, {
        normalizedAliasText: row.normalized_alias_text,
        aliasLanguageCode: row.alias_language_code,
      });
    }
  }

  const entries = await Promise.all(
    [...uniqueTexts.entries()].map(async ([key, text]) => {
      const count = await countCatalogItemsForAliasText(db, text.normalizedAliasText, text.aliasLanguageCode);
      return [key, count >= BROAD_ALIAS_FANOUT_THRESHOLD] as const;
    }),
  );

  return new Map(entries);
}

function toCatalogItemResolvedAliasEntry(
  row: CatalogItemAliasRow,
  broadByText: ReadonlyMap<string, boolean>,
): CatalogItemResolvedAliasEntry {
  return {
    aliasHash: row.alias_hash,
    aliasText: row.alias_text,
    normalizedAliasText: row.normalized_alias_text,
    aliasType: row.alias_type,
    confidence: row.confidence,
    broad: broadByText.get(aliasTextKey(row.normalized_alias_text, row.alias_language_code)) ?? false,
    providerKey: row.provider_key,
    sourceCategory: row.source_category,
  };
}

function toReferenceRecordResolvedAliasEntry(
  row: CatalogReferenceRecordAliasRow,
  broadByText: ReadonlyMap<string, boolean>,
): ReferenceRecordResolvedAliasEntry {
  return {
    aliasHash: row.alias_hash,
    aliasText: row.alias_text,
    normalizedAliasText: row.normalized_alias_text,
    aliasType: row.alias_type,
    confidence: row.confidence,
    broad: broadByText.get(aliasTextKey(row.normalized_alias_text, row.alias_language_code)) ?? false,
    providerKey: row.provider_key,
    sourceCategory: row.source_category,
  };
}

function emptyResolvedCatalogItemAliases(catalogItemId: string, aliasLanguageCode: string): ResolvedCatalogItemAliases {
  return {
    catalogItemId,
    aliasLanguageCode,
    aliases: [],
    resolverVersion: ALIAS_RESOLVER_VERSION,
    resolvedAliasHash: resolvedAliasHash("catalog-item", catalogItemId, aliasLanguageCode, []),
  };
}

function emptyResolvedReferenceRecordAliases(
  referenceRecordId: string,
  aliasLanguageCode: string,
): ResolvedReferenceRecordAliases {
  return {
    referenceRecordId,
    aliasLanguageCode,
    aliases: [],
    resolverVersion: ALIAS_RESOLVER_VERSION,
    resolvedAliasHash: resolvedAliasHash("reference-record", referenceRecordId, aliasLanguageCode, []),
  };
}

function groupByLanguage<TRow>(rows: readonly TRow[], languageOf: (row: TRow) => string): Map<string, TRow[]> {
  const byLanguage = new Map<string, TRow[]>();
  for (const row of rows) {
    const languageCode = normalizeLanguageCode(languageOf(row));
    const bucket = byLanguage.get(languageCode);
    if (bucket) {
      bucket.push(row);
    } else {
      byLanguage.set(languageCode, [row]);
    }
  }
  return byLanguage;
}

function sortResolvedEntries<TEntry extends { normalizedAliasText: string; aliasHash: string }>(
  entries: readonly TEntry[],
): TEntry[] {
  return [...entries].sort((left, right) =>
    left.normalizedAliasText === right.normalizedAliasText
      ? left.aliasHash.localeCompare(right.aliasHash)
      : left.normalizedAliasText.localeCompare(right.normalizedAliasText),
  );
}

function resolvedAliasHash(
  targetKind: "catalog-item" | "reference-record",
  targetId: string,
  aliasLanguageCode: string,
  aliases: readonly {
    aliasHash: string;
    aliasText: string;
    normalizedAliasText: string;
    aliasType: string;
    confidence: string;
    broad: boolean;
    providerKey: string;
    sourceCategory: string;
  }[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        targetKind,
        targetId,
        aliasLanguageCode,
        resolverVersion: ALIAS_RESOLVER_VERSION,
        aliases: aliases.map((alias) => ({
          aliasHash: alias.aliasHash,
          aliasText: alias.aliasText,
          normalizedAliasText: alias.normalizedAliasText,
          aliasType: alias.aliasType,
          confidence: alias.confidence,
          broad: alias.broad,
          providerKey: alias.providerKey,
          sourceCategory: alias.sourceCategory,
        })),
      }),
    )
    .digest("hex");
}

function aliasTextKey(normalizedAliasText: string, aliasLanguageCode: string): string {
  return `${normalizedAliasText} ${normalizeLanguageCode(aliasLanguageCode)}`;
}

function normalizeLanguageCode(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase();
  return normalized && normalized.length > 0 ? normalized : "en";
}
