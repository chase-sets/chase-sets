import { describe, expect, it } from "vitest";

import { createCatalogIntegrationDryRunProofRegistry } from "./catalog-integration-dry-run-proofs";
import {
  MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY,
  MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
} from "../provider-adapters/mtgjson";
import {
  LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
  LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
} from "../provider-adapters/lorcanajson";
import {
  LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
  LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
} from "../provider-adapters/lorcast";
import {
  YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
  YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
} from "../provider-adapters/ygoprodeck";
import {
  YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
  YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
} from "../provider-adapters/ygojson";
import { REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY } from "../provider-adapters/reference-cards";
import {
  SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY,
  SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
} from "../provider-adapters/scryfall";
import { TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY } from "../provider-adapters/tcgdex";
import {
  TCGPLAYER_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "../provider-adapters/tcgplayer";
import {
  SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "../provider-adapters/scrydex-one-piece";

describe("Catalog integration dry-run proof registry", () => {
  it("registers proof runners by Catalog integration unit key", async () => {
    const registry = createCatalogIntegrationDryRunProofRegistry();

    expect([...registry.keys()]).toEqual([
      REFERENCE_CARDS_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_PROOF_UNIT_KEY,
      TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      MTGJSON_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      MTGJSON_MTG_SET_REFERENCE_DATA_UNIT_KEY,
      LORCANAJSON_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      LORCANAJSON_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
      LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      LORCAST_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
      SCRYFALL_MTG_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      SCRYFALL_MTG_IMAGE_EVIDENCE_UNIT_KEY,
      YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      YGOPRODECK_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
      YGOJSON_YUGIOH_SET_REFERENCE_DATA_UNIT_KEY,
      YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
      TCGPLAYER_MTG_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      TCGPLAYER_MTG_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      TCGPLAYER_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      TCGPLAYER_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
      SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
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
    await expect(
      registry.get(TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY)?.(),
    ).resolves.toMatchObject({
      unitKey: TCGPLAYER_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      observations: [
        expect.objectContaining({
          providerKey: "tcgplayer",
          externalKey: "product:493958",
        }),
      ],
    });
    await expect(
      registry.get(TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY)?.(),
    ).resolves.toMatchObject({
      unitKey: TCGPLAYER_POKEMON_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      observations: [
        expect.objectContaining({
          providerKey: "tcgplayer",
          externalKey: "product:497105",
          normalizedFacts: expect.objectContaining({
            name: "Scarlet & Violet Elite Trainer Box",
            productForm: "sealed",
            productLineName: "Pokemon",
            setName: "Scarlet & Violet",
          }),
        }),
      ],
    });
    await expect(registry.get(LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY)?.()).resolves.toMatchObject({
      unitKey: LORCAST_LORCANA_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      observations: [
        expect.objectContaining({
          providerKey: "lorcast",
          externalKey: "card:crd_elsa_snow_queen_1_041",
        }),
      ],
    });
    await expect(registry.get(YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY)?.()).resolves.toMatchObject({
      unitKey: YGOPRODECK_YUGIOH_SINGLE_CARD_REFERENCE_DATA_UNIT_KEY,
      observations: [
        expect.objectContaining({
          providerKey: "ygoprodeck",
          externalKey: "card:46986414:SDY-006",
        }),
      ],
    });
    await expect(registry.get(YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY)?.()).resolves.toMatchObject({
      unitKey: YGOJSON_YUGIOH_SEALED_PRODUCT_REFERENCE_DATA_UNIT_KEY,
      observations: [
        expect.objectContaining({
          providerKey: "ygojson",
          externalKey: "sealed-product:22222222-2222-4222-8222-222222222222",
        }),
      ],
    });
    await expect(
      registry.get(TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY)?.(),
    ).resolves.toMatchObject({
      unitKey: TCGPLAYER_YUGIOH_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      observations: [
        expect.objectContaining({
          providerKey: "tcgplayer",
          externalKey: "product:17851",
        }),
      ],
    });
    await expect(
      registry.get(TCGPLAYER_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY)?.(),
    ).resolves.toMatchObject({
      unitKey: TCGPLAYER_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      observations: [
        expect.objectContaining({
          providerKey: "tcgplayer",
          externalKey: "product:1005010",
        }),
      ],
    });
    await expect(
      registry.get(TCGPLAYER_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY)?.(),
    ).resolves.toMatchObject({
      unitKey: TCGPLAYER_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      observations: [
        expect.objectContaining({
          providerKey: "tcgplayer",
          externalKey: "product:1005020",
        }),
      ],
    });
    await expect(
      registry.get(TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY)?.(),
    ).resolves.toMatchObject({
      unitKey: TCGPLAYER_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      observations: [
        expect.objectContaining({
          providerKey: "tcgplayer",
          externalKey: "product:987650",
        }),
      ],
    });
    await expect(
      registry.get(TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY)?.(),
    ).resolves.toMatchObject({
      unitKey: TCGPLAYER_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      observations: [
        expect.objectContaining({
          providerKey: "tcgplayer",
          externalKey: "product:987660",
        }),
      ],
    });
    await expect(
      registry.get(SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY)?.(),
    ).resolves.toMatchObject({
      unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      observations: [
        expect.objectContaining({
          providerKey: "scrydex",
          externalKey: "card:op01-001",
        }),
      ],
    });
    await expect(registry.get(SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY)?.()).resolves.toMatchObject({
      unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
      observations: [
        expect.objectContaining({
          providerKey: "scrydex",
          externalKey: "set:op-01",
        }),
      ],
    });
    await expect(
      registry.get(SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY)?.(),
    ).resolves.toMatchObject({
      unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      observations: [
        expect.objectContaining({
          providerKey: "scrydex",
          externalKey: "sealed:op01-booster-box",
        }),
      ],
    });
  });
});
