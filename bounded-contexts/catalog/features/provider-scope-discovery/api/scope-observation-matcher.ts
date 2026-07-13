import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildProviderScopeMappingCandidate,
  type ProviderScopeMappingCandidate,
} from "../../provider-scope-mapping/domain/mapping";
import type { CatalogProviderIngestionUnitProductDomain } from "../../source-observations/api/provider-integration-mapping-contract";
import type { ProviderScopeDiscoveryTarget } from "./discovery-targets";
import type { ProviderScopeObservationRecord } from "./refresh-schedule-store";

// Match newly observed provider scope options against canonical Catalog Scope
// Records and produce Provider Scope Mapping candidates. Matching is
// deliberately conservative: an exact official-set-code match auto-accepts, an
// exact normalized-name match only proposes (an operator confirms it in
// review), and anything ambiguous or unmatched is left for the unmapped-scope
// inbox slice rather than guessed at.
export type ScopeObservationMappingCandidate = Readonly<{
  candidate: ProviderScopeMappingCandidate;
  matchedBy: "official-set-code" | "normalized-name";
}>;

const SET_LEVEL_QUERY_KINDS = new Set(["expansions", "sets", "set-names"]);

type ScopeRecordRow = Readonly<{
  scope_record_id: string;
  scope_kind: string;
  name: string;
  official_set_code: string | null;
}>;

export async function matchScopeObservationsToScopeRecords(
  db: PgQueryable,
  input: Readonly<{
    target: ProviderScopeDiscoveryTarget;
    observations: readonly ProviderScopeObservationRecord[];
    scanId: string;
  }>,
): Promise<readonly ScopeObservationMappingCandidate[]> {
  const productDomain = registryProductDomain(input.target.productDomain);
  const unitKey = input.target.ingestionUnitKey;
  if (!productDomain || !unitKey) {
    return [];
  }

  const setLevelObservations = input.observations.filter(
    (observation) => observation.newlyObserved && SET_LEVEL_QUERY_KINDS.has(observation.queryKind),
  );
  if (setLevelObservations.length === 0) {
    return [];
  }

  const result = await db.query<ScopeRecordRow>(
    `SELECT scope_record_id, scope_kind, name, official_set_code
     FROM catalog_scope_records
     WHERE product_domain = $1
       AND scope_kind IN ('expansion', 'set')
       AND lifecycle_status IN ('draft', 'active')`,
    [productDomain],
  );

  const byCode = groupBy(
    result.rows.filter((row) => row.official_set_code),
    (row) => normalizeMatchKey(row.official_set_code!),
  );
  const byName = groupBy(result.rows, (row) => normalizeMatchKey(row.name));

  const candidates: ScopeObservationMappingCandidate[] = [];
  for (const observation of setLevelObservations) {
    const match = matchObservation(observation, byCode, byName);
    if (!match) {
      continue;
    }

    candidates.push({
      matchedBy: match.matchedBy,
      candidate: buildProviderScopeMappingCandidate({
        scopeRecordId: match.record.scope_record_id,
        providerKey: observation.providerKey,
        unitKey,
        coordinates: {
          setId: observation.optionExternalKey,
          setName: observation.displayName,
          seriesId: observation.queryKind === "expansions" ? observation.parentValue : null,
          language: { languageCode: observation.languageCode },
        },
        confidence: match.matchedBy === "official-set-code" ? "exact" : "high",
        reviewStatus: match.matchedBy === "official-set-code" ? "auto-accepted" : "proposed",
        provenance: {
          source: "scheduled-provider-scope-refresh",
          sourceId: input.scanId,
          sourceProfileKey: input.target.profileKey,
        },
        evidence: {
          queryKind: observation.queryKind,
          optionExternalKey: observation.optionExternalKey,
          displayName: observation.displayName,
          matchedBy: match.matchedBy,
          scopeRecordName: match.record.name,
          scopeRecordOfficialSetCode: match.record.official_set_code,
        },
      }),
    });
  }

  return candidates;
}

function matchObservation(
  observation: ProviderScopeObservationRecord,
  byCode: ReadonlyMap<string, readonly ScopeRecordRow[]>,
  byName: ReadonlyMap<string, readonly ScopeRecordRow[]>,
): Readonly<{ record: ScopeRecordRow; matchedBy: ScopeObservationMappingCandidate["matchedBy"] }> | null {
  for (const codeCandidate of observationSetCodeCandidates(observation)) {
    const records = byCode.get(normalizeMatchKey(codeCandidate));
    if (records?.length === 1) {
      return { record: records[0]!, matchedBy: "official-set-code" };
    }
  }

  const nameRecords = byName.get(normalizeMatchKey(observation.displayName));
  if (nameRecords?.length === 1) {
    return { record: nameRecords[0]!, matchedBy: "normalized-name" };
  }

  return null;
}

// Providers surface official set codes under different metadata names
// (abbreviation, officialCode, setCode) or as the option value itself.
function observationSetCodeCandidates(observation: ProviderScopeObservationRecord): readonly string[] {
  const candidates: string[] = [];
  for (const key of ["abbreviation", "officialCode", "officialSetCode", "setCode", "code"]) {
    const value = observation.metadata[key];
    if (typeof value === "string" && value.trim()) {
      candidates.push(value);
    }
  }
  candidates.push(observation.optionExternalKey);
  return candidates;
}

function registryProductDomain(domain: CatalogProviderIngestionUnitProductDomain | null): string | null {
  if (domain === null) {
    return null;
  }
  // Ingestion units say "mtg"; the scope registry's ubiquitous product-domain
  // vocabulary says "magic". Every other domain name is shared.
  return domain === "mtg" ? "magic" : domain;
}

function normalizeMatchKey(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): ReadonlyMap<string, readonly T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (!key) {
      continue;
    }
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}
