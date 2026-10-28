import type { JsonValue } from "@chase-sets/primitives/json";
import mtgjsonCardFixture from "../api/__fixtures__/mtgjson-card-reference/normal.json";
import mtgjsonSetFixture from "../api/__fixtures__/mtgjson-set-reference/normal.json";
import scryfallCardFixture from "../api/__fixtures__/scryfall-card-print/normal.json";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import { unitKeyForCatalogProviderProfileVersion } from "../api/governance/catalog-integration-impact-analysis";
import { buildCatalogMergeCandidatesFromObservations } from "../api/promotion/catalog-merge-candidate-matcher";
import {
  normalizeCatalogProviderSourceObservation,
  type CatalogProviderSourceObservationInput,
} from "../api/promotion/provider-source-observation-normalizer";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../api/provider-integration-profiles";
import { catalogProviderIntegrationProfileVersions } from "../api/providers/registry";
import { requireSourceObservationMappingContract } from "../api/source-observation-promotion-execution";
import type { CatalogMergeCandidateReviewSnapshot } from "../domain/catalog-merge-candidate";
import type { SourceObservationListRow } from "../read-model/queries";

/**
 * Magic provider roles exactly as registered at `2026.06.19`: MTGJSON card and
 * set reference data never promote Catalog Items, Scryfall card-print does, and
 * Scryfall image evidence does not. Observations come from each unit's
 * executable mapper over the checked-in Time Spiral fixtures (Fury Sliver,
 * collector number 157); any other collector number is an unmistakably
 * synthetic card in the same set.
 */
export const magicUnits = {
  "mtgjson-card": { providerKey: "mtgjson", profileKey: "mtg-card-reference-data" },
  "mtgjson-set": { providerKey: "mtgjson", profileKey: "mtg-set-reference-data" },
  "scryfall-card-print": { providerKey: "scryfall", profileKey: "mtg-card-print-reference-data" },
  "scryfall-image-evidence": { providerKey: "scryfall", profileKey: "mtg-card-image-evidence" },
} as const;

export type MagicUnit = keyof typeof magicUnits;
export type MagicCardUnit = Exclude<MagicUnit, "mtgjson-set">;

export const magicProfileVersion = "2026.06.19";
export const furySliver = "157";
export const magicSetName = "Time Spiral";

const observedAt = "2026-10-27T00:00:00.000Z";

export function registeredMagicProfile(unit: MagicUnit): CatalogProviderIntegrationProfileVersionRecord {
  const { providerKey, profileKey } = magicUnits[unit];
  const version = registeredMagicProfiles().find(
    (candidate) =>
      candidate.providerKey === providerKey &&
      candidate.profileKey === profileKey &&
      candidate.profileVersion === magicProfileVersion,
  );
  if (!version) throw new Error(`${unit} is not registered at ${magicProfileVersion}.`);
  return version;
}

/** Every checked-in MTGJSON and Scryfall profile version, unmodified. */
export function registeredMagicProfiles(): readonly CatalogProviderIntegrationProfileVersionRecord[] {
  return (
    catalogProviderIntegrationProfileVersions as readonly CatalogProviderIntegrationProfileVersionRecord[]
  ).filter((version) => version.providerKey === "mtgjson" || version.providerKey === "scryfall");
}

export type MagicCard = Readonly<{
  collectorNumber?: string;
  /**
   * Scryfall only. Scryfall card objects always carry `rarity`; the checked-in
   * fixture omits it, so the default supplies the rarity MTGJSON records for the
   * same printing. `null` keeps the fixture as checked in.
   */
  scryfallRarity?: string | null;
}>;

/** One Source Observation recorded through the unit's registered executable mapper. */
export function magicObservation(unit: MagicUnit, card: MagicCard = {}): CatalogProviderSourceObservationInput {
  const mapped = normalizeCatalogProviderSourceObservation({
    contract: requireSourceObservationMappingContract(registeredMagicProfile(unit)),
    payload:
      unit === "mtgjson-card"
        ? mtgjsonPayload(card)
        : unit === "mtgjson-set"
          ? mtgjsonSetFixture
          : scryfallPayload(card),
    observedAt,
  });
  if (mapped.diagnostics.length > 0 || !mapped.observation)
    throw new Error(`${unit} mapper refused the fixture: ${JSON.stringify(mapped.diagnostics)}`);
  return mapped.observation;
}

function mtgjsonPayload(card: MagicCard): JsonValue {
  const number = card.collectorNumber ?? furySliver;
  if (number === furySliver) return mtgjsonCardFixture;
  return {
    ...mtgjsonCardFixture,
    card: {
      ...mtgjsonCardFixture.card,
      uuid: `synthetic-mtgjson-${number}`,
      name: syntheticName(number),
      number,
      identifiers: { ...mtgjsonCardFixture.card.identifiers, scryfallId: syntheticScryfallId(number) },
    },
  };
}

function scryfallPayload(card: MagicCard): JsonValue {
  const number = card.collectorNumber ?? furySliver;
  const real = number === furySliver;
  const rarity = card.scryfallRarity === undefined ? mtgjsonCardFixture.card.rarity : card.scryfallRarity;
  return {
    ...scryfallCardFixture,
    card: {
      ...scryfallCardFixture.card,
      ...(real ? {} : { id: syntheticScryfallId(number), name: syntheticName(number), collector_number: number }),
      ...(rarity === null ? {} : { rarity }),
    },
  };
}

const syntheticName = (number: string) => `Synthetic Time Spiral card ${number}`;
const syntheticScryfallId = (number: string) => `synthetic-scryfall-${number}`;

/** The read-model row the matcher reads, as the projection writes it for a freshly recorded observation. */
export function observationRow(observation: CatalogProviderSourceObservationInput): SourceObservationListRow {
  return {
    observation_id: observation.observationId,
    sync_run_id: null,
    provider_key: observation.providerKey,
    external_key: observation.externalKey,
    source_url: observation.sourceUrl,
    language_code: observation.languageCode,
    source_record_hash: observation.sourceRecordHash,
    source_updated_at: observation.sourceUpdatedAt,
    observed_at: observation.observedAt,
    source_profile_key: observation.sourceProfileKey,
    source_profile_version: observation.sourceProfileVersion,
    source_mapping_fingerprint: observation.sourceMappingFingerprint,
    normalized: observation.normalized,
    status: "observed",
    status_reason: null,
    promoted_catalog_item_id: null,
    promoted_reference_record_id: null,
    promoted_at: null,
    promotion_profile_key: null,
    promotion_profile_version: null,
    promotion_plan_fingerprint: null,
    updated_at: observation.observedAt,
  };
}

/**
 * The real matcher over the given rows, with one accepted Time Spiral Provider
 * Scope Mapping per registered unit, so every row joins exactly one candidate.
 */
export function magicCandidate(
  rows: readonly SourceObservationListRow[],
  scopeRecordId: string,
): Readonly<{ candidateId: string; snapshot: CatalogMergeCandidateReviewSnapshot }> {
  const units = new Map(rows.map((row) => [row.observation_id, unitOf(row)]));
  const accepted = [...new Map([...units.values()].map((unit) => [unit.unitKey, unit])).values()];
  const batch = buildCatalogMergeCandidatesFromObservations(rows, {
    addedAt: observedAt,
    acceptedScopeMappings: accepted.map((unit) => acceptedTimeSpiralMapping(scopeRecordId, unit)),
    providerUnitKeyByObservationId: Object.fromEntries([...units].map(([id, unit]) => [id, unit.unitKey])),
  });
  if (batch.exclusions.length > 0 || batch.candidates.length !== 1)
    throw new Error(`Expected one Magic candidate: ${JSON.stringify(batch)}`);
  return batch.candidates[0]!;
}

function unitOf(row: SourceObservationListRow) {
  const version = registeredMagicProfiles().find(
    (candidate) =>
      candidate.providerKey === row.provider_key &&
      candidate.profileKey === row.source_profile_key &&
      candidate.profileVersion === row.source_profile_version,
  );
  if (!version) throw new Error(`${row.observation_id} was not recorded by a registered Magic unit.`);
  return { providerKey: version.providerKey, unitKey: unitKeyForCatalogProviderProfileVersion(version) };
}

function acceptedTimeSpiralMapping(
  scopeRecordId: string,
  unit: Readonly<{ providerKey: string; unitKey: string }>,
): ProviderScopeMappingRow {
  return {
    mapping_id: `map_${unit.unitKey}_${scopeRecordId}`,
    scope_record_id: scopeRecordId,
    provider_key: unit.providerKey,
    unit_key: unit.unitKey,
    product_line_id: null,
    series_id: null,
    set_id: null,
    set_name: magicSetName,
    language_coordinates: null,
    confidence: "exact",
    review_status: "accepted",
    provenance: {},
    evidence: {},
    last_actor: null,
    last_reason: null,
    policy_version: "synthetic",
    proposed_at: observedAt,
    reviewed_at: observedAt,
    updated_at: observedAt,
  } as unknown as ProviderScopeMappingRow;
}
