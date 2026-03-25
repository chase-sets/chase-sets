import { discoveryCategorySchemaSql } from "./categories/schema";
import { discoveryItemDetailSchemaSql } from "./item-detail/schema";
import { discoverySearchSchemaSql } from "./search/schema";

export const discoveryProjectionSchemaSql = [
  discoverySearchSchemaSql,
  discoveryItemDetailSchemaSql,
  discoveryCategorySchemaSql,
].join("\n\n");
