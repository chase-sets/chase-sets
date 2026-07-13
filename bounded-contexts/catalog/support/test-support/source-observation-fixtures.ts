import type { SourceObservationPokemonCardNormalized } from "../../features/source-observations/domain/domain";

/** Shared baseline for tests that need a complete normalized Pokemon observation. */
export function normalizedObservation(
  overrides: Partial<SourceObservationPokemonCardNormalized> = {},
): SourceObservationPokemonCardNormalized {
  return {
    kind: "pokemon-card",
    tcg: "pokemon",
    languageCode: "en",
    name: "Furret",
    cardNumber: "136",
    setId: "swsh3",
    setName: "Darkness Ablaze",
    expansionId: "swsh3",
    expansionName: "Darkness Ablaze",
    expansionAbbreviation: "DAA",
    expansionCardCount: 189,
    expansionParallelSetCardCount: 155,
    seriesId: "swsh",
    seriesName: "Sword & Shield",
    rarity: "Uncommon",
    illustrator: "tetsuya koizumi",
    releaseDate: "2020-08-14",
    releaseYear: 2020,
    category: "Pokemon",
    imageBaseUrl: "https://assets.tcgdex.net/en/swsh/swsh3/136",
    imageUrls: ["https://assets.tcgdex.net/en/swsh/swsh3/136/high.webp"],
    productAssetSet: null,
    parallelSet: false,
    cardVariantKey: "standard-set",
    cardVariantLabel: "Standard Set",
    cardVariantSourceKey: "normal",
    cardVariantIsPrimaryImage: true,
    imageDisclaimer: null,
    variants: {},
    externalCatalogItemReferences: [],
    externalProductReferences: [],
    ...overrides,
  };
}
