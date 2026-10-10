import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  promotionCaseIgnorableRanges,
  promotionCasedRanges,
  promotionLowercaseRanges,
} from "./promotion-reference-casing-data";

export const promotionReferenceUnicodeVersion = "17.0";
export const promotionReferenceTrimCharacters =
  "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

export function canonicalPromotionReferenceText(value: string): string {
  return value.trim().toLowerCase();
}

export function requirePromotionReferenceRuntime(unicode = process.versions.unicode): void {
  if (unicode !== promotionReferenceUnicodeVersion) throw new Error("promotion-reference-casing-runtime-drift");
}

const sqlLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
const multirange = (ranges: readonly (readonly [number, number])[]) =>
  sqlLiteral(`{${ranges.map(([first, last]) => `[${first},${last + 1})`).join(",")}}`) + "::int4multirange";
const lowerPairs = promotionLowercaseRanges.flatMap(([first, last, stride, delta]) =>
  Array.from(
    { length: (last - first) / stride + 1 },
    (_, index) => [first + index * stride, first + index * stride + delta] as const,
  ),
);
const uppercase = String.fromCodePoint(...lowerPairs.map(([from]) => from));
const lowercase = String.fromCodePoint(...lowerPairs.map(([, to]) => to));

// Neither the mapping nor contextual classification consults database locale or ICU.
// Never replace these immutable bodies: a Unicode upgrade needs new function/index names.
const scalarBody = `
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
  FOREACH level IN ARRAY ARRAY['externalCatalogItemReferences', 'externalProductReferences'] LOOP
    pairs := '[]'::jsonb;
    IF jsonb_typeof(value->level) = 'array' THEN
      FOR reference IN SELECT jsonb_array_elements(value->level) LOOP
        IF jsonb_typeof(reference->'providerKey') = 'string' AND jsonb_typeof(reference->'externalKey') = 'string' THEN
          pairs := pairs || jsonb_build_array(jsonb_build_object(
            'providerKey', catalog_promotion_reference_text_v1(reference->>'providerKey'),
            'externalKey', catalog_promotion_reference_text_v1(reference->>'externalKey')));
        END IF;
      END LOOP;
    END IF;
    result := result || jsonb_build_object(level, pairs);
  END LOOP;
  RETURN result;
END
`;

export const promotionReferenceFunctions = [
  { name: "catalog_promotion_reference_text_v1", input: "text", output: "text", body: scalarBody },
  { name: "catalog_promotion_reference_pairs_v1", input: "jsonb", output: "jsonb", body: pairsBody },
] as const;

export const promotionReferenceFunctionStatements = promotionReferenceFunctions.flatMap((fn) => [
  `DO $install$ BEGIN
    IF to_regprocedure('${fn.name}(${fn.input})') IS NULL THEN
      EXECUTE ${sqlLiteral(`CREATE FUNCTION ${fn.name}(value ${fn.input}) RETURNS ${fn.output} LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog, public AS ${sqlLiteral(fn.body)}`)};
    END IF;
  END $install$`,
  `DO $verify$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
      WHERE p.oid=to_regprocedure('${fn.name}(${fn.input})') AND p.prosrc=${sqlLiteral(fn.body)}
      AND p.provolatile='i' AND p.proisstrict AND p.proparallel='s' AND NOT p.prosecdef
      AND l.lanname='plpgsql' AND p.prorettype='${fn.output}'::regtype
      AND p.proconfig=ARRAY['search_path=pg_catalog, public']) THEN
      RAISE EXCEPTION 'promotion-reference-function-drift:${fn.name}';
    END IF;
  END $verify$`,
]);

export async function requirePromotionReferenceFunctions(db: PgQueryable): Promise<void> {
  requirePromotionReferenceRuntime();
  for (const fn of promotionReferenceFunctions) {
    const result = await db.query<{ valid: boolean }>(
      `SELECT p.prosrc=$2 AND p.provolatile='i' AND p.proisstrict AND p.proparallel='s'
        AND NOT p.prosecdef AND l.lanname='plpgsql' AND p.prorettype=$3::regtype
        AND p.proconfig=ARRAY['search_path=pg_catalog, public'] AS valid
       FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure($1)`,
      [`${fn.name}(${fn.input})`, fn.body, fn.output],
    );
    if (result.rows.length !== 1 || result.rows[0].valid !== true)
      throw new Error(`promotion-reference-function-drift:${fn.name}`);
  }
}
