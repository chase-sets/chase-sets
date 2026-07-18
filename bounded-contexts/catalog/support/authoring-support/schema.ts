import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import { durableJobSchemaMigrations, durableJobSchemaSql } from "@chase-sets/platform-runtime/durable-job-store";
import { durableJobWorkUnitSchemaSql } from "@chase-sets/platform-runtime/durable-job-work-units";
import { realtimeOutboxSchemaSql } from "@chase-sets/platform-runtime/realtime";
import { catalogAliasEquivalenceSchemaSql } from "../../features/alias-equivalence/read-model/schema";
import { catalogAttentionDismissalSchemaSql } from "../../features/attention-queue/read-model/dismissal-schema";
import { catalogBlueprintSchemaSql } from "../../features/blueprints/read-model/schema";
import {
  catalogCatalogItemSchemaMigrations,
  catalogCatalogItemSchemaSql,
} from "../../features/catalog-items/read-model/schema";
import { catalogCategorySchemaSql } from "../../features/categories/read-model/schema";
import { catalogComponentSchemaSql } from "../../features/components/read-model/schema";
import { catalogDimensionSchemaSql } from "../../features/dimensions/read-model/schema";
import { catalogDisplayTemplateSchemaSql } from "../../features/display-templates/read-model/schema";
import { catalogFieldSchemaSql } from "../../features/fields/read-model/schema";
import { catalogProductContentsSchemaSql } from "../../features/product-contents/read-model/schema";
import { catalogProductMeasureSchemaSql } from "../../features/product-measures/read-model/schema";
import {
  catalogProviderScopeDiscoverySchemaMigrations,
  catalogProviderScopeDiscoverySchemaSql,
} from "../../features/provider-scope-discovery/read-model/schema";
import { catalogProviderScopeMappingSchemaSql } from "../../features/provider-scope-mapping/read-model/schema";
import { catalogReferenceDataSchemaSql } from "../../features/reference-data/read-model/schema";
import { catalogScopeRegistrySchemaSql } from "../../features/scope-registry/read-model/schema";
import {
  catalogScopeSyncStateSchemaMigrations,
  catalogScopeSyncStateSchemaSql,
} from "../../features/scope-sync-state/read-model/schema";
import { catalogScopeSyncBatchSchemaSql } from "../../features/scope-sync-batches/read-model/schema";
import {
  catalogSourceObservationSchemaMigrations,
  catalogSourceObservationSchemaSql,
} from "../../features/source-observations/read-model/schema";

export const catalogAuthoringSchemaSql = [
  eventCorePostgresSchemaSql,
  catalogDimensionSchemaSql,
  catalogFieldSchemaSql,
  catalogDisplayTemplateSchemaSql,
  catalogComponentSchemaSql,
  catalogBlueprintSchemaSql,
  catalogCategorySchemaSql,
  catalogReferenceDataSchemaSql,
  catalogScopeRegistrySchemaSql,
  catalogProviderScopeMappingSchemaSql,
  catalogScopeSyncStateSchemaSql,
  catalogScopeSyncBatchSchemaSql,
  catalogProviderScopeDiscoverySchemaSql,
  catalogCatalogItemSchemaSql,
  catalogProductContentsSchemaSql,
  catalogProductMeasureSchemaSql,
  durableJobSchemaSql({
    jobsTable: "catalog_authoring_bulk_jobs",
    eventsTable: "catalog_authoring_bulk_job_events",
    includeBootReshapes: false,
  }),
  durableJobWorkUnitSchemaSql({
    jobsTable: "catalog_authoring_bulk_jobs",
    workUnitsTable: "catalog_authoring_bulk_work_units",
  }),
  catalogSourceObservationSchemaSql,
  catalogAliasEquivalenceSchemaSql,
  catalogAttentionDismissalSchemaSql,
  realtimeOutboxSchemaSql,
].join("\n\n");

export const catalogAuthoringSchemaMigrations = [
  ...durableJobSchemaMigrations({
    jobsTable: "catalog_authoring_bulk_jobs",
  }),
  ...catalogSourceObservationSchemaMigrations,
  ...catalogCatalogItemSchemaMigrations,
  ...catalogProviderScopeDiscoverySchemaMigrations,
  ...catalogScopeSyncStateSchemaMigrations,
] as const;
