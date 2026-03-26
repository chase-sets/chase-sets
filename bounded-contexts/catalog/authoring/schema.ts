import { eventCorePostgresSchemaSql } from "@chase-sets/event-core/postgres/schema";
import { catalogBlueprintSchemaSql } from "./blueprints/schema";
import { catalogCatalogItemSchemaSql } from "./catalog-items/schema";
import { catalogCategorySchemaSql } from "./categories/schema";
import { catalogComponentSchemaSql } from "./components/schema";
import { catalogDimensionSchemaSql } from "./dimensions/schema";
import { catalogFieldSchemaSql } from "./fields/schema";

export const catalogAuthoringSchemaSql = [
  eventCorePostgresSchemaSql,
  catalogDimensionSchemaSql,
  catalogFieldSchemaSql,
  catalogComponentSchemaSql,
  catalogBlueprintSchemaSql,
  catalogCategorySchemaSql,
  catalogCatalogItemSchemaSql,
].join("\n\n");