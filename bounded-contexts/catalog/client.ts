export {
  ApiError as CatalogApiError,
  api as catalogApi,
  createCatalogApiClient,
} from "./authoring/shell-support/api/client";
export type { CatalogApiClientOptions } from "./authoring/shell-support/api/client";
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
} from "./authoring/client/contracts";
