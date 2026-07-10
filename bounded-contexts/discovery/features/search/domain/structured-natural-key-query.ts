/**
 * Recognizes and normalizes the "<setCode> <cardNumber>[/<total>]" natural-key
 * query shape ("SV04 123/182", "sv04 123", "OP01-001") so structured resolution
 * (read-model/queries.ts `searchDiscoveryItemsByNaturalKey`) can try a precise
 * btree lookup before falling back to full-text search.
 *
 * The normalization rules mirror `catalogNaturalKeyNormalizationContract` in
 * bounded-contexts/catalog/features/source-observations/domain/domain.ts:
 * set codes trim + lowercase, numeric-only card numbers drop leading zeroes.
 * Discovery does not depend on Catalog at runtime (only in tests), so the rules
 * are intentionally re-implemented here rather than imported — keep both in sync
 * by hand if the Catalog contract's normal form ever changes version.
 */
export type StructuredNaturalKeyQuery = Readonly<{
  setCode: string;
  cardNumber: string;
}>;

// "SV04 123/182", "sv04 123", "OP01-001" (hyphen-joined, no space), "TSP 136a".
// The set-code token requires at least one letter so a bare number-number query
// ("2024 12") is not mistaken for a natural key. The number token may carry a
// single trailing letter (promo/variant suffixes like "136a") and an optional
// "/<total>" printed-count suffix, which is discarded.
const STRUCTURED_NATURAL_KEY_PATTERN = /^([A-Za-z][A-Za-z0-9]*)[\s-]+(\d+[A-Za-z]?)(?:\s*\/\s*\d+)?$/;

export function parseStructuredNaturalKeyQuery(query: string): StructuredNaturalKeyQuery | null {
  const match = STRUCTURED_NATURAL_KEY_PATTERN.exec(query.trim());
  if (!match) {
    return null;
  }

  const setCode = normalizeStructuredSetCode(match[1]);
  const cardNumber = normalizeStructuredCardNumber(match[2]);
  if (!setCode || !cardNumber) {
    return null;
  }

  return { setCode, cardNumber };
}

/** Mirrors `catalogNaturalKeyNormalizationContract.fields.setCode`: "trim and lowercase". */
export function normalizeStructuredSetCode(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Mirrors `catalogNaturalKeyNormalizationContract.fields.cardNumber` /
 * `.collectorNumber`: "trim and remove leading zeroes from numeric-only values".
 * Alphanumeric numbers (variant-suffixed) are trimmed and lowercased only.
 */
export function normalizeStructuredCardNumber(value: string): string {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed.replace(/^0+(?=\d)/, "") : trimmed.toLowerCase();
}
