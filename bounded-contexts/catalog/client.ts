export {
  ApiError as CatalogApiError,
  api as catalogApi,
  createCatalogApiClient,
} from "./support/shell-support/api/client";
export type { CatalogApiClientOptions } from "./support/shell-support/api/client";
export type {
  Blueprint,
  BlueprintDetail,
  CatalogItemDetail,
  CatalogItemListItem,
  CategoryDetail,
  CategoryListItem,
  Component,
  ComponentDetail,
  Dimension,
  DimensionDetail,
  Field,
} from "./support/client-support/contracts";
