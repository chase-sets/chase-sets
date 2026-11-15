import type { CatalogProviderIntegrationProfileVersionRecord } from "./profile-types";
import { canSelectStandaloneProductCoordinate } from "./product-coordinate-import";
import { catalogProviderProfileVersionIngestionUnitKey } from "./registry";
import type { SourceObservationIntegrationJobScope } from "../source-observation-runtime-contracts";

export const productCoordinateImportRefusal =
  "Product import requires the selected active product-scope unit and an unmixed product coordinate.";

/**
 * Refuses an import of a product coordinate the active profile cannot import on its own: the
 * scope must name the profile's unit, a language the profile offers (when it offers any), and
 * no expansion, set name, series or product line beside the product.
 */
export function assertProductCoordinateImportAllowed(
  scope: SourceObservationIntegrationJobScope,
  profileVersion: CatalogProviderIntegrationProfileVersionRecord,
): void {
  if (!scope.productId) {
    return;
  }
  const languageOptions = profileVersion.profile.languageOptions;
  if (
    !canSelectStandaloneProductCoordinate(profileVersion) ||
    !scope.ingestionUnitKey ||
    catalogProviderProfileVersionIngestionUnitKey(profileVersion) !== scope.ingestionUnitKey ||
    (languageOptions.length > 0 && (!scope.language || !languageOptions.includes(scope.language))) ||
    scope.setId ||
    scope.setName ||
    scope.seriesId ||
    scope.productLineId
  ) {
    throw new Error(productCoordinateImportRefusal);
  }
}
