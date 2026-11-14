import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { JsonObject } from "@chase-sets/primitives/json";
import {
  buildProviderScopeMappingCandidate,
  type BuildProviderScopeMappingCandidateInput,
  type ProviderScopeMappingCandidate,
  type ProviderScopeMappingReviewStatus,
} from "../../provider-scope-mapping/domain/mapping";
import {
  catalogScopeLanguageEditionFilter,
  catalogScopeProductDomainContracts,
  catalogScopeUnqualifiedLanguageCode,
  normalizeCatalogScopeProductDomain,
  type CatalogScopeLanguageEditionFilter,
  type CatalogScopeProductDomain,
  type CatalogScopeRecordKind,
} from "../../scope-registry/domain/contract";
import type {
  ProviderScopeDiscoveryTarget,
  ProviderScopeDiscoveryTargetClassification,
  ProviderScopeDiscoveryTargetClassifier,
} from "./discovery-targets";
import type { ProviderScopeObservationRecord } from "./refresh-schedule-store";
import {
  languageEditionCondition,
  listCanonicalScopeRecordProposals,
  normalizeScopeIdentifierKey,
  normalizeScopeMatchKey,
  proposeCanonicalScopeRecord,
  type CanonicalScopeRecordProposalRecord,
} from "./scope-record-proposal-store";

export type ScopeObservationMatchMethod =
  | "exact-id-or-code"
  | "normalized-name"
  | "accepted-alias"
  | "release-date-proximity"
  | "product-domain-contract"
  | "new-canonical-scope";

export type ScopeObservationMappingCandidate = Readonly<{
  candidate: ProviderScopeMappingCandidate;
  matchedBy: ScopeObservationMatchMethod;
}>;

type ScopeRecordRow = Readonly<{
  scope_record_id: string;
  reference_record_id: string;
  reference_record_key: string;
  scope_kind: CatalogScopeRecordKind;
  name: string;
  official_set_code: string | null;
  release_date: string | Date | null;
  aliases: readonly Readonly<{ normalizedAliasText: string; aliasType: string }>[];
}>;

type MatchableScopeRecord = Readonly<{
  scopeRecordId: string;
  scopeKind: CatalogScopeRecordKind;
  name: string;
  /** Normalized names that match by name; an accepted proposal adds its own to its Scope Record's. */
  matchNames: readonly string[];
  identityKeys: readonly string[];
  officialSetCode: string | null;
  releaseDate: string | null;
  aliases: readonly Readonly<{ normalizedAliasText: string; aliasType: string }>[];
  proposalStatus: CanonicalScopeRecordProposalRecord["reviewStatus"] | null;
}>;

const MATCHABLE_SCOPE_KINDS = new Set<CatalogScopeRecordKind>(["product-line", "series", "expansion", "set"]);

export const classifyProviderScopeDiscoveryTarget: ProviderScopeDiscoveryTargetClassifier = (
  input,
): ProviderScopeDiscoveryTargetClassification | null => {
  const productDomain = normalizeCatalogScopeProductDomain(input.productDomain);
  if (!productDomain) {
    return null;
  }

  switch (input.providerScope) {
    case "language":
      return { productDomain, scopeKind: "language" };
    case "product-line/category":
      return { productDomain, scopeKind: "product-line" };
    case "series":
      return { productDomain, scopeKind: "series" };
    case "expansion":
      return { productDomain, scopeKind: "expansion" };
    case "set-name":
      return {
        productDomain,
        scopeKind: catalogScopeProductDomainContracts[productDomain].leafReferenceTypeKey,
      };
    default:
      return null;
  }
};

export type ProviderScopeDiscoveryCascadeParent = Readonly<{
  parentValue: string;
  scopeRecordId: string;
}>;

export async function matchScopeObservationsToScopeRecords(
  db: PgQueryable,
  input: Readonly<{
    target: ProviderScopeDiscoveryTarget;
    observations: readonly ProviderScopeObservationRecord[];
    scanId: string;
  }>,
): Promise<readonly ScopeObservationMappingCandidate[]> {
  const productDomain = normalizeCatalogScopeProductDomain(input.target.productDomain);
  if (!productDomain) {
    return [];
  }

  const currentObservations = input.observations.filter((observation) =>
    MATCHABLE_SCOPE_KINDS.has(observation.scopeKind as CatalogScopeRecordKind),
  );
  if (currentObservations.length === 0) {
    return [];
  }

  if (input.target.providerScope === "product-line/category") {
    const canonicalRecords = await loadCanonicalScopeRecords(db, productDomain, null);
    const binding = contractProductLineBinding(input.target, currentObservations, canonicalRecords);
    if (!binding || !binding.observation.changed) {
      return [];
    }
    const candidate = mappingCandidate({
      observation: binding.observation,
      target: input.target,
      record: binding.record,
      matchedBy: "product-domain-contract",
      reviewStatus: "auto-accepted",
    });
    return candidate ? [{ matchedBy: "product-domain-contract", candidate }] : [];
  }

  const observations = currentObservations.filter((observation) => observation.changed);
  if (observations.length === 0) {
    return [];
  }

  // Every observation of a target is in the target's language. In a domain
  // that keeps one Scope Record per language edition it competes only with
  // records and proposals of that edition.
  const languageEdition = catalogScopeLanguageEditionFilter(productDomain, input.target.languageCode);
  const canonicalRecords = await loadCanonicalScopeRecords(db, productDomain, languageEdition);
  const eligibleAcceptedTargetIds =
    languageEdition && !isUnqualifiedLanguage(input.target.languageCode)
      ? new Set(canonicalRecords.map((record) => record.scope_record_id))
      : null;
  const proposals = await listCanonicalScopeRecordProposals(db, { productDomain, languageEdition, limit: 2_000 });
  const matchable = matchableScopeRecordSet([
    ...canonicalRecords.map(toMatchableCanonicalRecord),
    ...proposals
      .filter((proposal) => acceptedProposalTargetIsEligible(proposal, eligibleAcceptedTargetIds))
      .map(toMatchableProposal),
  ]);
  // The name match key keeps only Latin letters and digits, so it cannot
  // compare names outside the unqualified language: most Japanese names
  // normalize to nothing. Such observations match by id or code only, and a
  // new proposal takes the provider id as its code.
  const matchesByName = isUnqualifiedLanguage(input.target.languageCode);

  const candidates: ScopeObservationMappingCandidate[] = [];
  for (const observation of observations) {
    const scopeKind = observation.scopeKind as CatalogScopeRecordKind;
    const recordsForKind = matchable.records.filter((record) => record.scopeKind === scopeKind);
    const match = matchObservation(observation, recordsForKind, matchesByName);

    if (match) {
      for (const record of match.records) {
        if (record.proposalStatus === "rejected") {
          continue;
        }
        const candidate = mappingCandidate({
          observation,
          target: input.target,
          record,
          matchedBy: match.matchedBy,
          reviewStatus: record.proposalStatus === null && !match.wasAmbiguous ? "auto-accepted" : "proposed",
        });
        if (!candidate) {
          continue;
        }
        candidates.push({
          matchedBy: match.matchedBy,
          candidate,
        });
      }
      continue;
    }

    const proposal = await proposeCanonicalScopeRecord(db, {
      productDomain,
      scopeKind,
      name: observation.label,
      officialSetCode: observationSetCodes(observation)[0] ?? (matchesByName ? null : observation.externalId),
      releaseDate: observationReleaseDate(observation),
      languageEditions: [observation.languageCode],
      parentExternalIds: observation.parents,
      evidence: proposalEvidence(observation, input.target, input.scanId),
    });
    if (!acceptedProposalTargetIsEligible(proposal, eligibleAcceptedTargetIds)) {
      continue;
    }
    const record = toMatchableProposal(proposal);
    matchable.add(record);
    if (proposal.reviewStatus === "rejected") {
      continue;
    }
    const candidate = mappingCandidate({
      observation,
      target: input.target,
      record,
      matchedBy: "new-canonical-scope",
      reviewStatus: "proposed",
    });
    if (!candidate) {
      continue;
    }
    candidates.push({
      matchedBy: "new-canonical-scope",
      candidate,
    });
  }

  return candidates;
}

export async function resolveProviderScopeDiscoveryCascadeParent(
  db: PgQueryable,
  input: Readonly<{
    target: ProviderScopeDiscoveryTarget;
    parentObservations: readonly ProviderScopeObservationRecord[];
  }>,
): Promise<ProviderScopeDiscoveryCascadeParent | null> {
  if (!input.target.parentRequired || input.target.parentScope !== "product-line/category") {
    return null;
  }
  const productDomain = normalizeCatalogScopeProductDomain(input.target.productDomain);
  if (!productDomain) {
    return null;
  }
  const canonicalRecords = await loadCanonicalScopeRecords(db, productDomain, null);
  const binding = contractProductLineBinding(input.target, input.parentObservations, canonicalRecords);
  return binding ? { parentValue: binding.observation.externalId, scopeRecordId: binding.record.scopeRecordId } : null;
}

function contractProductLineBinding(
  target: ProviderScopeDiscoveryTarget,
  observations: readonly ProviderScopeObservationRecord[],
  canonicalRecords: readonly ScopeRecordRow[],
): Readonly<{ observation: ProviderScopeObservationRecord; record: MatchableScopeRecord }> | null {
  const productDomain = normalizeCatalogScopeProductDomain(target.productDomain);
  if (!productDomain) {
    return null;
  }
  const contractKey = catalogScopeProductDomainContracts[productDomain].productLineReferenceRecordKey;
  const records = canonicalRecords.filter(
    (record) => record.scope_kind === "product-line" && record.reference_record_key === contractKey,
  );
  const eligibleObservations = observations.filter(
    (observation) =>
      observation.providerKey === target.providerKey &&
      observation.unitKey === target.ingestionUnitKey &&
      observation.scopeKind === "product-line",
  );
  if (records.length !== 1 || eligibleObservations.length !== 1) {
    return null;
  }
  return { observation: eligibleObservations[0]!, record: toMatchableCanonicalRecord(records[0]!) };
}

async function loadCanonicalScopeRecords(
  db: PgQueryable,
  productDomain: CatalogScopeProductDomain,
  languageEdition: CatalogScopeLanguageEditionFilter | null,
): Promise<readonly ScopeRecordRow[]> {
  const params: unknown[] = [productDomain];
  const languageCondition = languageEdition
    ? `AND ${languageEditionCondition("records.language_editions", languageEdition, params)}`
    : "";
  const result = await db.query<ScopeRecordRow>(
    `SELECT records.scope_record_id,
            records.reference_record_id,
            records.reference_record_key,
            records.scope_kind,
            records.name,
            records.official_set_code,
            records.release_date,
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'normalizedAliasText', aliases.normalized_alias_text,
                  'aliasType', aliases.alias_type
                )
              ) FILTER (WHERE aliases.alias_hash IS NOT NULL),
              '[]'::jsonb
            ) AS aliases
     FROM catalog_scope_records records
     LEFT JOIN catalog_reference_record_aliases aliases
       ON aliases.reference_record_id = records.reference_record_id
      AND aliases.review_status IN ('accepted', 'auto-accepted')
      AND aliases.alias_type IN ('set-equivalent', 'series-equivalent')
     WHERE records.product_domain = $1
       AND records.lifecycle_status IN ('draft', 'active')
       ${languageCondition}
     GROUP BY records.scope_record_id,
              records.reference_record_id,
              records.reference_record_key,
              records.scope_kind,
              records.name,
              records.official_set_code,
              records.release_date`,
    params,
  );
  return result.rows;
}

function matchObservation(
  observation: ProviderScopeObservationRecord,
  records: readonly MatchableScopeRecord[],
  matchesByName: boolean,
): Readonly<{
  records: readonly MatchableScopeRecord[];
  matchedBy: ScopeObservationMatchMethod;
  wasAmbiguous: boolean;
}> | null {
  const identityKeys = new Set(
    [observation.externalId, ...observationSetCodes(observation)].flatMap(normalizedIdentifierKeys),
  );
  const byIdentity = records.filter((record) => record.identityKeys.some((key) => identityKeys.has(key)));
  if (byIdentity.length > 0) {
    return resolveAmbiguity(observation, byIdentity, "exact-id-or-code");
  }
  if (!matchesByName) {
    return null;
  }

  const normalizedName = normalizeScopeMatchKey(observation.label);
  const byName = records.filter((record) => record.matchNames.includes(normalizedName));
  if (byName.length > 0) {
    return resolveAmbiguity(observation, byName, "normalized-name");
  }

  if (observation.scopeKind === "product-line") {
    return null;
  }
  const aliasType = observation.scopeKind === "series" ? "series-equivalent" : "set-equivalent";
  const byAlias = records.filter((record) =>
    record.aliases.some(
      (alias) => alias.aliasType === aliasType && normalizeScopeMatchKey(alias.normalizedAliasText) === normalizedName,
    ),
  );
  return byAlias.length > 0 ? resolveAmbiguity(observation, byAlias, "accepted-alias") : null;
}

function resolveAmbiguity(
  observation: ProviderScopeObservationRecord,
  records: readonly MatchableScopeRecord[],
  matchedBy: Exclude<ScopeObservationMatchMethod, "release-date-proximity" | "new-canonical-scope">,
) {
  if (records.length === 1) {
    return { records, matchedBy, wasAmbiguous: false } as const;
  }

  const releaseDate = observationReleaseDate(observation);
  if (releaseDate) {
    const dated = records
      .filter((record): record is MatchableScopeRecord & { releaseDate: string } => record.releaseDate !== null)
      .map((record) => ({ record, distance: Math.abs(Date.parse(record.releaseDate) - Date.parse(releaseDate)) }))
      .sort(
        (left, right) =>
          left.distance - right.distance || left.record.scopeRecordId.localeCompare(right.record.scopeRecordId),
      );
    if (dated.length > 0 && (dated.length === 1 || dated[0]!.distance < dated[1]!.distance)) {
      return { records: [dated[0]!.record], matchedBy: "release-date-proximity", wasAmbiguous: true } as const;
    }
  }

  return {
    records: [...records].sort((left, right) => left.scopeRecordId.localeCompare(right.scopeRecordId)),
    matchedBy,
    wasAmbiguous: true,
  } as const;
}

function mappingCandidate(input: {
  observation: ProviderScopeObservationRecord;
  target: ProviderScopeDiscoveryTarget;
  record: MatchableScopeRecord;
  matchedBy: ScopeObservationMatchMethod;
  reviewStatus: ProviderScopeMappingReviewStatus;
}): ProviderScopeMappingCandidate | null {
  const coordinates = providerScopeMappingCoordinates(input.target, input.observation);
  if (!coordinates) {
    return null;
  }
  return buildProviderScopeMappingCandidate({
    scopeRecordId: input.record.scopeRecordId,
    providerKey: input.observation.providerKey,
    unitKey: input.observation.unitKey,
    coordinates,
    confidence:
      input.reviewStatus === "auto-accepted"
        ? "exact"
        : input.matchedBy === "new-canonical-scope"
          ? "generated"
          : "candidate",
    reviewStatus: input.reviewStatus,
    provenance: {
      source: "provider-scope-observation",
      sourceId: input.observation.observationHash,
      sourceProfileKey: input.target.profileKey,
      mappingFingerprint: input.observation.observationHash,
    },
    evidence: {
      observationHash: input.observation.observationHash,
      scopeKind: input.observation.scopeKind,
      externalId: input.observation.externalId,
      label: input.observation.label,
      parents: input.observation.parents,
      languageCode: input.observation.languageCode,
      matchedBy: input.matchedBy,
      scopeRecordName: input.record.name,
      scopeRecordOfficialSetCode: input.record.officialSetCode,
      proposedCanonicalScopeRecord: input.record.proposalStatus === "proposed",
    },
  });
}

export function providerScopeMappingCoordinates(
  target: ProviderScopeDiscoveryTarget,
  observation: ProviderScopeObservationRecord,
): BuildProviderScopeMappingCandidateInput["coordinates"] | null {
  const parentValue = observation.parents.length === 1 ? observation.parents[0]! : null;
  if (target.parentRequired && !parentValue) {
    return null;
  }
  const parentCoordinates = coordinatesForDeclaredParent(target.parentScope, parentValue);
  const language = { languageCode: observation.languageCode };
  switch (target.providerScope) {
    case "product-line/category":
      return { productLineId: observation.externalId, seriesId: null, setId: null, setName: null, language };
    case "series":
      return { ...parentCoordinates, seriesId: observation.externalId, setId: null, setName: null, language };
    case "expansion":
      return {
        ...parentCoordinates,
        setId: observation.externalId,
        setName: null,
        language,
      };
    case "set-name":
      return {
        ...parentCoordinates,
        setId: null,
        setName: observation.externalId,
        language,
      };
    default:
      return null;
  }
}

function coordinatesForDeclaredParent(
  parentScope: ProviderScopeDiscoveryTarget["parentScope"],
  parentValue: string | null,
): Readonly<{ productLineId: string | null; seriesId: string | null }> {
  return {
    productLineId: parentScope === "product-line/category" ? parentValue : null,
    seriesId: parentScope === "series" ? parentValue : null,
  };
}

function toMatchableCanonicalRecord(row: ScopeRecordRow): MatchableScopeRecord {
  return {
    scopeRecordId: row.scope_record_id,
    scopeKind: row.scope_kind,
    name: row.name,
    matchNames: [normalizeScopeMatchKey(row.name)],
    identityKeys: scopeRecordIdentityKeys(row),
    officialSetCode: row.official_set_code,
    releaseDate: dateOnly(row.release_date),
    aliases: row.aliases,
    proposalStatus: null,
  };
}

/**
 * An accepted proposal stands for its accepted Scope Record, never for its
 * `proposed-scope-*` id. Without edition filtering, it can match before that
 * Scope Record is projected, as a reviewable (never auto-accepted) target.
 */
function toMatchableProposal(proposal: CanonicalScopeRecordProposalRecord): MatchableScopeRecord {
  const scopeRecordId =
    proposal.reviewStatus === "accepted" && proposal.acceptedScopeRecordId
      ? proposal.acceptedScopeRecordId
      : proposal.scopeRecordId;
  return {
    scopeRecordId,
    scopeKind: proposal.scopeKind,
    name: proposal.name,
    matchNames: [normalizeScopeMatchKey(proposal.name)],
    identityKeys: scopeValueIdentityKeys([scopeRecordId, proposal.officialSetCode]),
    officialSetCode: proposal.officialSetCode,
    releaseDate: proposal.releaseDate,
    aliases: [],
    proposalStatus: proposal.reviewStatus,
  };
}

/** Proposal editions cannot authorize the editions of the record it was accepted onto. */
function acceptedProposalTargetIsEligible(
  proposal: CanonicalScopeRecordProposalRecord,
  eligibleAcceptedTargetIds: ReadonlySet<string> | null,
): boolean {
  return (
    eligibleAcceptedTargetIds === null ||
    proposal.reviewStatus !== "accepted" ||
    (proposal.acceptedScopeRecordId !== null && eligibleAcceptedTargetIds.has(proposal.acceptedScopeRecordId))
  );
}

/**
 * One match competitor per Scope Record id: an accepted proposal merges its
 * identity keys and name into the record it was accepted onto (the canonical
 * record when projected), so it never competes with that record.
 */
function matchableScopeRecordSet(initial: readonly MatchableScopeRecord[]) {
  const records: MatchableScopeRecord[] = [];
  const indexById = new Map<string, number>();
  const add = (record: MatchableScopeRecord): void => {
    const index = indexById.get(record.scopeRecordId);
    if (index === undefined) {
      indexById.set(record.scopeRecordId, records.length);
      records.push(record);
      return;
    }
    const existing = records[index]!;
    records[index] = {
      ...existing,
      matchNames: [...new Set([...existing.matchNames, ...record.matchNames])],
      identityKeys: [...new Set([...existing.identityKeys, ...record.identityKeys])],
    };
  };
  initial.forEach(add);
  return { records, add };
}

/** The matcher's identity keys for a projected Scope Record. */
export function scopeRecordIdentityKeys(
  row: Pick<ScopeRecordRow, "scope_record_id" | "reference_record_id" | "reference_record_key" | "official_set_code">,
): readonly string[] {
  return scopeValueIdentityKeys([
    row.scope_record_id,
    row.reference_record_id,
    row.reference_record_key,
    row.official_set_code,
  ]);
}

/** The matcher's identity keys for raw ids and codes. */
export function scopeValueIdentityKeys(values: readonly (string | null)[]): readonly string[] {
  return [
    ...new Set(values.filter((value): value is string => Boolean(value)).flatMap(normalizedIdentifierKeys)),
  ].filter(Boolean);
}

function normalizedIdentifierKeys(value: string): readonly string[] {
  return [normalizeScopeMatchKey(value), normalizeScopeIdentifierKey(value)];
}

function isUnqualifiedLanguage(languageCode: string): boolean {
  return languageCode.trim().toLowerCase() === catalogScopeUnqualifiedLanguageCode;
}

function observationSetCodes(observation: ProviderScopeObservationRecord): readonly string[] {
  const candidates: string[] = [];
  for (const key of ["abbreviation", "officialCode", "officialSetCode", "setCode", "code"]) {
    const value = observation.metadata[key];
    if (typeof value === "string" && value.trim()) {
      candidates.push(value.trim());
    }
  }
  return [...new Set(candidates)];
}

function observationReleaseDate(observation: ProviderScopeObservationRecord): string | null {
  for (const key of ["releaseDate", "release-date", "release_date", "releasedAt", "released_at"]) {
    const value = observation.metadata[key];
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
      return value.slice(0, 10);
    }
  }
  return null;
}

function proposalEvidence(
  observation: ProviderScopeObservationRecord,
  target: ProviderScopeDiscoveryTarget,
  scanId: string,
): JsonObject {
  return {
    [`observation:${observation.observationHash}`]: {
      providerKey: observation.providerKey,
      unitKey: observation.unitKey,
      externalId: observation.externalId,
      label: observation.label,
      languageCode: observation.languageCode,
      parents: observation.parents,
      profileKey: target.profileKey,
      scanId,
    },
  };
}

function dateOnly(value: string | Date | null): string | null {
  if (value === null) {
    return null;
  }
  return (value instanceof Date ? value.toISOString() : new Date(value).toISOString()).slice(0, 10);
}
