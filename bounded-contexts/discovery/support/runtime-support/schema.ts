import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { notificationOutboxSchemaSql } from "@chase-sets/notification-outbox";
import { platformPolicySchemaSql } from "@chase-sets/platform-policy/schema";
import { realtimeOutboxSchemaSql } from "@chase-sets/platform-runtime/realtime";
import { discoveryCategorySchemaSql } from "../../features/categories/read-model/schema";
import {
  discoveryItemDetailSchemaMigrations,
  discoveryItemDetailSchemaSql,
} from "../../features/item-detail/read-model/schema";
import {
  discoveryProductAlertSchemaMigrations,
  discoveryProductAlertSchemaSql,
} from "../../features/product-alerts/read-model/schema";
import {
  discoveryGoogleShoppingSchemaMigrations,
  discoveryGoogleShoppingSchemaSql,
} from "../../features/google-shopping-operations/api/schema";
import { discoveryMarketSchemaMigrations, discoveryMarketSchemaSql } from "../market-support/schema";
import { discoverySearchSchemaMigrations, discoverySearchSchemaSql } from "../../features/search/read-model/schema";
import { discoverySavedListPickerSchemaSql } from "../../features/saved-list-addition/read-model/schema";
import { discoverySlugSchemaSql } from "./slug-schema";

export const discoverySchemaSql = [
  eventCorePostgresSchemaSql,
  notificationOutboxSchemaSql,
  discoverySlugSchemaSql,
  discoveryMarketSchemaSql,
  discoveryGoogleShoppingSchemaSql,
  discoveryProductAlertSchemaSql,
  discoverySavedListPickerSchemaSql,
  discoverySearchSchemaSql,
  discoveryItemDetailSchemaSql,
  discoveryCategorySchemaSql,
  realtimeOutboxSchemaSql,
  // Adopts the shared platform-policy machinery (see infrastructure/platform-policy)
  // for the Query Vocabulary -- see ../../features/search/domain/query-vocabulary-policy.
  platformPolicySchemaSql,
].join("\n\n");

export const discoverySchemaMigrations = [
  ...discoveryMarketSchemaMigrations,
  ...discoverySearchSchemaMigrations,
  ...discoveryItemDetailSchemaMigrations,
  ...discoveryGoogleShoppingSchemaMigrations,
  ...discoveryProductAlertSchemaMigrations,
] as const;
