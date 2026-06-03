import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { realtimeOutboxSchemaSql } from "@chase-sets/platform-runtime/realtime";
import { discoveryCategorySchemaSql } from "../../features/categories/read-model/schema";
import { discoveryItemDetailSchemaSql } from "../../features/item-detail/read-model/schema";
import { discoveryProductAlertSchemaSql } from "../../features/product-alerts/read-model/schema";
import { discoveryGoogleShoppingSchemaSql } from "../google-shopping-support/schema";
import { discoveryMarketSchemaSql } from "../market-support/schema";
import { discoverySearchSchemaSql } from "../../features/search/read-model/schema";
import { discoverySlugSchemaSql } from "./slug-schema";

export const discoverySchemaSql = [
  eventCorePostgresSchemaSql,
  notificationOutboxSchemaSql,
  discoverySlugSchemaSql,
  discoveryMarketSchemaSql,
  discoveryGoogleShoppingSchemaSql,
  discoveryProductAlertSchemaSql,
  discoverySearchSchemaSql,
  discoveryItemDetailSchemaSql,
  discoveryCategorySchemaSql,
  realtimeOutboxSchemaSql,
].join("\n\n");
