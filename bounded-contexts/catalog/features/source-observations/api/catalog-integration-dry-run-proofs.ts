import type { CatalogIntegrationDryRunResult } from "./catalog-integration-engine";
import type { CatalogIntegrationUnitKey } from "./integration-unit";
import {
  REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY,
  runReferenceCardsSourceObservationProofDryRun,
} from "./provider-adapters/reference-cards";
import {
  runTcgdexSourceObservationImportProofDryRun,
  TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "./provider-adapters/tcgdex";
import {
  MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY,
  MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  runMtgjsonSetReferenceValidationDryRun,
  runMtgjsonSourceObservationValidationDryRun,
} from "./provider-adapters/mtgjson";
import {
  runScryfallImageEvidenceValidationDryRun,
  runScryfallSourceObservationValidationDryRun,
  SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY,
  SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
} from "./provider-adapters/scryfall";

export type CatalogIntegrationDryRunProofRunner = () => Promise<CatalogIntegrationDryRunResult>;

export type CatalogIntegrationDryRunProofRegistry = ReadonlyMap<
  CatalogIntegrationUnitKey,
  CatalogIntegrationDryRunProofRunner
>;

export function createCatalogIntegrationDryRunProofRegistry(
  proofs: readonly (readonly [CatalogIntegrationUnitKey, CatalogIntegrationDryRunProofRunner])[] = [
    [
      REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY,
      runReferenceCardsSourceObservationProofDryRun,
    ],
    [TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY, runTcgdexSourceObservationImportProofDryRun],
    [MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY, runMtgjsonSourceObservationValidationDryRun],
    [MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY, runMtgjsonSetReferenceValidationDryRun],
    [SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY, runScryfallSourceObservationValidationDryRun],
    [SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY, runScryfallImageEvidenceValidationDryRun],
  ],
): CatalogIntegrationDryRunProofRegistry {
  return new Map(proofs);
}
