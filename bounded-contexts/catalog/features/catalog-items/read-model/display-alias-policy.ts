import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  listPublishableCatalogItemAliases,
  listPublishableReferenceRecordAliases,
  type CatalogItemAliasRow,
  type CatalogReferenceRecordAliasRow,
} from "../../alias-equivalence/read-model/queries";

// ---------------------------------------------------------------------------
// English-locale display policy
//
// Resolved Display Identity owns product-facing display copy. Accepted Catalog
// Aliases are reviewed Catalog facts, so display identity is allowed to surface
// an accepted English alias as the primary display name for an English-locale
// viewer — but only an accepted, locale-appropriate, non-generated alias.
//
// This module is the single place the display policy lives. It reads only the
// publishable (accepted / auto-accepted) aliases for a target and
// selects at most one alias to surface as the English primary display name. The
// native provider name stays as the secondary display (e.g. `Cacnea (サボネア)`)
// so card identity is never erased.
//
// Policy (ADR display policy):
//   1. prefer an accepted `official-equivalent` alias
//   2. then an accepted high-confidence English alias
//   3. otherwise keep the native provider name (no display alias)
// A `generated-translation`, `species-name`, `romanization`, or pending/rejected
// alias never becomes the primary display name. Publishability already excludes
// pending/rejected/revoked, and confidence gating excludes generated/low-trust
// aliases.
// ---------------------------------------------------------------------------

/** Locale whose display surfaces the accepted English alias. */
const ENGLISH_LANGUAGE_PREFIX = "en";

/**
 * Alias types that may never become the primary display name. These are broad,
 * machine-generated, or non-name renderings the ADR keeps out of display truth.
 */
const NON_DISPLAY_ALIAS_TYPES: ReadonlySet<string> = new Set(["generated-translation", "species-name", "romanization"]);

/**
 * Confidence markings trusted enough to surface as a display name. `generated`
 * and `candidate` are explicitly excluded so only reviewed, high-trust aliases
 * become display truth.
 */
const DISPLAY_CONFIDENCE_RANK: ReadonlyMap<string, number> = new Map([
  ["exact", 3],
  ["manual", 2],
  ["high", 1],
]);

/** Alias type preference: an official equivalent always outranks other types. */
function aliasTypeRank(aliasType: string): number {
  return aliasType === "official-equivalent" ? 1 : 0;
}

/** A row shape carrying the fields the display policy reasons over. */
type DisplayAliasCandidate = Readonly<{
  aliasText: string;
  normalizedAliasText: string;
  aliasLanguageCode: string;
  aliasType: string;
  confidence: string;
}>;

/** The chosen English display alias for a target, if any qualifies. */
export type ResolvedDisplayAlias = Readonly<{
  aliasText: string;
  normalizedAliasText: string;
  aliasType: string;
  confidence: string;
}>;

function isEnglishLanguage(languageCode: string): boolean {
  const normalized = languageCode.trim().toLowerCase();
  return normalized === ENGLISH_LANGUAGE_PREFIX || normalized.startsWith(`${ENGLISH_LANGUAGE_PREFIX}-`);
}

/**
 * Select at most one accepted English alias to use as the primary display name,
 * applying the ADR display policy. Returns null when no alias qualifies, in
 * which case the native provider name stays the primary display name.
 *
 * Selection is deterministic: official-equivalent first, then by confidence
 * (exact > manual > high), then by normalized text and raw text so replay,
 * rebuild, and live recompute always pick the same alias for the same evidence.
 */
export function selectDisplayAlias(candidates: readonly DisplayAliasCandidate[]): ResolvedDisplayAlias | null {
  const eligible = candidates.filter(
    (candidate) =>
      isEnglishLanguage(candidate.aliasLanguageCode) &&
      !NON_DISPLAY_ALIAS_TYPES.has(candidate.aliasType) &&
      DISPLAY_CONFIDENCE_RANK.has(candidate.confidence) &&
      candidate.aliasText.trim().length > 0,
  );
  if (eligible.length === 0) {
    return null;
  }

  const [chosen] = [...eligible].sort(compareDisplayAliasPreference);
  if (!chosen) {
    return null;
  }

  return {
    aliasText: chosen.aliasText.trim(),
    normalizedAliasText: chosen.normalizedAliasText,
    aliasType: chosen.aliasType,
    confidence: chosen.confidence,
  };
}

function compareDisplayAliasPreference(left: DisplayAliasCandidate, right: DisplayAliasCandidate): number {
  const typeRank = aliasTypeRank(right.aliasType) - aliasTypeRank(left.aliasType);
  if (typeRank !== 0) {
    return typeRank;
  }

  const confidenceRank =
    (DISPLAY_CONFIDENCE_RANK.get(right.confidence) ?? 0) - (DISPLAY_CONFIDENCE_RANK.get(left.confidence) ?? 0);
  if (confidenceRank !== 0) {
    return confidenceRank;
  }

  const normalizedOrder = left.normalizedAliasText.localeCompare(right.normalizedAliasText);
  if (normalizedOrder !== 0) {
    return normalizedOrder;
  }

  return left.aliasText.localeCompare(right.aliasText);
}

/**
 * Compose the English primary display name plus the native name as secondary.
 * The chosen alias becomes the primary; the native provider name is kept in
 * parentheses (e.g. `Cacnea (サボネア)`). When the alias and native name are the
 * same text, only one is shown so the label never duplicates itself.
 */
export function composeDisplayWithNativeSecondary(displayAlias: string, nativeName: string): string {
  const primary = displayAlias.trim();
  const secondary = nativeName.trim();
  if (!primary) {
    return secondary;
  }
  if (!secondary || primary === secondary) {
    return primary;
  }
  return `${primary} (${secondary})`;
}

// --- Loaders ----------------------------------------------------------------

/**
 * Load the publishable Catalog Item aliases the display policy reasons over. Reads
 * only accepted / auto-accepted aliases; candidates and provider internals are
 * never consulted here.
 */
export async function loadCatalogItemDisplayAlias(
  db: PgQueryable,
  catalogItemId: string,
): Promise<ResolvedDisplayAlias | null> {
  const rows = await listPublishableCatalogItemAliases(db, catalogItemId);
  return selectDisplayAlias(rows.map(toDisplayAliasCandidate));
}

/**
 * Load the publishable Reference Record aliases (set-equivalent / series-equivalent)
 * the display policy reasons over, for set/series display.
 */
export async function loadReferenceRecordDisplayAliasesById(
  db: PgQueryable,
  referenceRecordIds: readonly string[],
): Promise<Map<string, ResolvedDisplayAlias>> {
  const uniqueIds = [...new Set(referenceRecordIds.filter(Boolean))];
  const byReferenceId = new Map<string, ResolvedDisplayAlias>();
  // Sequential: the admin projection refresh runs on one DB connection with
  // backpressure, so alias lookups must not fan out concurrent queries.
  for (const referenceRecordId of uniqueIds) {
    const rows = await listPublishableReferenceRecordAliases(db, referenceRecordId);
    const alias = selectDisplayAlias(rows.map(toDisplayAliasCandidate));
    if (alias) {
      byReferenceId.set(referenceRecordId, alias);
    }
  }

  return byReferenceId;
}

function toDisplayAliasCandidate(row: CatalogItemAliasRow | CatalogReferenceRecordAliasRow): DisplayAliasCandidate {
  return {
    aliasText: row.alias_text,
    normalizedAliasText: row.normalized_alias_text,
    aliasLanguageCode: row.alias_language_code,
    aliasType: row.alias_type,
    confidence: row.confidence,
  };
}
