import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { realtimeOutboxSchemaSql } from "@chase-sets/platform-runtime/realtime";
import { catalogBlueprintSchemaSql } from "../../features/blueprints/read-model/schema";
import { catalogCatalogItemSchemaSql } from "../../features/catalog-items/read-model/schema";
import { catalogCategorySchemaSql } from "../../features/categories/read-model/schema";
import { catalogComponentSchemaSql } from "../../features/components/read-model/schema";
import { catalogDimensionSchemaSql } from "../../features/dimensions/read-model/schema";
import { catalogFieldSchemaSql } from "../../features/fields/read-model/schema";
import { catalogReferenceDataSchemaSql } from "../../features/reference-data/read-model/schema";
import { catalogSourceObservationSchemaSql } from "../../features/source-observations/read-model/schema";

export const catalogAuthoringSchemaSql = [
  eventCorePostgresSchemaSql,
  catalogDimensionSchemaSql,
  catalogFieldSchemaSql,
  catalogComponentSchemaSql,
  catalogBlueprintSchemaSql,
  catalogCategorySchemaSql,
  catalogReferenceDataSchemaSql,
  catalogCatalogItemSchemaSql,
  catalogSourceObservationSchemaSql,
  realtimeOutboxSchemaSql,
].join("\n\n");
