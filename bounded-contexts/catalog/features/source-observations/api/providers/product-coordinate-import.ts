import type { CatalogProviderIntegrationProfileVersionRecord } from "./profile-types";

// A standalone product coordinate imports one provider product on its own,
// without the expansion, series or product line that would otherwise scope it.
// Only a profile whose mapping produces products and whose option queries
// offer a product with no required parent can do that.

const productCoordinateMappingOutputKinds = new Set([
  "provider-product",
  "pokemon-sealed-product",
  "magic-sealed-product",
  "yugioh-sealed-product",
  "one-piece-sealed-product",
  "lorcana-sealed-product",
]);

type StandaloneProductCoordinateProfileVersion =
  | Pick<CatalogProviderIntegrationProfileVersionRecord, "active" | "profile" | "executableMappingContract">
  | Readonly<{
      active: boolean;
      supportedScopes: readonly string[];
      mappingOutputKind: string;
      hasExecutableMappingContract: boolean;
      sourceOptionKinds: readonly Readonly<{ scope: string; parentScope: string | null; parentRequired: boolean }>[];
    }>;

export function canSelectStandaloneProductCoordinate(
  profileVersion: StandaloneProductCoordinateProfileVersion | null,
): boolean {
  if (!profileVersion?.active) {
    return false;
  }

  const isReview = "sourceOptionKinds" in profileVersion;
  const supportedScopes: readonly string[] = isReview
    ? profileVersion.supportedScopes
    : profileVersion.profile.supportedScopes;
  const mappingOutputKind = isReview
    ? profileVersion.mappingOutputKind
    : profileVersion.executableMappingContract?.normalizedObservation.outputKind;
  const hasExecutableMappingContract = isReview
    ? profileVersion.hasExecutableMappingContract
    : Boolean(profileVersion.executableMappingContract);
  const productQueryIsStandalone = isReview
    ? profileVersion.sourceOptionKinds.some(
        (query) => query.scope === "product" && query.parentScope === null && !query.parentRequired,
      )
    : profileVersion.profile.optionQueries.some(
        (query) => query.scope === "product" && query.parentScope === null && !query.parentValue?.required,
      );

  return (
    supportedScopes.includes("product") &&
    hasExecutableMappingContract &&
    Boolean(mappingOutputKind && productCoordinateMappingOutputKinds.has(mappingOutputKind)) &&
    productQueryIsStandalone
  );
}
