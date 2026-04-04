import { discoveryCategorySchemaSql } from "./categories/schema";
import { discoveryItemDetailSchemaSql } from "./items/detail/schema";
import { discoveryMarketSchemaSql } from "./items/market/schema";
import { discoverySearchSchemaSql } from "./items/search/schema";

export const discoverySchemaSql = [
  discoveryMarketSchemaSql,
  discoverySearchSchemaSql,
  discoveryItemDetailSchemaSql,
  discoveryCategorySchemaSql,
].join("\n\n");
