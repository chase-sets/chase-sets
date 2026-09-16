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
import { expect } from "vitest";
import { createPlatformApiHost } from "../src/app";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import {
  type PlatformApiBootstrapTestState,
  listingPhotoStorage,
  type PlatformApiTestPools,
} from "./bootstrap-db-test-support";
import type { PlatformApiContextName } from "../src/config";

export type CatalogServices = ReturnType<typeof catalogModule.createServices>;

export type InterruptionSite =
  | "dimensions"
  | "fields"
  | "reference-data"
  | "components"
  | "blueprints"
  | "categories"
  | "mid-component-created";

export const catalogApiContextRegistry = apiContextRegistry.filter((context) => context.contextName === "catalog");

export const profileShapes = [
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

export let databaseUrls: Readonly<Record<PlatformApiContextName, string>>;

export let pools: PlatformApiTestPools;

export function createCatalogSeedHost() {
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

export async function prepareCatalog() {
  await resetMultiContextTestSchemas({ catalog: pools.catalog });
  await bootstrapContextDatabase(catalogModule, pools.catalog);
  return createCatalogSeedHost();
}

export function catalogServices(runtime: ReturnType<typeof createCatalogSeedHost>): CatalogServices {
  return runtime.services.catalog as CatalogServices;
}

export function bootstrapOptions(profile: (typeof profileShapes)[number]): ApiHostSeedOptions {
  return {
    enabledDataProfiles: profile.profiles,
    environmentName: profile.environmentName,
  };
}

export async function ordinaryBoot(
  runtime: ReturnType<typeof createCatalogSeedHost>,
  profile: (typeof profileShapes)[number],
): Promise<void> {
  await seedApiHostIfEmpty(catalogApiContextRegistry, "platform-api", runtime, bootstrapOptions(profile));
}

export async function directCatalogSeed(
  services: CatalogServices,
  profile: (typeof profileShapes)[number],
): Promise<void> {
  if (!catalogModule.seed) {
    throw new Error("Catalog module seed is unavailable.");
  }
  await catalogModule.seed(pools.catalog, services, bootstrapOptions(profile));
}

export async function interruptCatalogSeed(
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

export async function requiredEventCounts(): Promise<Readonly<Record<string, number>>> {
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

export const scenarioCatalogItemIds = Object.values(catalogSeedIds.items);

export async function scenarioCatalogItemEventCount(): Promise<number> {
  const streamIds = scenarioCatalogItemIds.map((catalogItemId) => `catalog.item-${catalogItemId}`);
  const result = await pools.catalog.query<Readonly<{ count: string }>>(
    `SELECT COUNT(*) AS count
     FROM event_store_events
     WHERE stream_id = ANY($1::text[])`,
    [streamIds],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function scenarioCatalogItemProjectionCount(): Promise<number> {
  const result = await pools.catalog.query<Readonly<{ count: string }>>(
    `SELECT COUNT(*) AS count
     FROM catalog_items
     WHERE catalog_item_id = ANY($1::text[])`,
    [scenarioCatalogItemIds],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function expectAllRequiredAggregatesActive(): Promise<void> {
  const states = await inspectCatalogIntegrationSeedState(pools.catalog);
  expect(
    states.filter(({ kind }) => kind !== "active"),
    JSON.stringify(states.filter(({ kind }) => kind !== "active")),
  ).toEqual([]);
}

export async function expectInterruptionSiteResumes(site: InterruptionSite): Promise<void> {
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

export async function createSingleCardIdentityDraft(
  services: CatalogServices,
  key = "single-card-identity",
): Promise<void> {
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

export async function countEventType(streamId: string, eventType: string): Promise<number> {
  const result = await pools.catalog.query<Readonly<{ count: string }>>(
    `SELECT COUNT(*) AS count
     FROM event_store_events
     WHERE stream_id = $1 AND event_type = $2`,
    [streamId, eventType],
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function productMeasuresResolvedEventCount(): Promise<number> {
  const result = await pools.catalog.query<Readonly<{ count: string }>>(
    `SELECT COUNT(*) AS count
     FROM event_store_events
     WHERE event_type = 'catalog.catalog-item.product-measures-resolved'`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

export async function expectCatalogOnlyHarnessConnections(): Promise<void> {
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

export function assignCatalogSeedState(state: PlatformApiBootstrapTestState): void {
  databaseUrls = state.databaseUrls;
  pools = state.pools;
}
