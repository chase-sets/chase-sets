import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  tcgplayerSingleCardUnitConstraints,
  type TcgplayerSingleCardUnitConstraints,
} from "../../source-observations/api/providers/tcgplayer/adapter";
import {
  normalizeHeldSetLabel,
  parseHeldSetExport,
  type HeldSetPair,
  type HeldSetResolution,
  type HeldSetResolutionReason,
} from "../domain/held-set-export";

type ObservationRow = Readonly<{
  unit_key: string;
  scope_kind: "expansion" | "set";
  language_code: string;
  external_id: string;
  label: string;
}>;

type MappingRow = Readonly<{
  unit_key: string;
  set_id: string;
  scope_record_id: string;
  review_status: string;
  product_domain: HeldSetResolution["resolved"][number]["productDomain"] | null;
  scope_kind: HeldSetResolution["resolved"][number]["scopeKind"] | null;
}>;

type LocatedPair = Readonly<{
  pair: HeldSetPair;
  unit: TcgplayerSingleCardUnitConstraints;
  observation: ObservationRow;
}>;

export async function resolveHeldSetExport(db: PgQueryable, bytes: Uint8Array): Promise<HeldSetResolution> {
  const parsed = parseHeldSetExport(bytes);
  const productLineIndex = buildProductLineIndex();
  const unitByPair = new Map<HeldSetPair, TcgplayerSingleCardUnitConstraints>();
  const unresolved = new Map<HeldSetPair, HeldSetResolution["unresolved"][number]>();

  for (const pair of parsed.pairs) {
    const matchingUnits = productLineIndex.get(normalizeHeldSetLabel(pair.productLine)) ?? [];
    if (matchingUnits.length !== 1) {
      unresolved.set(pair, unresolvedPair(pair, "product-line-unresolved", null));
    } else {
      unitByPair.set(pair, matchingUnits[0]!);
    }
  }

  const units = [...new Set([...unitByPair.values()].map((unit) => unit.unitKey))];
  const observationRows = await loadObservations(db, units);
  const observationsByLabel = new Map<string, ObservationRow[]>();
  for (const observation of observationRows) {
    const key = observationKey(observation.unit_key, observation.language_code, observation.label);
    observationsByLabel.set(key, [...(observationsByLabel.get(key) ?? []), observation]);
  }

  const locatedPairs: LocatedPair[] = [];
  for (const [pair, unit] of unitByPair) {
    const observations =
      observationsByLabel.get(observationKey(unit.unitKey, unit.discoveryLanguageCode, pair.setName)) ?? [];
    if (observations.length === 0) {
      unresolved.set(pair, unresolvedPair(pair, "set-unresolved", unit.productDomain));
    } else if (observations.length !== 1) {
      unresolved.set(pair, unresolvedPair(pair, "set-ambiguous", unit.productDomain));
    } else {
      locatedPairs.push({ pair, unit, observation: observations[0]! });
    }
  }

  const mappingRows = await loadMappings(db, locatedPairs);
  const mappingsByObservation = new Map<string, MappingRow[]>();
  for (const mapping of mappingRows) {
    const key = mappingKey(mapping.unit_key, mapping.set_id);
    mappingsByObservation.set(key, [...(mappingsByObservation.get(key) ?? []), mapping]);
  }

  const resolved: HeldSetResolution["resolved"][number][] = [];
  for (const located of locatedPairs) {
    const mappings = mappingsByObservation.get(mappingKey(located.unit.unitKey, located.observation.external_id)) ?? [];
    if (mappings.length === 0) {
      unresolved.set(located.pair, unresolvedPair(located.pair, "mapping-missing", located.unit.productDomain));
      continue;
    }
    const accepted = mappings.filter(
      (mapping) =>
        (mapping.review_status === "accepted" || mapping.review_status === "auto-accepted") &&
        mapping.product_domain !== null &&
        mapping.scope_kind !== null,
    );
    if (accepted.length !== 1) {
      unresolved.set(located.pair, unresolvedPair(located.pair, "mapping-not-accepted", located.unit.productDomain));
      continue;
    }
    const mapping = accepted[0]!;
    resolved.push({
      scopeRecordId: mapping.scope_record_id,
      productDomain: mapping.product_domain!,
      scopeKind: mapping.scope_kind!,
      productLine: located.pair.productLine,
      setName: located.pair.setName,
      rowCount: located.pair.rowCount,
    });
  }

  resolved.sort(comparePairs);
  const unresolvedRows = [...unresolved.values()].sort(comparePairs);
  const resolvedRowCount = resolved.reduce((total, pair) => total + pair.rowCount, 0);
  const unresolvedRowCount = unresolvedRows.reduce((total, pair) => total + pair.rowCount, 0);
  return {
    resolved,
    unresolved: unresolvedRows,
    totals: {
      rows: parsed.totalRows,
      distinctPairs: parsed.pairs.length,
      resolvedPairs: resolved.length,
      unresolvedPairs: unresolvedRows.length,
      resolvedRows: resolvedRowCount,
      unresolvedRows: unresolvedRowCount,
    },
  };
}

function buildProductLineIndex(): ReadonlyMap<string, readonly TcgplayerSingleCardUnitConstraints[]> {
  const index = new Map<string, TcgplayerSingleCardUnitConstraints[]>();
  for (const unit of tcgplayerSingleCardUnitConstraints) {
    for (const name of unit.productLineNames) {
      const normalized = normalizeHeldSetLabel(name);
      const existing = index.get(normalized) ?? [];
      if (!existing.some((candidate) => candidate.unitKey === unit.unitKey)) index.set(normalized, [...existing, unit]);
    }
  }
  return index;
}

async function loadObservations(db: PgQueryable, unitKeys: readonly string[]): Promise<readonly ObservationRow[]> {
  if (unitKeys.length === 0) return [];
  const result = await db.query<ObservationRow>(
    `SELECT unit_key, scope_kind, language_code, external_id, label
     FROM catalog_provider_scope_observations
     WHERE provider_key = 'tcgplayer'
       AND unit_key = ANY($1::text[])
       AND language_code = 'en'
       AND scope_kind IN ('set', 'expansion')
     ORDER BY unit_key ASC, language_code ASC, label ASC, external_id ASC`,
    [unitKeys],
  );
  return result.rows;
}

async function loadMappings(db: PgQueryable, pairs: readonly LocatedPair[]): Promise<readonly MappingRow[]> {
  const unitKeys = [...new Set(pairs.map((pair) => pair.unit.unitKey))];
  const externalIds = [...new Set(pairs.map((pair) => pair.observation.external_id))];
  if (unitKeys.length === 0 || externalIds.length === 0) return [];
  const result = await db.query<MappingRow>(
    `SELECT
       m.unit_key,
       m.set_id,
       m.scope_record_id,
       m.review_status,
       r.product_domain,
       r.scope_kind
     FROM catalog_provider_scope_mappings m
     LEFT JOIN catalog_scope_records r ON r.scope_record_id = m.scope_record_id
     WHERE m.provider_key = 'tcgplayer'
       AND m.unit_key = ANY($1::text[])
       AND m.set_id = ANY($2::text[])
     ORDER BY m.unit_key ASC, m.set_id ASC, m.scope_record_id ASC, m.mapping_id ASC`,
    [unitKeys, externalIds],
  );
  return result.rows;
}

function observationKey(unitKey: string, languageCode: string, label: string): string {
  return `${unitKey}\u0000${languageCode}\u0000${normalizeHeldSetLabel(label)}`;
}

function mappingKey(unitKey: string, externalId: string): string {
  return `${unitKey}\u0000${externalId}`;
}

function unresolvedPair(
  pair: HeldSetPair,
  reason: HeldSetResolutionReason,
  productDomain: HeldSetResolution["unresolved"][number]["productDomain"],
): HeldSetResolution["unresolved"][number] {
  return { ...pair, reason, productDomain };
}

function comparePairs(
  left: Pick<HeldSetPair, "productLine" | "setName">,
  right: Pick<HeldSetPair, "productLine" | "setName">,
): number {
  return (
    normalizeHeldSetLabel(left.productLine).localeCompare(normalizeHeldSetLabel(right.productLine)) ||
    normalizeHeldSetLabel(left.setName).localeCompare(normalizeHeldSetLabel(right.setName))
  );
}
