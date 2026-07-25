import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { module as catalogModule } from "@chase-sets/catalog";
import { catalogIntegrationSeedRequirements, inspectCatalogIntegrationSeedState } from "@chase-sets/catalog/server";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import {
  nonProductionDataProfiles,
  productionLikeDataProfiles,
  seedApiHostIfEmpty,
  type ApiHostSeedOptions,
  type EnvironmentDataProfile,
} from "@chase-sets/platform-runtime/api";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { resetMultiContextTestSchemas } from "@chase-sets/bounded-context-runtime/test-support";
import { describe, expect, it } from "vitest";
import { createPlatformApiHost } from "../src/app";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import {
  createPlatformApiBootstrapTestHarness,
  listingPhotoStorage,
  type PlatformApiTestPools,
} from "./bootstrap-db-test-support";
import type { PlatformApiContextName } from "../src/config";

type CatalogServices = ReturnType<typeof catalogModule.createServices>;
type InterruptionSite =
  | "dimensions"
  | "fields"
  | "reference-data"
  | "components"
  | "blueprints"
  | "categories"
  | "mid-component-created";

const catalogApiContextRegistry = apiContextRegistry.filter((context) => context.contextName === "catalog");
const profileShapes = [
  {
    name: "scenario-seed full-drain",
    profiles: nonProductionDataProfiles,
    environmentName: "test",
  },
  {
    name: "production-like",
    profiles: productionLikeDataProfiles,
    environmentName: "production",
  },
] as const satisfies readonly Readonly<{
  name: string;
  profiles: readonly EnvironmentDataProfile[];
  environmentName: "test" | "production";
}>[];

let databaseUrls: Readonly<Record<PlatformApiContextName, string>>;
let pools: PlatformApiTestPools;
createPlatformApiBootstrapTestHarness("platform_api_catalog_seed_aggregate_state", (state) => {
  databaseUrls = state.databaseUrls;
  pools = state.pools;
});

function createCatalogSeedHost() {
  const runtime = createPlatformApiHost({
    runtimeProfile: "public",
    pools,
    hostPorts: {
      processorGateway: createFakePaymentProcessorGateway(),
      listingPhotoStorage,
    },
  });
  return {
    ...runtime,
    mountedContexts: runtime.mountedContexts.filter((context) => context.contextName === "catalog"),
    mountedModules: runtime.mountedModules.filter((entry) => entry.module.contextName === "catalog"),
    projectionGroups: runtime.projectionGroups.filter((group) => group.targetContextName === "catalog"),
    subscriptionRunners: runtime.subscriptionRunners.filter(
      (runner) => runner.targetContextName === "catalog" && runner.sourceContextName === "catalog",
    ),
  };
}

async function prepareCatalog() {
  await resetMultiContextTestSchemas(pools);
  await bootstrapContextDatabase(catalogModule, pools.catalog);
  return createCatalogSeedHost();
}

function catalogServices(runtime: ReturnType<typeof createCatalogSeedHost>): CatalogServices {
  return runtime.services.catalog as CatalogServices;
}

function bootstrapOptions(profile: (typeof profileShapes)[number]): ApiHostSeedOptions {
  return {
    enabledDataProfiles: profile.profiles,
    environmentName: profile.environmentName,
  };
}

async function ordinaryBoot(
  runtime: ReturnType<typeof createCatalogSeedHost>,
  profile: (typeof profileShapes)[number],
): Promise<void> {
  await seedApiHostIfEmpty(catalogApiContextRegistry, "platform-api", runtime, bootstrapOptions(profile));
}

async function directCatalogSeed(services: CatalogServices, profile: (typeof profileShapes)[number]): Promise<void> {
  if (!catalogModule.seed) {
    throw new Error("Catalog module seed is unavailable.");
  }
  await catalogModule.seed(pools.catalog, services, bootstrapOptions(profile));
}

async function interruptCatalogSeed(
  services: CatalogServices,
  site: InterruptionSite,
  profile: (typeof profileShapes)[number],
): Promise<void> {
  const interruptedServices: CatalogServices = {
    ...services,
    fields: {
      ...services.fields,
      commandHandler: async (...args: Parameters<CatalogServices["fields"]["commandHandler"]>) => {
        if (site === "dimensions") {
          throw new Error("test interruption after dimensions");
        }
        return services.fields.commandHandler(...args);
      },
    },
    referenceData: {
      ...services.referenceData,
      referenceTypeCommandHandler: async (
        ...args: Parameters<CatalogServices["referenceData"]["referenceTypeCommandHandler"]>
      ) => {
        if (site === "fields") {
          throw new Error("test interruption after fields");
        }
        return services.referenceData.referenceTypeCommandHandler(...args);
      },
    },
    components: {
      ...services.components,
      commandHandler: async (...args: Parameters<CatalogServices["components"]["commandHandler"]>) => {
        const input = args[0];
        if (site === "reference-data") {
          throw new Error("test interruption after reference-data");
        }
        const result = await services.components.commandHandler(...args);
        if (
          site === "mid-component-created" &&
          input.streamId === `catalog.component-${catalogSeedIds.components.singleCardIdentity}` &&
          input.command.type === "CreateComponent"
        ) {
          throw new Error("test interruption after catalog.component.created");
        }
        return result;
      },
    },
    blueprints: {
      ...services.blueprints,
      commandHandler: async (...args: Parameters<CatalogServices["blueprints"]["commandHandler"]>) => {
        if (site === "components") {
          throw new Error("test interruption after components");
        }
        return services.blueprints.commandHandler(...args);
      },
    },
    categories: {
      ...services.categories,
      commandHandler: async (...args: Parameters<CatalogServices["categories"]["commandHandler"]>) => {
        const input = args[0];
        if (site === "blueprints") {
          throw new Error("test interruption after blueprints");
        }
        const result = await services.categories.commandHandler(...args);
        if (
          site === "categories" &&
          input.streamId === `catalog.category-${catalogSeedIds.categories.lorcanaQuestsAndProductBundles}` &&
          input.command.type === "PublishCategory"
        ) {
          throw new Error("test interruption after categories");
        }
        return result;
      },
    },
  };

  await expect(directCatalogSeed(interruptedServices, profile)).rejects.toThrow(
    site === "mid-component-created"
      ? "test interruption after catalog.component.created"
      : `test interruption after ${site}`,
  );
}

async function requiredEventCounts(): Promise<Readonly<Record<string, number>>> {
  const streamIds = catalogIntegrationSeedRequirements.map(({ streamId }) => streamId);
  const result = await pools.catalog.query<Readonly<{ stream_id: string; count: string }>>(
    `SELECT stream_id, COUNT(*) AS count
     FROM event_store_events
     WHERE stream_id = ANY($1::text[])
     GROUP BY stream_id`,
    [streamIds],
  );
  const counts = new Map(result.rows.map(({ stream_id, count }) => [stream_id, Number(count)]));
  return Object.fromEntries(streamIds.map((streamId) => [streamId, counts.get(streamId) ?? 0]));
}

const scenarioCatalogItemIds = Object.values(catalogSeedIds.items);

async function scenarioCatalogItemEventCount(): Promise<number> {
  const streamIds = scenarioCatalogItemIds.map((catalogItemId) => `catalog.item-${catalogItemId}`);
  const result = await pools.catalog.query<Readonly<{ count: string }>>(
    `SELECT COUNT(*) AS count
     FROM event_store_events
     WHERE stream_id = ANY($1::text[])`,
    [streamIds],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function scenarioCatalogItemProjectionCount(): Promise<number> {
  const result = await pools.catalog.query<Readonly<{ count: string }>>(
    `SELECT COUNT(*) AS count
     FROM catalog_items
     WHERE catalog_item_id = ANY($1::text[])`,
    [scenarioCatalogItemIds],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function expectAllRequiredAggregatesActive(): Promise<void> {
  const states = await inspectCatalogIntegrationSeedState(pools.catalog);
  expect(
    states.filter(({ kind }) => kind !== "active"),
    JSON.stringify(states.filter(({ kind }) => kind !== "active")),
  ).toEqual([]);
}

async function expectInterruptionSiteResumes(site: InterruptionSite): Promise<void> {
  for (const profile of profileShapes) {
    const runtime = await prepareCatalog();
    await interruptCatalogSeed(catalogServices(runtime), site, profile);
    await ordinaryBoot(runtime, profile);
    await expectAllRequiredAggregatesActive();
    const afterBootOne = await requiredEventCounts();
    await ordinaryBoot(runtime, profile);
    const afterBootTwo = await requiredEventCounts();
    expect(afterBootTwo, `${site} / ${profile.name}`).toEqual(afterBootOne);
  }
}

async function createSingleCardIdentityDraft(services: CatalogServices, key = "single-card-identity"): Promise<void> {
  await services.components.commandHandler({
    streamId: `catalog.component-${catalogSeedIds.components.singleCardIdentity}`,
    command: {
      type: "CreateComponent",
      componentId: catalogSeedIds.components.singleCardIdentity,
      key,
      name: { defaultLocale: "en", values: { en: "Single Card Identity" } },
      description: { defaultLocale: "en", values: { en: "Test retained state" } },
    },
    context: {
      tenantId: "tnt_catalog_seed_test",
      audit: {
        performedByUserId: "usr_catalog_seed_test",
        forAccountId: "acc_catalog_seed_test",
      },
    } as never,
  });
}

async function countEventType(streamId: string, eventType: string): Promise<number> {
  const result = await pools.catalog.query<Readonly<{ count: string }>>(
    `SELECT COUNT(*) AS count
     FROM event_store_events
     WHERE stream_id = $1 AND event_type = $2`,
    [streamId, eventType],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function expectCatalogOnlyHarnessConnections(): Promise<void> {
  const ownedDatabaseNames = Object.values(databaseUrls).map((databaseUrl) =>
    new URL(databaseUrl).pathname.replace(/^\//u, ""),
  );
  const catalogDatabaseName = new URL(databaseUrls.catalog).pathname.replace(/^\//u, "");
  const result = await pools.catalog.query<Readonly<{ datname: string; connection_count: string }>>(
    `SELECT datname, COUNT(*) AS connection_count
     FROM pg_stat_activity
     WHERE datname = ANY($1::text[])
     GROUP BY datname
     ORDER BY datname`,
    [ownedDatabaseNames],
  );

  expect(result.rows).toEqual([{ datname: catalogDatabaseName, connection_count: "1" }]);
}

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

  it("resumes after Dimensions under scenario-seed and production-like profiles", async () => {
    await expectInterruptionSiteResumes("dimensions");
  });

  it("resumes after Fields under scenario-seed and production-like profiles", async () => {
    await expectInterruptionSiteResumes("fields");
  });

  it("resumes after Reference Data under scenario-seed and production-like profiles", async () => {
    await expectInterruptionSiteResumes("reference-data");
  });

  it("resumes after Components under scenario-seed and production-like profiles", async () => {
    await expectInterruptionSiteResumes("components");
  });

  it("resumes after Blueprints under scenario-seed and production-like profiles", async () => {
    await expectInterruptionSiteResumes("blueprints");
  });

  it("resumes after the final Category under scenario-seed and production-like profiles", async () => {
    await expectInterruptionSiteResumes("categories");
  });

  it("resumes mid catalog.component.created under scenario-seed and production-like profiles", async () => {
    await expectInterruptionSiteResumes("mid-component-created");
  });

  it("keeps the required aggregate set equal to the base aggregate streams authored by the seed", async () => {
    const runtime = await prepareCatalog();
    await ordinaryBoot(runtime, profileShapes[0]);
    const createdTypes = [
      "catalog.dimension.created",
      "catalog.field.created",
      "catalog.reference-type.created",
      "catalog.reference-record.created",
      "catalog.component.created",
      "catalog.blueprint.created",
      "catalog.category.created",
    ];
    const result = await pools.catalog.query<Readonly<{ stream_id: string }>>(
      `SELECT DISTINCT stream_id
       FROM event_store_events
       WHERE event_type = ANY($1::text[])
       ORDER BY stream_id`,
      [createdTypes],
    );
    expect(result.rows.map(({ stream_id }) => stream_id)).toEqual(
      catalogIntegrationSeedRequirements.map(({ streamId }) => streamId).sort(),
    );
  });

  it("preserves duplicate CreateDimension rejection through the non-seed command handler", async () => {
    const runtime = await prepareCatalog();
    await ordinaryBoot(runtime, profileShapes[0]);
    const services = catalogServices(runtime);
    const streamId = `catalog.dimension-${catalogSeedIds.dimensions.form.dimensionId}`;
    const before = await countEventType(streamId, "catalog.dimension.created");
    await expect(
      services.dimensions.commandHandler({
        streamId,
        command: {
          type: "CreateDimension",
          dimensionId: catalogSeedIds.dimensions.form.dimensionId,
          key: "form",
          name: { defaultLocale: "en", values: { en: "Form" } },
          description: { defaultLocale: "en", values: { en: "Duplicate authoring control" } },
          valueKind: "unordered",
        },
        context: {
          tenantId: "tnt_catalog_seed_test",
          audit: {
            performedByUserId: "usr_catalog_seed_test",
            forAccountId: "acc_catalog_seed_test",
          },
        } as never,
      }),
    ).rejects.toThrow("Dimension has already been created.");
    expect(await countEventType(streamId, "catalog.dimension.created")).toBe(before);
  });
});
