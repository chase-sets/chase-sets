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
  LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
  LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  runLorcanajsonCardReferenceValidationDryRun,
  runLorcanajsonSetReferenceValidationDryRun,
} from "./provider-adapters/lorcanajson";
import {
  LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
  LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
  runLorcastCardReferenceValidationDryRun,
  runLorcastSetReferenceValidationDryRun,
} from "./provider-adapters/lorcast";
import {
  runYgoprodeckCardReferenceValidationDryRun,
  runYgoprodeckSetReferenceValidationDryRun,
  YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
  YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
} from "./provider-adapters/ygoprodeck";
import {
  runYgojsonSealedProductReferenceValidationDryRun,
  runYgojsonSetReferenceValidationDryRun,
  YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
  YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
} from "./provider-adapters/ygojson";
import {
  runScryfallImageEvidenceValidationDryRun,
  runScryfallSourceObservationValidationDryRun,
  SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY,
  SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
} from "./provider-adapters/scryfall";
import {
  runTcgplayerMtgSealedProductSourceObservationImportProofDryRun,
  runTcgplayerMtgSingleCardSourceObservationImportProofDryRun,
  runTcgplayerLorcanaSealedProductSourceObservationImportProofDryRun,
  runTcgplayerLorcanaSingleCardSourceObservationImportProofDryRun,
  runTcgplayerOnePieceSealedProductSourceObservationImportProofDryRun,
  runTcgplayerOnePieceSingleCardSourceObservationImportProofDryRun,
  runTcgplayerPokemonSealedProductSourceObservationImportProofDryRun,
  runTcgplayerPokemonSingleCardSourceObservationImportProofDryRun,
  runTcgplayerYugiohSingleCardSourceObservationImportProofDryRun,
  TCGPLAYER_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "./provider-adapters/tcgplayer";
import {
  runScrydexLorcanaSetReferenceValidationDryRun,
  runScrydexLorcanaSingleCardSourceObservationImportProofDryRun,
  SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  runScrydexOnePieceSealedProductSourceObservationImportProofDryRun,
  runScrydexOnePieceSetReferenceValidationDryRun,
  runScrydexOnePieceSingleCardSourceObservationImportProofDryRun,
  SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "./provider-adapters/scrydex-one-piece";

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
    [LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY, runLorcanajsonCardReferenceValidationDryRun],
    [LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY, runLorcanajsonSetReferenceValidationDryRun],
    [LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY, runLorcastCardReferenceValidationDryRun],
    [LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY, runLorcastSetReferenceValidationDryRun],
    [SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY, runScryfallSourceObservationValidationDryRun],
    [SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY, runScryfallImageEvidenceValidationDryRun],
    [YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY, runYgoprodeckCardReferenceValidationDryRun],
    [YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY, runYgoprodeckSetReferenceValidationDryRun],
    [YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY, runYgojsonSetReferenceValidationDryRun],
    [YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY, runYgojsonSealedProductReferenceValidationDryRun],
    [
      TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      runTcgplayerMtgSingleCardSourceObservationImportProofDryRun,
    ],
    [
      TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      runTcgplayerMtgSealedProductSourceObservationImportProofDryRun,
    ],
    [
      TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      runTcgplayerPokemonSingleCardSourceObservationImportProofDryRun,
    ],
    [
      TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      runTcgplayerPokemonSealedProductSourceObservationImportProofDryRun,
    ],
    [
      TCGPLAYER_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      runTcgplayerLorcanaSingleCardSourceObservationImportProofDryRun,
    ],
    [
      TCGPLAYER_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      runTcgplayerLorcanaSealedProductSourceObservationImportProofDryRun,
    ],
    [
      TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      runTcgplayerYugiohSingleCardSourceObservationImportProofDryRun,
    ],
    [
      TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      runTcgplayerOnePieceSingleCardSourceObservationImportProofDryRun,
    ],
    [
      TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      runTcgplayerOnePieceSealedProductSourceObservationImportProofDryRun,
    ],
    [
      SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      runScrydexOnePieceSingleCardSourceObservationImportProofDryRun,
    ],
    [SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY, runScrydexOnePieceSetReferenceValidationDryRun],
    [
      SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      runScrydexOnePieceSealedProductSourceObservationImportProofDryRun,
    ],
    [
      SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      runScrydexLorcanaSingleCardSourceObservationImportProofDryRun,
    ],
    [SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY, runScrydexLorcanaSetReferenceValidationDryRun],
  ],
): CatalogIntegrationDryRunProofRegistry {
  return new Map(proofs);
}
