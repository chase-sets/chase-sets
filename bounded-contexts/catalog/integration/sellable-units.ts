import type { CatalogServices } from "../authoring/services";
import { resolveSellableUnitDescriptor } from "../sellable-units";

export {
  type CatalogSelectionEntry,
  type CatalogVersionApplicabilityClause,
  type CatalogVersionChoice,
  type CatalogVersionDescriptor,
  type CatalogVersionDimension,
  type CatalogVersionKey,
  type CatalogVersionSchema,
  type SellableUnitDescriptor,
  SellableUnitError,
  createCatalogVersionKey,
  normalizeCatalogSelection,
  resolveCatalogVersionDescriptor,
  resolveSellableUnitDescriptor,
} from "../sellable-units";

export function createCatalogSellableUnitDescriptorPort(
  _services: CatalogServices,
) {
  return resolveSellableUnitDescriptor;
}
