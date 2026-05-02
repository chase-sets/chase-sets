import { discoveryCategorySchemaSql } from "../../features/categories/read-model/schema";
import { discoveryItemDetailSchemaSql } from "../../features/item-detail/read-model/schema";
import { discoveryMarketSchemaSql } from "../market-support/schema";
import { discoverySearchSchemaSql } from "../../features/search/read-model/schema";
import { discoverySlugSchemaSql } from "./slug-schema";

export const discoverySchemaSql = [
  discoverySlugSchemaSql,
  discoveryMarketSchemaSql,
  discoverySearchSchemaSql,
  discoveryItemDetailSchemaSql,
  discoveryCategorySchemaSql,
].join("\n\n");
