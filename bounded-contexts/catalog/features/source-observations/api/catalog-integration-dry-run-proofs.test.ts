import { describe, expect, it } from "vitest";

import { createCatalogIntegrationDryRunProofRegistry } from "./catalog-integration-dry-run-proofs";
import {
  MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY,
  MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
} from "./provider-adapters/mtgjson";
import { REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY } from "./provider-adapters/reference-cards";
import {
  SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY,
  SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
} from "./provider-adapters/scryfall";
import { TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY } from "./provider-adapters/tcgdex";
import {
  TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "./provider-adapters/tcgplayer";

describe("Catalog integration dry-run proof registry", () => {
  it("registers proof runners by Catalog integration unit key", async () => {
    const registry = createCatalogIntegrationDryRunProofRegistry();

    expect([...registry.keys()]).toEqual([
      REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY,
      TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY,
      SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY,
      TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    ]);
    await expect(
      registry.get(TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY)?.(),
    ).resolves.toMatchObject({
      unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      observations: [
        expect.objectContaining({
          providerKey: "tcgdex",
          externalKey: "swsh3-136",
        }),
      ],
    });
    await expect(
      registry.get(TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY)?.(),
    ).resolves.toMatchObject({
      unitKey: TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      observations: [
        expect.objectContaining({
          providerKey: "tcgplayer",
          externalKey: "product:96601",
        }),
      ],
    });
  });
});
