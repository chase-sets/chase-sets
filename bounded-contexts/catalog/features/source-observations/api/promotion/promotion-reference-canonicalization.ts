import { createHash } from "node:crypto";
import {
  promotionCaseIgnorableRanges,
  promotionCasedRanges,
  promotionLowercaseRanges,
} from "./promotion-reference-casing-data";

/**
 * Canonical promotion-reference identity (keycase Decision A).
 *
 * C(s) is ECMAScript `s.trim().toLowerCase()`: Unicode default lowercase with the
 * language-independent SpecialCasing entries (dotted I expansion, final sigma),
 * no ASCII-only shortcut, no case folding, no normalization and no locale.
 * N(normalized) keeps the level and the provider/key pairing of a Source
 * Observation header and canonicalizes only the paired strings.
 *
 * The SQL functions below are versioned and immutable. Their bodies embed the
 * pinned Unicode casing data so no database locale, ICU build or `lower()`
 * collation is ever consulted. A casing-data change is a new version with new
 * function and index names, never an in-place replacement.
 */
export const promotionReferenceCasingVersion = 1;
export const promotionReferenceUnicodeVersion = "17.0";

/** ECMAScript WhiteSpace and LineTerminator code points (`String.prototype.trim`). */
export const promotionReferenceTrimCharacters = "\u0009\u000a\u000b\u000c\u000d                  　﻿";

export const promotionReferenceTextFunctionName = `catalog_promotion_reference_text_v${promotionReferenceCasingVersion}`;
export const promotionReferencePairsFunctionName = `catalog_promotion_reference_pairs_v${promotionReferenceCasingVersion}`;

export type CanonicalPromotionReferencePair = Readonly<{ providerKey: string; externalKey: string }>;

export type CanonicalPromotionReferencePairs = Readonly<{
  externalCatalogItemReferences: readonly CanonicalPromotionReferencePair[];
  externalProductReferences: readonly CanonicalPromotionReferencePair[];
}>;

export const promotionReferencePairLevels = ["externalCatalogItemReferences", "externalProductReferences"] as const;

export function canonicalPromotionReferenceText(value: string): string {
  return value.trim().toLowerCase();
}

/** JS mirror of `catalog_promotion_reference_pairs_v1(jsonb)`. */
export function canonicalPromotionReferencePairs(normalized: unknown): CanonicalPromotionReferencePairs {
  const record = isRecord(normalized) ? normalized : {};
  const pairs = (level: (typeof promotionReferencePairLevels)[number]): CanonicalPromotionReferencePair[] => {
    const entries = record[level];
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry) =>
      isRecord(entry) && typeof entry.providerKey === "string" && typeof entry.externalKey === "string"
        ? [
            {
              providerKey: canonicalPromotionReferenceText(entry.providerKey),
              externalKey: canonicalPromotionReferenceText(entry.externalKey),
            },
          ]
        : [],
    );
  };
  return {
    externalCatalogItemReferences: pairs("externalCatalogItemReferences"),
    externalProductReferences: pairs("externalProductReferences"),
  };
}

/** JS mirror of the source-link index key: C(languageCode || ':' || trim(externalKey)). */
export function canonicalPromotionSourceLinkText(languageCode: string, externalKey: string): string {
  return canonicalPromotionReferenceText(`${languageCode}:${externalKey.trim()}`);
}

/**
 * Pinned parity corpus: every row is proven byte-for-byte across the supported
 * Node runtime, the SQL function and the owning domain normalizers.
 */
export const promotionReferenceParityCorpus: readonly Readonly<{ label: string; value: string; canonical: string }>[] =
  [
    { label: "ascii", value: "  MixedCase-Key_01 ", canonical: "mixedcase-key_01" },
    { label: "dotted-i-expansion", value: "İstanbul", canonical: "i̇stanbul" },
    { label: "dotless-i-unchanged", value: "Iı", canonical: "iı" },
    { label: "final-sigma", value: "ΟΔΥΣΣΕΥΣ", canonical: "οδυσσευς" },
    { label: "lone-sigma", value: "Σ", canonical: "σ" },
    { label: "sigma-followed-by-cased", value: "AΣA", canonical: "aσa" },
    { label: "sigma-after-case-ignorable", value: "A'Σ́", canonical: "a'ς́" },
    { label: "capital-sharp-s", value: "ẞ", canonical: "ß" },
    { label: "ss-not-folded", value: "STRASSE", canonical: "strasse" },
    { label: "decomposed-accent", value: "É", canonical: "é" },
    { label: "composed-accent", value: "É", canonical: "é" },
    { label: "kelvin-and-ohm-signs", value: "KΩÅ", canonical: "kωå" },
    { label: "georgian-mtavruli", value: "ᲐᲑ", canonical: "აბ" },
    { label: "cherokee", value: "Ꭰ", canonical: "ꭰ" },
    { label: "deseret-supplementary", value: "\u{10400}", canonical: "\u{10428}" },
    { label: "bom-nbsp-trim", value: "﻿ Key ﻿", canonical: "key" },
    { label: "ideographic-space-and-separators", value: "　 Key 　", canonical: "key" },
    { label: "inner-whitespace-kept", value: "A B C", canonical: "a b c" },
    { label: "uncased-script", value: "日本語", canonical: "日本語" },
    { label: "apostrophe-and-digits", value: "O'Neil 42", canonical: "o'neil 42" },
  ];

export function requirePromotionReferenceRuntime(unicode = process.versions.unicode): void {
  if (unicode !== promotionReferenceUnicodeVersion) {
    throw new Error(
      `promotion-reference-casing-runtime-drift: runtime Unicode ${unicode} differs from pinned ${promotionReferenceUnicodeVersion}`,
    );
  }
}

/** Hash of the pinned casing data the SQL bodies were generated from. */
export const promotionReferenceCasingDataHash = createHash("sha256")
  .update(JSON.stringify([promotionLowercaseRanges, promotionCasedRanges, promotionCaseIgnorableRanges]))
  .digest("hex");

export const promotionReferenceFunctionMarker = `catalog-promotion-reference v${promotionReferenceCasingVersion}; unicode ${promotionReferenceUnicodeVersion}; casing-data sha256 ${promotionReferenceCasingDataHash}`;

export const promotionReferenceFunctionSearchPath = "search_path=pg_catalog, public";

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
const multirange = (ranges: readonly (readonly [number, number])[]) =>
  `${sqlLiteral(`{${ranges.map(([first, last]) => `[${first},${last + 1})`).join(",")}}`)}::int4multirange`;
const lowerPairs = promotionLowercaseRanges.flatMap(([first, last, stride, delta]) =>
  Array.from(
    { length: (last - first) / stride + 1 },
    (_, index) => [first + index * stride, first + index * stride + delta] as const,
  ),
);
const uppercase = String.fromCodePoint(...lowerPairs.map(([from]) => from));
const lowercase = String.fromCodePoint(...lowerPairs.map(([, to]) => to));

// Final sigma (Unicode 3.13): a capital sigma preceded by a cased letter (skipping
// case-ignorable characters) and not followed by one maps to U+03C2. U+0130 is the
// only unconditional lowercase expansion. Everything else is the simple mapping.
const textBody = `
DECLARE
  characters text[] := string_to_array(btrim(value, ${sqlLiteral(promotionReferenceTrimCharacters)}), NULL);
  following boolean[] := ARRAY[]::boolean[];
  result text[] := ARRAY[]::text[];
  cased_before boolean := false;
  cased_after boolean := false;
  point integer;
  i integer;
BEGIN
  FOR i IN REVERSE coalesce(array_length(characters, 1), 0)..1 LOOP
    following[i] := cased_after;
    point := ascii(characters[i]);
    IF NOT (${multirange(promotionCaseIgnorableRanges)} @> point) THEN
      cased_after := ${multirange(promotionCasedRanges)} @> point;
    END IF;
  END LOOP;
  FOR i IN 1..coalesce(array_length(characters, 1), 0) LOOP
    point := ascii(characters[i]);
    result[i] := CASE
      WHEN point = 304 THEN chr(105) || chr(775)
      WHEN point = 931 AND cased_before AND NOT following[i] THEN chr(962)
      ELSE translate(characters[i], ${sqlLiteral(uppercase)}, ${sqlLiteral(lowercase)}) END;
    IF NOT (${multirange(promotionCaseIgnorableRanges)} @> point) THEN
      cased_before := ${multirange(promotionCasedRanges)} @> point;
    END IF;
  END LOOP;
  RETURN coalesce(array_to_string(result, ''), '');
END
`;

const pairsBody = `
DECLARE
  result jsonb := '{}'::jsonb;
  pairs jsonb;
  reference jsonb;
  level text;
BEGIN
  FOREACH level IN ARRAY ARRAY[${promotionReferencePairLevels.map(sqlLiteral).join(", ")}] LOOP
    pairs := '[]'::jsonb;
    IF jsonb_typeof(value->level) = 'array' THEN
      FOR reference IN SELECT jsonb_array_elements(value->level) LOOP
        IF jsonb_typeof(reference->'providerKey') = 'string' AND jsonb_typeof(reference->'externalKey') = 'string' THEN
          pairs := pairs || jsonb_build_array(jsonb_build_object(
            'providerKey', ${promotionReferenceTextFunctionName}(reference->>'providerKey'),
            'externalKey', ${promotionReferenceTextFunctionName}(reference->>'externalKey')));
        END IF;
      END LOOP;
    END IF;
    result := result || jsonb_build_object(level, pairs);
  END LOOP;
  RETURN result;
END
`;

export type PromotionReferenceFunction = Readonly<{
  name: string;
  input: "text" | "jsonb";
  output: "text" | "jsonb";
  body: string;
}>;

export const promotionReferenceFunctions: readonly PromotionReferenceFunction[] = [
  { name: promotionReferenceTextFunctionName, input: "text", output: "text", body: textBody },
  { name: promotionReferencePairsFunctionName, input: "jsonb", output: "jsonb", body: pairsBody },
];

export const promotionReferenceFunctionSignature = (fn: PromotionReferenceFunction) => `${fn.name}(${fn.input})`;

/** Catalog predicate proving an installed function is byte-identical to the pinned body and settings. */
export function promotionReferenceFunctionIdentitySql(fn: PromotionReferenceFunction): string {
  return `p.prosrc = ${sqlLiteral(fn.body)}
      AND p.provolatile = 'i' AND p.proisstrict AND p.proparallel = 's' AND NOT p.prosecdef
      AND l.lanname = 'plpgsql' AND p.prorettype = '${fn.output}'::regtype
      AND p.proconfig = ARRAY[${sqlLiteral(promotionReferenceFunctionSearchPath)}]`;
}

/**
 * Install-if-absent, then verify. Never `CREATE OR REPLACE`: an index may already
 * depend on the body, so a same-named function with any other body is refused.
 */
export const promotionReferenceFunctionStatements: readonly string[] = promotionReferenceFunctions.flatMap((fn) => [
  `DO $install$ BEGIN
  IF to_regprocedure(${sqlLiteral(promotionReferenceFunctionSignature(fn))}) IS NULL THEN
    EXECUTE ${sqlLiteral(
      `CREATE FUNCTION ${fn.name}(value ${fn.input}) RETURNS ${fn.output} LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET ${promotionReferenceFunctionSearchPath} AS ${sqlLiteral(fn.body)}`,
    )};
  END IF;
END $install$`,
  `DO $verify$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
    WHERE p.oid = to_regprocedure(${sqlLiteral(promotionReferenceFunctionSignature(fn))})
      AND ${promotionReferenceFunctionIdentitySql(fn)}
  ) THEN
    RAISE EXCEPTION 'catalog-promotion-reference-function-conflict:${fn.name}';
  END IF;
END $verify$`,
  `COMMENT ON FUNCTION ${promotionReferenceFunctionSignature(fn)} IS ${sqlLiteral(promotionReferenceFunctionMarker)}`,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
