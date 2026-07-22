/**
 * Canonical list of `/fake-cdn/assets/` image fallback paths the scenario seed
 * references (bounded-contexts/catalog/features/catalog-items/api/seed.ts).
 * The seed imports this list instead of inline literals, and
 * deployables/marketplace tests every path against its public/ directory, so
 * the two cannot drift apart.
 */
export const scenarioSeedFallbackAssets = {
  pokemonEnglishCardBack: "/fake-cdn/assets/pokemon_tcg_back.png",
  pokemonJapaneseCardBack: "/fake-cdn/assets/pokemon-card-back.png",
  onePieceCardBack: "/fake-cdn/assets/one-piece-card-back.png",
  lorcanaCardBack: "/fake-cdn/assets/lorcana-card-back.png",
} as const;

export type ScenarioSeedFallbackAssetKey = keyof typeof scenarioSeedFallbackAssets;

export const scenarioSeedFallbackAssetPaths: readonly string[] = Object.values(scenarioSeedFallbackAssets);
