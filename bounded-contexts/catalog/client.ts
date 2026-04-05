export {
  ApiError as CatalogApiError,
  api as catalogApi,
  createCatalogApiClient,
} from "./shell-support/api/client";
export type { CatalogApiClientOptions } from "./shell-support/api/client";
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
} from "./shell-support/contracts";
