import type { JsonValue } from "@chase-sets/primitives/json";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderIngestionUnitIdentityContract,
  CatalogProviderIngestionUnitProductDomain,
} from "./provider-integration-mapping-contract";
import {
  defineCatalogProviderIngestionUnitIdentityContract,
  validateCatalogProviderExecutableMappingContract,
} from "./provider-integration-mapping-contract";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import { evaluateCatalogIntegrationFixtureCoverageFromProfileVersion } from "../governance/catalog-integration-fixture-lifecycle";
import type { CatalogProviderSourceObservationMappingContract } from "../promotion/provider-source-observation-normalizer";
import type {
  CatalogProviderIntegrationProfile,
  CatalogProviderIntegrationProfileVersionDiagnostic,
  CatalogProviderIntegrationProfileVersionRecord,
  CatalogProviderProfileVersionSelector,
} from "./profile-types";
import {
  mtgjsonMtgCardReferenceSourceObservationMappingContract,
  mtgjsonMtgSetReferenceSourceObservationMappingContract,
} from "./mtgjson/executable-mapping-contract";
import {
  lorcanajsonLorcanaCardReferenceSourceObservationMappingContract,
  lorcanajsonLorcanaSetReferenceSourceObservationMappingContract,
} from "./lorcanajson/executable-mapping-contract";
import {
  lorcastLorcanaCardReferenceSourceObservationMappingContract,
  lorcastLorcanaSetReferenceSourceObservationMappingContract,
} from "./lorcast/executable-mapping-contract";
import {
  ygoprodeckYugiohCardReferenceProviderProfile,
  ygoprodeckYugiohCardReferenceSourceObservationMappingContract,
  ygoprodeckYugiohSetReferenceProviderProfile,
  ygoprodeckYugiohSetReferenceSourceObservationMappingContract,
} from "./ygoprodeck/executable-mapping-contract";
import {
  ygojsonYugiohSealedProductReferenceProviderProfile,
  ygojsonYugiohSealedProductReferenceSourceObservationMappingContract,
  ygojsonYugiohSetReferenceProviderProfile,
  ygojsonYugiohSetReferenceSourceObservationMappingContract,
} from "./ygojson/executable-mapping-contract";
import {
  scryfallMtgCardPrintSourceObservationMappingContract,
  scryfallMtgImageEvidenceSourceObservationMappingContract,
} from "./scryfall/executable-mapping-contract";
import {
  SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION,
  scrydexLorcanaCardPrintSourceObservationMappingContract,
  scrydexLorcanaSealedProductSourceObservationMappingContract,
  scrydexLorcanaSetReferenceSourceObservationMappingContract,
} from "./scrydex/lorcana-executable-mapping-contract";
import {
  SCRYDEX_ONE_PIECE_PROFILE_VERSION,
  scrydexOnePieceCardPrintSourceObservationMappingContract,
  scrydexOnePieceSealedProductSourceObservationMappingContract,
  scrydexOnePieceSetReferenceSourceObservationMappingContract,
} from "./scrydex/one-piece-executable-mapping-contract";
import {
  TCGPLAYER_LORCANA_SINGLE_CARD_PROFILE_VERSION,
  TCGPLAYER_LORCANA_SEALED_PRODUCT_PROFILE_VERSION,
  tcgplayerLorcanaSingleCardProviderProductSourceObservationMappingContract,
  tcgplayerLorcanaSealedProductProviderProductSourceObservationMappingContract,
  TCGPLAYER_MTG_SINGLE_CARD_PROFILE_VERSION,
  tcgplayerMtgSingleCardProviderProductSourceObservationMappingContract,
  TCGPLAYER_MTG_SEALED_PRODUCT_PROFILE_VERSION,
  tcgplayerMtgSealedProductSourceObservationMappingContract,
  TCGPLAYER_ONE_PIECE_SINGLE_CARD_PROFILE_VERSION,
  TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_PROFILE_VERSION,
  TCGPLAYER_POKEMON_SINGLE_CARD_PROFILE_VERSION,
  TCGPLAYER_POKEMON_SEALED_PRODUCT_PROFILE_VERSION,
  tcgplayerOnePieceSingleCardProviderProductSourceObservationMappingContract,
  tcgplayerOnePieceSealedProductProviderProductSourceObservationMappingContract,
  tcgplayerPokemonSealedProductSourceObservationMappingContract,
  tcgplayerProviderProductSourceObservationMappingContract,
  TCGPLAYER_YUGIOH_SINGLE_CARD_PROFILE_VERSION,
  tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract,
} from "./tcgplayer/executable-mapping-contract";
import { tcgdexPokemonCardSourceObservationMappingContract } from "./tcgdex/executable-mapping-contract";
import {
  lorcanajsonLorcanaCardReferenceProviderProfile,
  lorcanajsonLorcanaSetReferenceProviderProfile,
} from "./lorcanajson/profiles";
import {
  lorcastLorcanaCardReferenceProviderProfile,
  lorcastLorcanaSetReferenceProviderProfile,
} from "./lorcast/profiles";
import { mtgjsonMtgCardReferenceProviderProfile, mtgjsonMtgSetReferenceProviderProfile } from "./mtgjson/profiles";
import {
  scrydexConnectorProfile,
  scrydexLorcanaCardPrintProviderProfile,
  scrydexLorcanaSealedProductProviderProfile,
  scrydexLorcanaSetReferenceProviderProfile,
  scrydexOnePieceCardPrintProviderProfile,
  scrydexOnePieceConnectorProfile,
  scrydexOnePieceSealedProductProviderProfile,
  scrydexOnePieceSetReferenceProviderProfile,
  scrydexScryfallCardProviderProfile,
} from "./scrydex/profiles";
import { scryfallMtgCardPrintProviderProfile, scryfallMtgImageEvidenceProviderProfile } from "./scryfall/profiles";
import { tcgdexPokemonTcgProviderProfile } from "./tcgdex/profiles";
import {
  tcgplayerAutomationClientProviderProfile,
  tcgplayerLorcanaSealedProductProviderProfile,
  tcgplayerLorcanaSingleCardProviderProfile,
  tcgplayerMtgSealedProductProviderProfile,
  tcgplayerMtgSingleCardProviderProfile,
  tcgplayerOnePieceSealedProductProviderProfile,
  tcgplayerOnePieceSingleCardProviderProfile,
  tcgplayerPokemonSealedProductProviderProfile,
  tcgplayerPokemonSingleCardProviderProfile,
  tcgplayerYugiohSingleCardProviderProfile,
} from "./tcgplayer/profiles";

export {
  lorcanajsonLorcanaCardReferenceProviderProfile,
  lorcanajsonLorcanaSetReferenceProviderProfile,
  lorcastLorcanaCardReferenceProviderProfile,
  lorcastLorcanaSetReferenceProviderProfile,
  mtgjsonMtgCardReferenceProviderProfile,
  mtgjsonMtgSetReferenceProviderProfile,
  scrydexConnectorProfile,
  scrydexLorcanaCardPrintProviderProfile,
  scrydexLorcanaSealedProductProviderProfile,
  scrydexLorcanaSetReferenceProviderProfile,
  scrydexOnePieceCardPrintProviderProfile,
  scrydexOnePieceConnectorProfile,
  scrydexOnePieceSealedProductProviderProfile,
  scrydexOnePieceSetReferenceProviderProfile,
  scrydexScryfallCardProviderProfile,
  scryfallMtgCardPrintProviderProfile,
  scryfallMtgImageEvidenceProviderProfile,
  tcgdexPokemonTcgProviderProfile,
  tcgplayerAutomationClientProviderProfile,
  tcgplayerLorcanaSealedProductProviderProfile,
  tcgplayerLorcanaSingleCardProviderProfile,
  tcgplayerMtgSealedProductProviderProfile,
  tcgplayerMtgSingleCardProviderProfile,
  tcgplayerOnePieceSealedProductProviderProfile,
  tcgplayerOnePieceSingleCardProviderProfile,
  tcgplayerPokemonSealedProductProviderProfile,
  tcgplayerPokemonSingleCardProviderProfile,
  tcgplayerYugiohSingleCardProviderProfile,
  ygojsonYugiohSealedProductReferenceProviderProfile,
  ygojsonYugiohSetReferenceProviderProfile,
  ygoprodeckYugiohCardReferenceProviderProfile,
  ygoprodeckYugiohSetReferenceProviderProfile,
};

export const catalogProviderIntegrationProfiles = [
  mtgjsonMtgCardReferenceProviderProfile,
  mtgjsonMtgSetReferenceProviderProfile,
  lorcanajsonLorcanaCardReferenceProviderProfile,
  lorcanajsonLorcanaSetReferenceProviderProfile,
  lorcastLorcanaCardReferenceProviderProfile,
  lorcastLorcanaSetReferenceProviderProfile,
  scryfallMtgCardPrintProviderProfile,
  scryfallMtgImageEvidenceProviderProfile,
  scrydexOnePieceCardPrintProviderProfile,
  scrydexOnePieceSetReferenceProviderProfile,
  scrydexOnePieceSealedProductProviderProfile,
  scrydexLorcanaCardPrintProviderProfile,
  scrydexLorcanaSetReferenceProviderProfile,
  scrydexLorcanaSealedProductProviderProfile,
  ygoprodeckYugiohCardReferenceProviderProfile,
  ygoprodeckYugiohSetReferenceProviderProfile,
  ygojsonYugiohSetReferenceProviderProfile,
  ygojsonYugiohSealedProductReferenceProviderProfile,
  tcgdexPokemonTcgProviderProfile,
  tcgplayerMtgSingleCardProviderProfile,
  tcgplayerMtgSealedProductProviderProfile,
  tcgplayerYugiohSingleCardProviderProfile,
  tcgplayerOnePieceSingleCardProviderProfile,
  tcgplayerOnePieceSealedProductProviderProfile,
  tcgplayerLorcanaSingleCardProviderProfile,
  tcgplayerLorcanaSealedProductProviderProfile,
  tcgplayerPokemonSealedProductProviderProfile,
  tcgplayerAutomationClientProviderProfile,
] as const satisfies readonly CatalogProviderIntegrationProfile[];

export const catalogProviderIntegrationProfileVersions = [
  {
    providerKey: "mtgjson",
    profileKey: "mtg-card-reference-data",
    profileVersion: "2026.06.19",
    ingestionUnitIdentity: mtgjsonMtgCardReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: mtgjsonMtgCardReferenceProviderProfile,
    sourceContract: mtgjsonMtgCardReferenceSourceObservationMappingContract.sourceContract,
    fixtures: mtgjsonMtgCardReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: mtgjsonMtgCardReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "mtgjson",
    profileKey: "mtg-set-reference-data",
    profileVersion: "2026.06.19",
    ingestionUnitIdentity: mtgjsonMtgSetReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: mtgjsonMtgSetReferenceProviderProfile,
    sourceContract: mtgjsonMtgSetReferenceSourceObservationMappingContract.sourceContract,
    fixtures: mtgjsonMtgSetReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: mtgjsonMtgSetReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "lorcanajson",
    profileKey: "lorcana-card-reference-data",
    profileVersion: lorcanajsonLorcanaCardReferenceSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity: lorcanajsonLorcanaCardReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: lorcanajsonLorcanaCardReferenceProviderProfile,
    sourceContract: lorcanajsonLorcanaCardReferenceSourceObservationMappingContract.sourceContract,
    fixtures: lorcanajsonLorcanaCardReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: lorcanajsonLorcanaCardReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "lorcanajson",
    profileKey: "lorcana-set-reference-data",
    profileVersion: lorcanajsonLorcanaSetReferenceSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity: lorcanajsonLorcanaSetReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: lorcanajsonLorcanaSetReferenceProviderProfile,
    sourceContract: lorcanajsonLorcanaSetReferenceSourceObservationMappingContract.sourceContract,
    fixtures: lorcanajsonLorcanaSetReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: lorcanajsonLorcanaSetReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "lorcast",
    profileKey: "lorcana-card-reference-data",
    profileVersion: lorcastLorcanaCardReferenceSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity: lorcastLorcanaCardReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: lorcastLorcanaCardReferenceProviderProfile,
    sourceContract: lorcastLorcanaCardReferenceSourceObservationMappingContract.sourceContract,
    fixtures: lorcastLorcanaCardReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: lorcastLorcanaCardReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "lorcast",
    profileKey: "lorcana-set-reference-data",
    profileVersion: lorcastLorcanaSetReferenceSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity: lorcastLorcanaSetReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: lorcastLorcanaSetReferenceProviderProfile,
    sourceContract: lorcastLorcanaSetReferenceSourceObservationMappingContract.sourceContract,
    fixtures: lorcastLorcanaSetReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: lorcastLorcanaSetReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "scryfall",
    profileKey: "mtg-card-print-reference-data",
    profileVersion: "2026.06.19",
    ingestionUnitIdentity: scryfallMtgCardPrintSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: scryfallMtgCardPrintProviderProfile,
    sourceContract: scryfallMtgCardPrintSourceObservationMappingContract.sourceContract,
    fixtures: scryfallMtgCardPrintSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: scryfallMtgCardPrintSourceObservationMappingContract,
  },
  {
    providerKey: "scryfall",
    profileKey: "mtg-card-image-evidence",
    profileVersion: "2026.06.19",
    ingestionUnitIdentity: scryfallMtgImageEvidenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: scryfallMtgImageEvidenceProviderProfile,
    sourceContract: scryfallMtgImageEvidenceSourceObservationMappingContract.sourceContract,
    fixtures: scryfallMtgImageEvidenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: scryfallMtgImageEvidenceSourceObservationMappingContract,
  },
  {
    providerKey: "scrydex",
    profileKey: "one-piece-card-print-source-observation",
    profileVersion: SCRYDEX_ONE_PIECE_PROFILE_VERSION,
    ingestionUnitIdentity: scrydexOnePieceCardPrintSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: scrydexOnePieceCardPrintProviderProfile,
    sourceContract: scrydexOnePieceCardPrintSourceObservationMappingContract.sourceContract,
    fixtures: scrydexOnePieceCardPrintSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: scrydexOnePieceCardPrintSourceObservationMappingContract,
  },
  {
    providerKey: "scrydex",
    profileKey: "one-piece-set-reference-data",
    profileVersion: SCRYDEX_ONE_PIECE_PROFILE_VERSION,
    ingestionUnitIdentity: scrydexOnePieceSetReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: scrydexOnePieceSetReferenceProviderProfile,
    sourceContract: scrydexOnePieceSetReferenceSourceObservationMappingContract.sourceContract,
    fixtures: scrydexOnePieceSetReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: scrydexOnePieceSetReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "scrydex",
    profileKey: "one-piece-sealed-product-source-observation",
    profileVersion: SCRYDEX_ONE_PIECE_PROFILE_VERSION,
    ingestionUnitIdentity: scrydexOnePieceSealedProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: scrydexOnePieceSealedProductProviderProfile,
    sourceContract: scrydexOnePieceSealedProductSourceObservationMappingContract.sourceContract,
    fixtures: scrydexOnePieceSealedProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: scrydexOnePieceSealedProductSourceObservationMappingContract,
  },
  {
    providerKey: "scrydex",
    profileKey: "lorcana-card-print-source-observation",
    profileVersion: SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION,
    ingestionUnitIdentity: scrydexLorcanaCardPrintSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: scrydexLorcanaCardPrintProviderProfile,
    sourceContract: scrydexLorcanaCardPrintSourceObservationMappingContract.sourceContract,
    fixtures: scrydexLorcanaCardPrintSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: scrydexLorcanaCardPrintSourceObservationMappingContract,
  },
  {
    providerKey: "scrydex",
    profileKey: "lorcana-set-reference-data",
    profileVersion: SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION,
    ingestionUnitIdentity: scrydexLorcanaSetReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: scrydexLorcanaSetReferenceProviderProfile,
    sourceContract: scrydexLorcanaSetReferenceSourceObservationMappingContract.sourceContract,
    fixtures: scrydexLorcanaSetReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: scrydexLorcanaSetReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "scrydex",
    profileKey: "lorcana-sealed-product-source-observation",
    profileVersion: SCRYDEX_LORCANA_PRODUCTION_PROFILE_VERSION,
    ingestionUnitIdentity: scrydexLorcanaSealedProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "test",
    active: false,
    profile: scrydexLorcanaSealedProductProviderProfile,
    sourceContract: scrydexLorcanaSealedProductSourceObservationMappingContract.sourceContract,
    fixtures: scrydexLorcanaSealedProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: scrydexLorcanaSealedProductSourceObservationMappingContract,
  },
  {
    providerKey: "ygoprodeck",
    profileKey: "yugioh-card-print-reference-data",
    profileVersion: ygoprodeckYugiohCardReferenceSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity: ygoprodeckYugiohCardReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: ygoprodeckYugiohCardReferenceProviderProfile,
    sourceContract: ygoprodeckYugiohCardReferenceSourceObservationMappingContract.sourceContract,
    fixtures: ygoprodeckYugiohCardReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: ygoprodeckYugiohCardReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "ygoprodeck",
    profileKey: "yugioh-set-reference-data",
    profileVersion: ygoprodeckYugiohSetReferenceSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity: ygoprodeckYugiohSetReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: ygoprodeckYugiohSetReferenceProviderProfile,
    sourceContract: ygoprodeckYugiohSetReferenceSourceObservationMappingContract.sourceContract,
    fixtures: ygoprodeckYugiohSetReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: ygoprodeckYugiohSetReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "ygojson",
    profileKey: "yugioh-set-reference-data",
    profileVersion: ygojsonYugiohSetReferenceSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity: ygojsonYugiohSetReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: ygojsonYugiohSetReferenceProviderProfile,
    sourceContract: ygojsonYugiohSetReferenceSourceObservationMappingContract.sourceContract,
    fixtures: ygojsonYugiohSetReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: ygojsonYugiohSetReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "ygojson",
    profileKey: "yugioh-sealed-product-reference-data",
    profileVersion: ygojsonYugiohSealedProductReferenceSourceObservationMappingContract.profileVersion,
    ingestionUnitIdentity: ygojsonYugiohSealedProductReferenceSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: ygojsonYugiohSealedProductReferenceProviderProfile,
    sourceContract: ygojsonYugiohSealedProductReferenceSourceObservationMappingContract.sourceContract,
    fixtures: ygojsonYugiohSealedProductReferenceSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: ygojsonYugiohSealedProductReferenceSourceObservationMappingContract,
  },
  {
    providerKey: "tcgdex",
    profileKey: "pokemon-tcg",
    profileVersion: "2026.06.03",
    lifecycle: "active",
    active: true,
    profile: tcgdexPokemonTcgProviderProfile,
    sourceContract: tcgdexPokemonCardSourceObservationMappingContract.sourceContract,
    fixtures: tcgdexPokemonCardSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgdexPokemonCardSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "mtg-single-card-product-sku",
    profileVersion: TCGPLAYER_MTG_SINGLE_CARD_PROFILE_VERSION,
    ingestionUnitIdentity: tcgplayerMtgSingleCardProviderProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerMtgSingleCardProviderProfile,
    sourceContract: tcgplayerMtgSingleCardProviderProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerMtgSingleCardProviderProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerMtgSingleCardProviderProductSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "mtg-sealed-product-sku",
    profileVersion: TCGPLAYER_MTG_SEALED_PRODUCT_PROFILE_VERSION,
    ingestionUnitIdentity: tcgplayerMtgSealedProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerMtgSealedProductProviderProfile,
    sourceContract: tcgplayerMtgSealedProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerMtgSealedProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerMtgSealedProductSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "yugioh-single-card-product-sku",
    profileVersion: TCGPLAYER_YUGIOH_SINGLE_CARD_PROFILE_VERSION,
    ingestionUnitIdentity:
      tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerYugiohSingleCardProviderProfile,
    sourceContract: tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerYugiohSingleCardProviderProductSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "one-piece-single-card-product-sku",
    profileVersion: TCGPLAYER_ONE_PIECE_SINGLE_CARD_PROFILE_VERSION,
    ingestionUnitIdentity:
      tcgplayerOnePieceSingleCardProviderProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerOnePieceSingleCardProviderProfile,
    sourceContract: tcgplayerOnePieceSingleCardProviderProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerOnePieceSingleCardProviderProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerOnePieceSingleCardProviderProductSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "one-piece-sealed-product-sku",
    profileVersion: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_PROFILE_VERSION,
    ingestionUnitIdentity:
      tcgplayerOnePieceSealedProductProviderProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerOnePieceSealedProductProviderProfile,
    sourceContract: tcgplayerOnePieceSealedProductProviderProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerOnePieceSealedProductProviderProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerOnePieceSealedProductProviderProductSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "lorcana-single-card-product-sku",
    profileVersion: TCGPLAYER_LORCANA_SINGLE_CARD_PROFILE_VERSION,
    ingestionUnitIdentity:
      tcgplayerLorcanaSingleCardProviderProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerLorcanaSingleCardProviderProfile,
    sourceContract: tcgplayerLorcanaSingleCardProviderProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerLorcanaSingleCardProviderProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerLorcanaSingleCardProviderProductSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "lorcana-sealed-product-sku",
    profileVersion: TCGPLAYER_LORCANA_SEALED_PRODUCT_PROFILE_VERSION,
    ingestionUnitIdentity:
      tcgplayerLorcanaSealedProductProviderProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerLorcanaSealedProductProviderProfile,
    sourceContract: tcgplayerLorcanaSealedProductProviderProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerLorcanaSealedProductProviderProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerLorcanaSealedProductProviderProductSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "pokemon-single-card-product-sku",
    profileVersion: TCGPLAYER_POKEMON_SINGLE_CARD_PROFILE_VERSION,
    ingestionUnitIdentity: tcgplayerProviderProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerPokemonSingleCardProviderProfile,
    sourceContract: tcgplayerProviderProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerProviderProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerProviderProductSourceObservationMappingContract,
  },
  {
    providerKey: "tcgplayer",
    profileKey: "pokemon-sealed-product-sku",
    profileVersion: TCGPLAYER_POKEMON_SEALED_PRODUCT_PROFILE_VERSION,
    ingestionUnitIdentity: tcgplayerPokemonSealedProductSourceObservationMappingContract.ingestionUnitIdentity,
    lifecycle: "active",
    active: true,
    profile: tcgplayerPokemonSealedProductProviderProfile,
    sourceContract: tcgplayerPokemonSealedProductSourceObservationMappingContract.sourceContract,
    fixtures: tcgplayerPokemonSealedProductSourceObservationMappingContract.fixtures,
    retirementPlan: null,
    executableMappingContract: tcgplayerPokemonSealedProductSourceObservationMappingContract,
  },
] as const satisfies readonly CatalogProviderIntegrationProfileVersionRecord[];

export function listCatalogProviderIntegrationProfiles(): readonly CatalogProviderIntegrationProfile[] {
  return listCatalogProviderIntegrationProfileVersions().map((version) => version.profile);
}

export function getCatalogProviderIntegrationProfile(providerKey: string): CatalogProviderIntegrationProfile | null {
  return getCatalogProviderIntegrationProfileVersion(providerKey)?.profile ?? null;
}

export function listCatalogProviderIntegrationProfileVersions(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): readonly CatalogProviderIntegrationProfileVersionRecord[] {
  return [...versions].sort((left, right) =>
    left.providerKey === right.providerKey
      ? right.profileVersion.localeCompare(left.profileVersion)
      : left.providerKey.localeCompare(right.providerKey),
  );
}

export function getCatalogProviderIntegrationProfileVersion(
  providerKey: string,
  profileVersion?: string | null,
  selectorOrVersions?:
    | CatalogProviderProfileVersionSelector
    | readonly CatalogProviderIntegrationProfileVersionRecord[]
    | null,
  versionsInput?: readonly CatalogProviderIntegrationProfileVersionRecord[],
): CatalogProviderIntegrationProfileVersionRecord | null {
  const selector: CatalogProviderProfileVersionSelector | null | undefined = Array.isArray(selectorOrVersions)
    ? null
    : (selectorOrVersions as CatalogProviderProfileVersionSelector | null | undefined);
  const versions = Array.isArray(selectorOrVersions)
    ? selectorOrVersions
    : (versionsInput ?? catalogProviderIntegrationProfileVersions);
  const normalizedProviderKey = normalizeProviderKey(providerKey);
  const normalizedVersion = profileVersion?.trim() ?? "";
  const candidates = versions.filter((version) => normalizeProviderKey(version.providerKey) === normalizedProviderKey);

  if (normalizedVersion.length > 0) {
    return selectCatalogProviderProfileVersion(
      normalizedProviderKey,
      candidates.filter((version) => version.profileVersion === normalizedVersion),
      selector,
      normalizedVersion,
    );
  }

  if (selector) {
    return (
      selectActiveCatalogProviderProfileVersion(
        normalizedProviderKey,
        candidates.filter((version) => version.active && version.lifecycle === "active"),
        selector,
      ) ??
      candidates.find(
        (version) => version.lifecycle === "test" && catalogProviderProfileVersionMatchesSelector(version, selector),
      ) ??
      candidates.find(
        (version) => version.lifecycle === "draft" && catalogProviderProfileVersionMatchesSelector(version, selector),
      ) ??
      null
    );
  }

  return (
    candidates.find((version) => version.active) ??
    candidates.find((version) => version.lifecycle === "test") ??
    candidates.find((version) => version.lifecycle === "draft") ??
    null
  );
}

export function getActiveCatalogProviderIntegrationProfileVersion(
  providerKey: string,
  selectorOrVersions?:
    | CatalogProviderProfileVersionSelector
    | readonly CatalogProviderIntegrationProfileVersionRecord[]
    | null,
  versionsInput?: readonly CatalogProviderIntegrationProfileVersionRecord[],
): CatalogProviderIntegrationProfileVersionRecord | null {
  const selector: CatalogProviderProfileVersionSelector | null | undefined = Array.isArray(selectorOrVersions)
    ? null
    : (selectorOrVersions as CatalogProviderProfileVersionSelector | null | undefined);
  const versions = Array.isArray(selectorOrVersions)
    ? selectorOrVersions
    : (versionsInput ?? catalogProviderIntegrationProfileVersions);
  const normalizedProviderKey = normalizeProviderKey(providerKey);
  const candidates = versions.filter(
    (version) =>
      normalizeProviderKey(version.providerKey) === normalizedProviderKey &&
      version.active &&
      version.lifecycle === "active",
  );

  return selectActiveCatalogProviderProfileVersion(normalizedProviderKey, candidates, selector);
}

export function getActiveCatalogProviderSourceObservationMappingContract(
  providerKey: string,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): CatalogProviderSourceObservationMappingContract | null {
  const contract = getActiveCatalogProviderIntegrationProfileVersion(
    providerKey,
    null,
    versions,
  )?.executableMappingContract;
  if (!contract?.sourceObservation) {
    return null;
  }

  return contract as CatalogProviderSourceObservationMappingContract;
}

export function requireActiveCatalogProviderSourceObservationMappingContract(
  providerKey: string,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): CatalogProviderSourceObservationMappingContract {
  const contract = getActiveCatalogProviderSourceObservationMappingContract(providerKey, versions);
  if (!contract) {
    throw new Error(`Catalog provider '${providerKey}' does not have an active Source Observation mapping contract.`);
  }

  return contract;
}

export function getCatalogProviderSourceObservationMappingContract(
  providerKey: string,
  profileVersion?: string | null,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): CatalogProviderSourceObservationMappingContract | null {
  const contract = getCatalogProviderIntegrationProfileVersion(
    providerKey,
    profileVersion,
    null,
    versions,
  )?.executableMappingContract;
  if (!contract?.sourceObservation) {
    return null;
  }

  return contract as CatalogProviderSourceObservationMappingContract;
}

export function requireCatalogProviderSourceObservationMappingContract(
  providerKey: string,
  profileVersion?: string | null,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): CatalogProviderSourceObservationMappingContract {
  const contract = getCatalogProviderSourceObservationMappingContract(providerKey, profileVersion, versions);
  if (!contract) {
    throw new Error(`Catalog provider '${providerKey}' does not have a Source Observation mapping contract.`);
  }

  return contract;
}

export function validateCatalogProviderIntegrationProfileVersion(
  version: CatalogProviderIntegrationProfileVersionRecord,
): readonly CatalogProviderIntegrationProfileVersionDiagnostic[] {
  const diagnostics: CatalogProviderIntegrationProfileVersionDiagnostic[] = [];

  if (normalizeProviderKey(version.providerKey) !== normalizeProviderKey(version.profile.providerKey)) {
    diagnostics.push({
      code: "provider-key-mismatch",
      path: "profile.providerKey",
      diagnosticText: "The profile payload provider key must match the version record provider key.",
    });
  }

  if (version.profileVersion.trim().length === 0) {
    diagnostics.push({
      code: "missing-profile-version",
      path: "profileVersion",
      diagnosticText: "Provider profile versions must carry a version for replay and rollback.",
    });
  }

  if (isRetiredMagicScrydexProofActive(version)) {
    diagnostics.push({
      code: "retired-magic-scrydex-proof-active",
      path: "profile.connector.kind",
      diagnosticText:
        "The retired Scrydex Scryfall-style Magic proof is test-scoped evidence and cannot be activated as a production sync unit. Use MTGJSON, Scryfall, and TCGplayer Magic profiles for production Magic sync.",
    });
  }

  for (const fixtureDiagnostic of evaluateCatalogIntegrationFixtureCoverageFromProfileVersion({ version })) {
    if (fixtureDiagnostic.code === "fixture-missing-flow") {
      diagnostics.push({
        code: "missing-profile-fixture-flow",
        path: fixtureDiagnostic.path,
        diagnosticText: fixtureDiagnostic.diagnosticText,
      });
    }
    if (fixtureDiagnostic.code === "fixture-live-provider-calls") {
      diagnostics.push({
        code: "fixture-live-provider-calls",
        path: fixtureDiagnostic.path,
        diagnosticText: fixtureDiagnostic.diagnosticText,
      });
    }
  }

  if (!version.executableMappingContract) {
    diagnostics.push({
      code: "missing-executable-mapping-contract",
      path: "executableMappingContract",
      diagnosticText: "Executable profile versions must carry a mapping contract before activation.",
    });
    return diagnostics;
  }

  if (
    normalizeProviderKey(version.executableMappingContract.providerKey) !== normalizeProviderKey(version.providerKey) ||
    version.executableMappingContract.profileKey !== version.profileKey ||
    version.executableMappingContract.profileVersion !== version.profileVersion ||
    version.executableMappingContract.lifecycle !== version.lifecycle
  ) {
    diagnostics.push({
      code: "mapping-contract-mismatch",
      path: "executableMappingContract",
      diagnosticText: "The executable mapping contract identity must match the profile version record.",
    });
  }

  if (
    version.ingestionUnitIdentity &&
    version.executableMappingContract.ingestionUnitIdentity &&
    !sameIngestionUnitIdentity(version.ingestionUnitIdentity, version.executableMappingContract.ingestionUnitIdentity)
  ) {
    diagnostics.push({
      code: "ingestion-unit-identity-mismatch",
      path: "executableMappingContract.ingestionUnitIdentity",
      diagnosticText: "The executable mapping contract ingestion-unit identity must match the profile version record.",
    });
  }

  for (const mappingDiagnostic of validateCatalogProviderExecutableMappingContract(version.executableMappingContract)) {
    diagnostics.push({
      code: "mapping-contract-diagnostic",
      path: `executableMappingContract.${mappingDiagnostic.path}`,
      diagnosticText: mappingDiagnostic.diagnosticText,
      mappingDiagnostic,
    });
  }

  return diagnostics;
}

function isRetiredMagicScrydexProofActive(version: CatalogProviderIntegrationProfileVersionRecord): boolean {
  return (
    version.active &&
    version.lifecycle === "active" &&
    normalizeProviderKey(version.providerKey) === "scrydex" &&
    (version.profile.connector.kind === "scrydex-scryfall-json" || version.profileKey === "scryfall-card-fixture")
  );
}

function sameIngestionUnitIdentity(
  expected: CatalogProviderIngestionUnitIdentityContract,
  actual: CatalogProviderIngestionUnitIdentityContract | undefined,
): boolean {
  if (!actual) {
    return false;
  }

  return (
    actual.unitKey === expected.unitKey &&
    actual.providerKey === expected.providerKey &&
    actual.productDomain === expected.productDomain &&
    actual.productForm === expected.productForm &&
    actual.ingestionPurpose === expected.ingestionPurpose
  );
}

export function activateCatalogProviderIntegrationProfileVersion(
  providerKey: string,
  profileVersion: string,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
  selector?: CatalogProviderProfileVersionSelector | null,
): readonly CatalogProviderIntegrationProfileVersionRecord[] {
  const normalizedProviderKey = normalizeProviderKey(providerKey);
  const target = getCatalogProviderIntegrationProfileVersion(providerKey, profileVersion, selector, versions);
  if (!target) {
    throw new Error(`Catalog provider profile version ${normalizedProviderKey}@${profileVersion} was not found.`);
  }

  const diagnostics = validateCatalogProviderIntegrationProfileVersion({
    ...target,
    lifecycle: "active",
    active: true,
    executableMappingContract: target.executableMappingContract
      ? {
          ...target.executableMappingContract,
          lifecycle: "active",
        }
      : undefined,
  });
  if (diagnostics.length > 0) {
    throw new Error(
      `Catalog provider profile version ${normalizedProviderKey}@${profileVersion} failed activation validation: ${diagnostics
        .map((diagnostic) => diagnostic.diagnosticText)
        .join(" ")}`,
    );
  }

  return versions.map((version) => {
    if (normalizeProviderKey(version.providerKey) !== normalizedProviderKey) {
      return version;
    }
    if (sameCatalogProviderProfileVersionIdentity(version, target)) {
      return {
        ...version,
        lifecycle: "active",
        active: true,
        executableMappingContract: version.executableMappingContract
          ? {
              ...version.executableMappingContract,
              lifecycle: "active",
            }
          : undefined,
      };
    }
    return version.active && catalogProviderProfileVersionsCompete(version, target)
      ? {
          ...version,
          lifecycle: "deprecated",
          active: false,
          executableMappingContract: version.executableMappingContract
            ? {
                ...version.executableMappingContract,
                lifecycle: "deprecated",
              }
            : undefined,
        }
      : version;
  });
}

export function rollbackCatalogProviderIntegrationProfileVersion(
  providerKey: string,
  rollbackToProfileVersion: string,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
  selector?: CatalogProviderProfileVersionSelector | null,
): readonly CatalogProviderIntegrationProfileVersionRecord[] {
  return activateCatalogProviderIntegrationProfileVersion(providerKey, rollbackToProfileVersion, versions, selector);
}

export function metadataObject(entries: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  return entries;
}

function normalizeProviderKey(providerKey: string): string {
  return providerKey.trim().toLowerCase();
}

export function catalogProviderProfileVersionIngestionUnitKey(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogIntegrationUnitKey {
  return (
    version.ingestionUnitIdentity?.unitKey ??
    version.executableMappingContract?.ingestionUnitIdentity?.unitKey ??
    inferCatalogProviderIngestionUnitKey(version)
  );
}

export function catalogProviderProfileVersionsCompete(
  candidate: CatalogProviderIntegrationProfileVersionRecord,
  target: CatalogProviderIntegrationProfileVersionRecord,
): boolean {
  if (normalizeProviderKey(candidate.providerKey) !== normalizeProviderKey(target.providerKey)) {
    return false;
  }

  return (
    candidate.profileKey === target.profileKey ||
    catalogProviderProfileVersionIngestionUnitKey(candidate) === catalogProviderProfileVersionIngestionUnitKey(target)
  );
}

export function selectActiveCatalogProviderProfileVersion(
  providerKey: string,
  activeVersions: readonly CatalogProviderIntegrationProfileVersionRecord[],
  selector?: CatalogProviderProfileVersionSelector | null,
): CatalogProviderIntegrationProfileVersionRecord | null {
  const normalizedProfileKey = selector?.profileKey?.trim().toLowerCase() ?? "";
  const normalizedUnitKey = selector?.ingestionUnitKey?.trim().toLowerCase() ?? "";
  const selected =
    normalizedProfileKey || normalizedUnitKey
      ? activeVersions.filter(
          (version) =>
            (!normalizedProfileKey || version.profileKey.trim().toLowerCase() === normalizedProfileKey) &&
            (!normalizedUnitKey ||
              catalogProviderProfileVersionIngestionUnitKey(version).trim().toLowerCase() === normalizedUnitKey),
        )
      : activeVersions;

  if (selected.length === 0) {
    return null;
  }
  if (selected.length === 1) {
    return selected[0] ?? null;
  }

  const options = selected
    .map(
      (version) =>
        `${version.providerKey}/${version.profileKey}@${version.profileVersion} (${catalogProviderProfileVersionIngestionUnitKey(
          version,
        )})`,
    )
    .join(", ");
  const selectorText =
    normalizedProfileKey || normalizedUnitKey
      ? `profileKey='${normalizedProfileKey || "*"}' ingestionUnitKey='${normalizedUnitKey || "*"}'`
      : "no profileKey or ingestionUnitKey";
  throw new Error(
    `Catalog provider '${normalizeProviderKey(
      providerKey,
    )}' has multiple active profile units for ${selectorText}. Select a profileKey or ingestionUnitKey. Active versions: ${options}.`,
  );
}

function catalogProviderProfileVersionMatchesSelector(
  version: CatalogProviderIntegrationProfileVersionRecord,
  selector: CatalogProviderProfileVersionSelector,
): boolean {
  const normalizedProfileKey = selector.profileKey?.trim().toLowerCase() ?? "";
  const normalizedUnitKey = selector.ingestionUnitKey?.trim().toLowerCase() ?? "";
  return (
    (!normalizedProfileKey || version.profileKey.trim().toLowerCase() === normalizedProfileKey) &&
    (!normalizedUnitKey ||
      catalogProviderProfileVersionIngestionUnitKey(version).trim().toLowerCase() === normalizedUnitKey)
  );
}

function selectCatalogProviderProfileVersion(
  providerKey: string,
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
  selector: CatalogProviderProfileVersionSelector | null | undefined,
  profileVersion: string,
): CatalogProviderIntegrationProfileVersionRecord | null {
  const normalizedProfileKey = selector?.profileKey?.trim().toLowerCase() ?? "";
  const normalizedUnitKey = selector?.ingestionUnitKey?.trim().toLowerCase() ?? "";
  const selected = versions.filter(
    (version) =>
      (!normalizedProfileKey || version.profileKey.trim().toLowerCase() === normalizedProfileKey) &&
      (!normalizedUnitKey ||
        catalogProviderProfileVersionIngestionUnitKey(version).trim().toLowerCase() === normalizedUnitKey),
  );

  if (selected.length === 0) {
    return null;
  }
  if (selected.length === 1) {
    return selected[0] ?? null;
  }

  const options = selected
    .map(
      (version) =>
        `${version.providerKey}/${version.profileKey}@${version.profileVersion} (${catalogProviderProfileVersionIngestionUnitKey(
          version,
        )})`,
    )
    .join(", ");
  throw new Error(
    `Catalog provider '${normalizeProviderKey(
      providerKey,
    )}' has multiple profile units for version '${profileVersion}'. Select a profileKey or ingestionUnitKey. Versions: ${options}.`,
  );
}

function sameCatalogProviderProfileVersionIdentity(
  candidate: CatalogProviderIntegrationProfileVersionRecord,
  target: CatalogProviderIntegrationProfileVersionRecord,
): boolean {
  return (
    normalizeProviderKey(candidate.providerKey) === normalizeProviderKey(target.providerKey) &&
    candidate.profileKey === target.profileKey &&
    candidate.profileVersion === target.profileVersion &&
    catalogProviderProfileVersionIngestionUnitKey(candidate) === catalogProviderProfileVersionIngestionUnitKey(target)
  );
}

function inferCatalogProviderIngestionUnitKey(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogIntegrationUnitKey {
  return defineCatalogProviderIngestionUnitIdentityContract({
    providerKey: version.providerKey,
    productDomain: inferProductDomain(version),
    productForm: inferProductForm(version),
    ingestionPurpose: "source-observation-import",
  }).unitKey;
}

// The product domain a profile version belongs to. The declared ingestion-unit
// identity is authoritative; profiles that predate the identity contract fall
// back to signal inference so every active version resolves to one domain.
export function catalogProviderProfileVersionProductDomain(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogProviderIngestionUnitProductDomain {
  return (
    version.ingestionUnitIdentity?.productDomain ??
    version.executableMappingContract?.ingestionUnitIdentity?.productDomain ??
    inferProductDomain(version)
  );
}

function inferProductDomain(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogProviderIngestionUnitProductDomain {
  const signals = [
    version.profileKey,
    version.profile.catalogFieldMapping.blueprintKey,
    version.profile.catalogFieldMapping.categoryKey,
    version.executableMappingContract?.normalizedObservation.outputKind ?? "",
    version.executableMappingContract?.normalizedObservation.fields.tcg?.selector.kind === "constant"
      ? String(version.executableMappingContract.normalizedObservation.fields.tcg.selector.value)
      : "",
    version.executableMappingContract?.normalizedObservation.fields.productLineName?.selector.kind === "constant"
      ? String(version.executableMappingContract.normalizedObservation.fields.productLineName.selector.value)
      : "",
  ]
    .join(" ")
    .toLowerCase();

  if (
    signals.includes("yugioh") ||
    signals.includes("yu-gi-oh") ||
    signals.includes("yu gi oh") ||
    signals.includes("ygoprodeck") ||
    signals.includes("ygojson")
  ) {
    return "yugioh";
  }
  if (signals.includes("one-piece") || signals.includes("one piece") || signals.includes("onepiece")) {
    return "one-piece";
  }
  if (signals.includes("lorcana")) {
    return "lorcana";
  }
  return signals.includes("magic") || signals.includes("scryfall") || signals.includes("mtg") ? "mtg" : "pokemon";
}

function inferProductForm(
  version: CatalogProviderIntegrationProfileVersionRecord,
): "single-card" | "sealed-product" | "set" | "pack" {
  const signals = [
    version.profileKey,
    version.profile.catalogFieldMapping.blueprintKey,
    version.profile.supportedScopes.join(" "),
    version.executableMappingContract?.displayName ?? "",
    version.executableMappingContract?.normalizedObservation.outputKind ?? "",
  ]
    .join(" ")
    .toLowerCase();

  if (signals.includes("pack-reference") || signals.includes(":pack:")) {
    return "pack";
  }
  if (signals.includes("sealed-product")) {
    return "sealed-product";
  }
  if (
    signals.includes("set") &&
    (version.executableMappingContract?.normalizedObservation.outputKind === "magic-set-reference" ||
      version.executableMappingContract?.normalizedObservation.outputKind === "yugioh-set-reference" ||
      version.executableMappingContract?.normalizedObservation.outputKind === "one-piece-set-reference" ||
      version.executableMappingContract?.normalizedObservation.outputKind === "lorcana-set-reference")
  ) {
    return "set";
  }
  return "single-card";
}
