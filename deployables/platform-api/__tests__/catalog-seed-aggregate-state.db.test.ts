import { countEventsWithPrefix } from "@chase-sets/bounded-context-runtime";
import { module as catalogModule } from "@chase-sets/catalog";
import { catalogIntegrationSeedRequirements, inspectCatalogIntegrationSeedState } from "@chase-sets/catalog/server";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import type { ApiHostSeedOptions } from "@chase-sets/platform-runtime/api";
import { describe, expect, it } from "vitest";
import { createPlatformApiBootstrapTestHarness } from "./bootstrap-db-test-support";
import {
  assignCatalogSeedState,
  profileShapes,
  pools,
  prepareCatalog,
  catalogServices,
  ordinaryBoot,
  interruptCatalogSeed,
  requiredEventCounts,
  scenarioCatalogItemIds,
  scenarioCatalogItemEventCount,
  scenarioCatalogItemProjectionCount,
  expectAllRequiredAggregatesActive,
  createSingleCardIdentityDraft,
  countEventType,
  productMeasuresResolvedEventCount,
  expectCatalogOnlyHarnessConnections,
} from "./catalog-seed-test-support";

createPlatformApiBootstrapTestHarness("platform_api_catalog_seed_aggregate_state", assignCatalogSeedState, {
  activeContextNames: ["catalog"],
});

describe("Catalog integration aggregate-state seed", () => {
  it("reconciles all required aggregates for a clean scenario-seed-only module seed", async () => {
    await expectCatalogOnlyHarnessConnections();
    const runtime = await prepareCatalog();
    if (!catalogModule.seed) {
      throw new Error("Catalog module seed is unavailable.");
    }

    const options: ApiHostSeedOptions = {
      enabledDataProfiles: ["scenario-seed"],
      environmentName: "test",
    };
    await catalogModule.seed(pools.catalog, catalogServices(runtime), options);
    await expectAllRequiredAggregatesActive();
    expect((await inspectCatalogIntegrationSeedState(pools.catalog)).length).toBe(130);
    const afterBootOne = await requiredEventCounts();

    await catalogModule.seed(pools.catalog, catalogServices(runtime), options);
    expect(await requiredEventCounts()).toEqual(afterBootOne);
  });

  it("does not re-author unchanged Product Measures facts on scenario-seed repeat", async () => {
    const runtime = await prepareCatalog();
    const profile = profileShapes[0];

    await ordinaryBoot(runtime, profile);
    const afterCleanAuthoringBoot = {
      catalogEvents: await countEventsWithPrefix(pools.catalog, catalogModule.streamPrefix),
      productMeasuresResolved: await productMeasuresResolvedEventCount(),
    };
    expect(afterCleanAuthoringBoot.productMeasuresResolved).toBe(scenarioCatalogItemIds.length);

    await ordinaryBoot(runtime, profile);
    const afterCompletedStateBoot = {
      catalogEvents: await countEventsWithPrefix(pools.catalog, catalogModule.streamPrefix),
      productMeasuresResolved: await productMeasuresResolvedEventCount(),
    };
    expect(afterCompletedStateBoot).toEqual(afterCleanAuthoringBoot);

    await ordinaryBoot(runtime, profile);
    const afterNextOrdinaryBoot = {
      catalogEvents: await countEventsWithPrefix(pools.catalog, catalogModule.streamPrefix),
      productMeasuresResolved: await productMeasuresResolvedEventCount(),
    };
    expect(afterNextOrdinaryBoot).toEqual(afterCompletedStateBoot);
  });

  it("NC-1 resumes an undrained Dimension seed without duplicate creation", async () => {
    const profile = profileShapes[0];
    const runtime = await prepareCatalog();
    await interruptCatalogSeed(catalogServices(runtime), "dimensions", profile);
    const before = await requiredEventCounts();
    await ordinaryBoot(runtime, profile);
    await expectAllRequiredAggregatesActive();
    const after = await requiredEventCounts();
    for (const requirement of catalogIntegrationSeedRequirements.filter(
      ({ aggregateName }) => aggregateName === "Dimension",
    )) {
      expect(after[requirement.streamId]).toBe(before[requirement.streamId]);
    }
  });

  it("NC-2 resumes a Component committed at created version one across two ordinary boots", async () => {
    const profile = profileShapes[0];
    const runtime = await prepareCatalog();
    const streamId = `catalog.component-${catalogSeedIds.components.singleCardIdentity}`;
    await createSingleCardIdentityDraft(catalogServices(runtime));
    expect(await countEventType(streamId, "catalog.component.created")).toBe(1);
    await ordinaryBoot(runtime, profile);
    await expectAllRequiredAggregatesActive();
    expect(await countEventType(streamId, "catalog.component.created")).toBe(1);
    const afterBootOne = await requiredEventCounts();
    await ordinaryBoot(runtime, profile);
    expect(await requiredEventCounts()).toEqual(afterBootOne);
  });

  it("NC-3 restores lagging projections without re-authoring active aggregates", async () => {
    const profile = profileShapes[1];
    const runtime = await prepareCatalog();
    await ordinaryBoot(runtime, profile);
    const before = await requiredEventCounts();
    await pools.catalog.query(
      `TRUNCATE TABLE
         catalog_dimension_options,
         catalog_dimensions,
         catalog_fields,
         catalog_components,
         catalog_blueprints,
         catalog_categories,
         catalog_reference_records,
         catalog_reference_types
       CASCADE`,
    );
    await ordinaryBoot(runtime, profile);
    await expectAllRequiredAggregatesActive();
    expect(await requiredEventCounts()).toEqual(before);
    await ordinaryBoot(runtime, profile);
    expect(await requiredEventCounts()).toEqual(before);
  });

  it("rebuilds lost Catalog Item projections from retained streams without appending item events", async () => {
    const profile = profileShapes[0];
    const runtime = await prepareCatalog();
    await ordinaryBoot(runtime, profile);
    expect(await scenarioCatalogItemProjectionCount()).toBe(14);
    const before = await scenarioCatalogItemEventCount();
    expect(before).toBe(205);

    await pools.catalog.query("TRUNCATE TABLE catalog_items CASCADE");
    expect(await scenarioCatalogItemProjectionCount()).toBe(0);

    await ordinaryBoot(runtime, profile);
    expect(await scenarioCatalogItemProjectionCount()).toBe(14);
    expect(await scenarioCatalogItemEventCount()).toBe(before);

    await ordinaryBoot(runtime, profile);
    expect(await scenarioCatalogItemProjectionCount()).toBe(14);
    expect(await scenarioCatalogItemEventCount()).toBe(before);
  });

  it("NC-4 ignores populated containers when required aggregates have zero events", async () => {
    const profile = profileShapes[0];
    const runtime = await prepareCatalog();
    await ordinaryBoot(runtime, profile);
    const streamIds = catalogIntegrationSeedRequirements.map(({ streamId }) => streamId);
    await pools.catalog.query("DELETE FROM event_store_aggregate_snapshots WHERE stream_id = ANY($1::text[])", [
      streamIds,
    ]);
    await pools.catalog.query("DELETE FROM event_store_events WHERE stream_id = ANY($1::text[])", [streamIds]);
    await pools.catalog.query(
      "UPDATE event_store_streams SET current_version = 0, updated_at = now() WHERE stream_id = ANY($1::text[])",
      [streamIds],
    );
    expect(Object.values(await requiredEventCounts()).every((count) => count === 0)).toBe(true);
    await ordinaryBoot(runtime, profile);
    await expectAllRequiredAggregatesActive();
    const afterBootOne = await requiredEventCounts();
    await ordinaryBoot(runtime, profile);
    expect(await requiredEventCounts()).toEqual(afterBootOne);
  });

  it("NC-5a repairs a draft partial aggregate rather than skipping it", async () => {
    const profile = profileShapes[0];
    const runtime = await prepareCatalog();
    const streamId = `catalog.component-${catalogSeedIds.components.singleCardIdentity}`;
    await createSingleCardIdentityDraft(catalogServices(runtime));
    await ordinaryBoot(runtime, profile);
    await expectAllRequiredAggregatesActive();
    expect(await countEventType(streamId, "catalog.component.created")).toBe(1);
    const afterBootOne = await requiredEventCounts();
    await ordinaryBoot(runtime, profile);
    expect(await requiredEventCounts()).toEqual(afterBootOne);
  });

  it("NC-5b rejects conflicting retained identity metadata on both boots", async () => {
    const profile = profileShapes[0];
    const runtime = await prepareCatalog();
    await createSingleCardIdentityDraft(catalogServices(runtime), "conflicting-single-card-identity");
    const message =
      `Catalog integration bootstrap Component 'single-card-identity' expected id ` +
      `'${catalogSeedIds.components.singleCardIdentity}' and key 'single-card-identity', but found id ` +
      `'${catalogSeedIds.components.singleCardIdentity}' and key 'conflicting-single-card-identity'.`;
    await expect(ordinaryBoot(runtime, profile)).rejects.toThrow(message);
    await expect(ordinaryBoot(runtime, profile)).rejects.toThrow(message);
  });

  it("NC-5c rejects a terminal retained aggregate on both boots", async () => {
    const profile = profileShapes[0];
    const runtime = await prepareCatalog();
    await ordinaryBoot(runtime, profile);
    const services = catalogServices(runtime);
    await services.components.commandHandler({
      streamId: `catalog.component-${catalogSeedIds.components.singleCardIdentity}`,
      command: { type: "DeprecateComponent" },
      context: {
        tenantId: "tnt_catalog_seed_test",
        audit: {
          performedByUserId: "usr_catalog_seed_test",
          forAccountId: "acc_catalog_seed_test",
        },
      } as never,
    });
    const message =
      "Catalog integration bootstrap Component 'single-card-identity' expected status 'active', " +
      "but found terminal status 'deprecated'.";
    await expect(ordinaryBoot(runtime, profile)).rejects.toThrow(message);
    await expect(ordinaryBoot(runtime, profile)).rejects.toThrow(message);
  });
});
