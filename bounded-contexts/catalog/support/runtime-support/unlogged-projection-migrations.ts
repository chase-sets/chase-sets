import type { BcSchemaMigration } from "@chase-sets/bounded-context-module";

export const catalogUnloggedProjectionExclusions = [
  {
    tableName: "catalog_items",
    reason: "Canonical Catalog authoring state without a declared projection reset contract",
  },
  {
    tableName: "catalog_item_display_identity_recompute_work",
    reason: "Operational recompute work queue without a declared projection reset contract",
  },
  {
    tableName: "catalog_admin_catalog_item_detail_pages",
    reason: "FK-coupled to logged table catalog_items",
  },
  {
    tableName: "catalog_admin_catalog_item_list_pages",
    reason: "FK-coupled to logged table catalog_items",
  },
  {
    tableName: "catalog_external_catalog_item_references",
    reason: "FK-coupled to logged table catalog_items",
  },
  {
    tableName: "catalog_external_product_references",
    reason: "FK-coupled to logged table catalog_items",
  },
  {
    tableName: "catalog_item_display_identities",
    reason: "FK-coupled to logged table catalog_items",
  },
  {
    tableName: "catalog_resolved_product_contents",
    reason: "FK-coupled to logged table catalog_items",
  },
  {
    tableName: "catalog_resolved_product_measures",
    reason: "FK-coupled to logged table catalog_items",
  },
  {
    tableName: "catalog_product_content_types",
    reason: "FK-coupled to logged table catalog_resolved_product_contents",
  },
  {
    tableName: "catalog_product_content_inclusion_policies",
    reason: "FK-coupled to logged table catalog_resolved_product_contents",
  },
] as const;

export const catalogUnloggedProjectionSchemaMigrations: readonly BcSchemaMigration[] = [
  {
    migrationId: "20260710_catalog_unlogged_projections",
    description: "Store replayable Catalog projections as unlogged tables.",
    statements: [
      "SET lock_timeout = '5s';",
      "ALTER TABLE catalog_admin_blueprint_detail_pages DROP CONSTRAINT IF EXISTS catalog_admin_blueprint_detail_pages_blueprint_id_fkey;",
      "ALTER TABLE catalog_admin_category_detail_pages DROP CONSTRAINT IF EXISTS catalog_admin_category_detail_pages_category_id_fkey;",
      "ALTER TABLE catalog_admin_category_list_pages DROP CONSTRAINT IF EXISTS catalog_admin_category_list_pages_category_id_fkey;",
      "ALTER TABLE catalog_admin_component_detail_pages DROP CONSTRAINT IF EXISTS catalog_admin_component_detail_pages_component_id_fkey;",
      "ALTER TABLE catalog_dimension_options DROP CONSTRAINT IF EXISTS catalog_dimension_options_dimension_id_fkey;",
      "ALTER TABLE catalog_merge_candidate_observations DROP CONSTRAINT IF EXISTS catalog_merge_candidate_observations_candidate_fk;",
      "ALTER TABLE catalog_admin_blueprint_detail_pages SET UNLOGGED;",
      "ALTER TABLE catalog_admin_category_detail_pages SET UNLOGGED;",
      "ALTER TABLE catalog_admin_category_list_pages SET UNLOGGED;",
      "ALTER TABLE catalog_admin_component_detail_pages SET UNLOGGED;",
      "ALTER TABLE catalog_blueprints SET UNLOGGED;",
      "ALTER TABLE catalog_categories SET UNLOGGED;",
      "ALTER TABLE catalog_components SET UNLOGGED;",
      "ALTER TABLE catalog_dimension_options SET UNLOGGED;",
      "ALTER TABLE catalog_dimensions SET UNLOGGED;",
      "ALTER TABLE catalog_display_templates SET UNLOGGED;",
      "ALTER TABLE catalog_fields SET UNLOGGED;",
      "ALTER TABLE catalog_item_aliases SET UNLOGGED;",
      "ALTER TABLE catalog_item_resolved_aliases SET UNLOGGED;",
      "ALTER TABLE catalog_merge_candidate_observations SET UNLOGGED;",
      "ALTER TABLE catalog_merge_candidates SET UNLOGGED;",
      "ALTER TABLE catalog_product_measure_profiles SET UNLOGGED;",
      "ALTER TABLE catalog_provider_scope_mappings SET UNLOGGED;",
      "ALTER TABLE catalog_reference_record_aliases SET UNLOGGED;",
      "ALTER TABLE catalog_reference_record_resolved_aliases SET UNLOGGED;",
      "ALTER TABLE catalog_reference_records SET UNLOGGED;",
      "ALTER TABLE catalog_reference_types SET UNLOGGED;",
      "ALTER TABLE catalog_scope_records SET UNLOGGED;",
      "ALTER TABLE catalog_source_observation_alias_candidates SET UNLOGGED;",
      "ALTER TABLE catalog_source_observation_integration_scope_summaries SET UNLOGGED;",
      "ALTER TABLE catalog_source_observations SET UNLOGGED;",
      "ALTER TABLE catalog_admin_blueprint_detail_pages ADD CONSTRAINT catalog_admin_blueprint_detail_pages_blueprint_id_fkey FOREIGN KEY (blueprint_id) REFERENCES catalog_blueprints (blueprint_id) ON DELETE CASCADE NOT VALID;",
      "ALTER TABLE catalog_admin_blueprint_detail_pages VALIDATE CONSTRAINT catalog_admin_blueprint_detail_pages_blueprint_id_fkey;",
      "ALTER TABLE catalog_admin_category_detail_pages ADD CONSTRAINT catalog_admin_category_detail_pages_category_id_fkey FOREIGN KEY (category_id) REFERENCES catalog_categories (category_id) ON DELETE CASCADE NOT VALID;",
      "ALTER TABLE catalog_admin_category_detail_pages VALIDATE CONSTRAINT catalog_admin_category_detail_pages_category_id_fkey;",
      "ALTER TABLE catalog_admin_category_list_pages ADD CONSTRAINT catalog_admin_category_list_pages_category_id_fkey FOREIGN KEY (category_id) REFERENCES catalog_categories (category_id) ON DELETE CASCADE NOT VALID;",
      "ALTER TABLE catalog_admin_category_list_pages VALIDATE CONSTRAINT catalog_admin_category_list_pages_category_id_fkey;",
      "ALTER TABLE catalog_admin_component_detail_pages ADD CONSTRAINT catalog_admin_component_detail_pages_component_id_fkey FOREIGN KEY (component_id) REFERENCES catalog_components (component_id) ON DELETE CASCADE NOT VALID;",
      "ALTER TABLE catalog_admin_component_detail_pages VALIDATE CONSTRAINT catalog_admin_component_detail_pages_component_id_fkey;",
      "ALTER TABLE catalog_dimension_options ADD CONSTRAINT catalog_dimension_options_dimension_id_fkey FOREIGN KEY (dimension_id) REFERENCES catalog_dimensions (dimension_id) ON DELETE CASCADE NOT VALID;",
      "ALTER TABLE catalog_dimension_options VALIDATE CONSTRAINT catalog_dimension_options_dimension_id_fkey;",
      "ALTER TABLE catalog_merge_candidate_observations ADD CONSTRAINT catalog_merge_candidate_observations_candidate_fk FOREIGN KEY (candidate_id) REFERENCES catalog_merge_candidates (candidate_id) ON DELETE CASCADE NOT VALID;",
      "ALTER TABLE catalog_merge_candidate_observations VALIDATE CONSTRAINT catalog_merge_candidate_observations_candidate_fk;",
    ],
  },
];
