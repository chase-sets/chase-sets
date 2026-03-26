import { discoveryCategorySchemaSql } from "./categories/schema";
import { discoveryItemDetailSchemaSql } from "./items/detail/schema";
import { discoverySearchSchemaSql } from "./items/search/schema";

export const discoveryProjectionSchemaSql = [
  discoverySearchSchemaSql,
  discoveryItemDetailSchemaSql,
  discoveryCategorySchemaSql,
].join("\n\n");

