import { scenarioSeedFallbackAssets } from "@chase-sets/catalog-seed";
import type { SetCatalogItemImageFallbackCommand } from "../../../catalog-items/domain/domain";

const cardBackByGame = {
  pokemon: { url: scenarioSeedFallbackAssets.pokemonEnglishCardBack, alt: "Pokemon TCG card back" },
  magic: { url: scenarioSeedFallbackAssets.magicCardBack, alt: "Magic: The Gathering card back" },
  yugioh: { url: scenarioSeedFallbackAssets.yugiohCardBack, alt: "Yu-Gi-Oh! card back" },
  "one-piece": { url: scenarioSeedFallbackAssets.onePieceCardBack, alt: "One Piece Card Game card back" },
  lorcana: { url: scenarioSeedFallbackAssets.lorcanaCardBack, alt: "Disney Lorcana card back" },
} as const;

const cardBackGameByBlueprint: ReadonlyMap<string, keyof typeof cardBackByGame> = new Map([
  ["pokemon-card-single", "pokemon"],
  ["pokemon-sealed-product", "pokemon"],
  ["magic-card-print", "magic"],
  ["magic-sealed-product", "magic"],
  ["yugioh-card-print", "yugioh"],
  ["yugioh-sealed-product", "yugioh"],
  ["one-piece-card-print", "one-piece"],
  ["one-piece-sealed-product", "one-piece"],
  ["lorcana-card-print", "lorcana"],
  ["lorcana-sealed-product", "lorcana"],
]);

export function promotionImageFallbackCommand(
  blueprintKey: string,
  languageCode: string,
): SetCatalogItemImageFallbackCommand | null {
  const game = cardBackGameByBlueprint.get(blueprintKey);
  if (!game) return null;

  const cardBack =
    game === "pokemon" && languageCode === "ja"
      ? { url: scenarioSeedFallbackAssets.pokemonJapaneseCardBack, alt: "Pokemon TCG Japanese card back" }
      : cardBackByGame[game];
  return {
    type: "SetCatalogItemImageFallback",
    imageFallback: {
      ...cardBack,
      usage: blueprintKey.endsWith("-sealed-product") ? "loading-only" : "permanent",
      variants: {},
    },
  };
}
