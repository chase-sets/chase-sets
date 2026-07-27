// Provider import-scope shape: how a provider's compact two-segment import scope
// `language:X` structures its second segment. This is a projection of the canonical
// provider registry (`catalogProviderIntegrationProfiles`), whose per-provider
// `supportedScopes` declare the scope hierarchy each provider imports at:
//
//   - a provider that leads with `product-line/category` (e.g. TCGplayer) reads the
//     second segment as a product-line id;
//   - a provider that leads with `set-name` (the reference-data providers) reads it
//     as an expansion id;
//   - a provider that leads with `language`/`series` (e.g. TCGdex) reads it as a
//     series id — the default, so it carries no entry here.
//
// The projection is a small, client-safe literal (the parsing helpers that consume
// it are client-bundled, so we do not pull the heavy provider-profile registry into
// the browser). Its `provider-import-scope-shape.test.ts` drift guard derives the
// same shape from `catalogProviderIntegrationProfiles` and fails if the two diverge,
// so the canonical registry stays the source of truth: adding or re-shaping a
// provider forces a conscious update here.

export type CatalogProviderImportScopeSecondSegmentKind = "product-line" | "expansion";

export const catalogProviderImportScopeSecondSegmentKindByProvider: Readonly<
  Record<string, CatalogProviderImportScopeSecondSegmentKind>
> = {
  tcgplayer: "product-line",
  lorcanajson: "expansion",
  lorcast: "expansion",
  mtgjson: "expansion",
  scryfall: "expansion",
  scrydex: "expansion",
  ygojson: "expansion",
  ygoprodeck: "expansion",
};

export function catalogProviderImportScopeSecondSegmentKind(
  providerKey: string | null,
): CatalogProviderImportScopeSecondSegmentKind | null {
  return catalogProviderImportScopeSecondSegmentKindByProvider[providerKey ?? ""] ?? null;
}

export function providerImportScopeSecondSegmentIsProductLine(providerKey: string | null): boolean {
  return catalogProviderImportScopeSecondSegmentKind(providerKey) === "product-line";
}

export function providerImportScopeSecondSegmentIsExpansion(providerKey: string | null): boolean {
  return catalogProviderImportScopeSecondSegmentKind(providerKey) === "expansion";
}
