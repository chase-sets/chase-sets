/**
 * Card-back assets shared by Catalog seeding and provider promotion.
 * Marketplace tests every path against its public/ directory.
 */
export const scenarioSeedFallbackAssets = {
  pokemonEnglishCardBack: "/fake-cdn/assets/pokemon_tcg_back.png",
  pokemonJapaneseCardBack: "/fake-cdn/assets/pokemon-card-back.png",
  magicCardBack: "/fake-cdn/assets/magic-card-back.svg",
  yugiohCardBack: "/fake-cdn/assets/yugioh-card-back.svg",
  onePieceCardBack: "/fake-cdn/assets/one-piece-card-back.png",
  lorcanaCardBack: "/fake-cdn/assets/lorcana-card-back.png",
} as const;

export type ScenarioSeedFallbackAssetKey = keyof typeof scenarioSeedFallbackAssets;

export const scenarioSeedFallbackAssetPaths: readonly string[] = Object.values(scenarioSeedFallbackAssets);

export const defaultProductImageUrl = "/fake-cdn/assets/product-image-placeholder.svg";
