import { describe, expect, it, vi } from "vitest";
import { drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { module as catalogModule } from "@chase-sets/catalog";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { runAdminQaActorFixtures } from "../src/admin-qa-actor-fixtures";
import { createPlatformApiHost } from "../src/app";
import { getContextDatabaseEnvName, loadConfig, type PlatformApiContextName } from "../src/config";
import { runRepresentativeCommerceState } from "../src/representative-commerce-state";
import {
  createPlatformApiBootstrapTestHarness,
  listingPhotoStorage,
  platformApiContextNames,
  type PlatformApiTestPools,
} from "./bootstrap-db-test-support";

let databaseUrls: Readonly<Record<PlatformApiContextName, string>>;
let assertionPools: PlatformApiTestPools;
createPlatformApiBootstrapTestHarness("platform_api_seed_command_full_pools", (state) => {
  databaseUrls = state.databaseUrls;
  assertionPools = state.pools;
});

function createCappedSeedTestConfig() {
  const contextEntries = platformApiContextNames.map(
    (contextName) => [getContextDatabaseEnvName(contextName), databaseUrls[contextName]] as const,
  );
  const entries = [["PLATFORM_CONTROL_DATABASE_URL", databaseUrls.auth] as const, ...contextEntries];
  const previous = entries.map(([name]) => [name, process.env[name]] as const);
  try {
    for (const [name, url] of entries) process.env[name] = url;
    const baseConfig = loadConfig();
    return {
      ...baseConfig,
      deploymentEnvironment: "test" as const,
      runtimeProfile: "public" as const,
      sharedDatabaseUrl: null,
      controlDatabaseUrl: databaseUrls.auth,
      workSignalDatabaseUrl: databaseUrls.auth,
      contextDatabaseUrls: databaseUrls,
      contextWaiterDatabaseUrls: databaseUrls,
    };
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function countEvents(pool: PlatformApiTestPools[PlatformApiContextName], eventType: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM event_store_events WHERE event_type = $1",
    [eventType],
  );
  return Number(result.rows[0]?.count ?? 0);
}

describe("seed commands with owned capped pools and preview-shaped waiters", () => {
  it("completes representative commerce seeds, projections, fan-outs and post-state", async () => {
    const hookRuntime = createPlatformApiHost({
      runtimeProfile: "public",
      pools: assertionPools,
      hostPorts: { processorGateway: createFakePaymentProcessorGateway(), listingPhotoStorage },
    });
    const completedSteps: string[] = [];
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(
        runRepresentativeCommerceState({
          config: createCappedSeedTestConfig(),
          execution: { deploymentEnvironment: "test", confirmation: "seed staging commerce" },
          evidenceOutPath: null,
          async afterStepCompleted(stepName) {
            completedSteps.push(stepName);
            if (stepName === "seed data profiles") {
              const catalogContext = hookRuntime.mountedContexts.find((context) => context.contextName === "catalog");
              if (!catalogContext) throw new Error("Expected Catalog in the seed regression host.");
              await drainLocalProjectionHandlerSets(
                catalogContext.contextName,
                catalogContext.pool,
                catalogContext.projectionHandlerSets,
              );
            }
            if (stepName === "sync catalog.catalog-item-projection") {
              const catalogServices = hookRuntime.services.catalog as ReturnType<typeof catalogModule.createServices>;
              await catalogServices.productMeasures.upsertProfile({
                profileId: "pmp_representative_commerce_resume_test_card",
                key: "representative-commerce-resume-test-card",
                name: "Representative commerce resume test card",
                matchBlueprintId: catalogSeedIds.blueprints.pokemonCardSingle,
                precedence: 5,
                unitLengthInches: 3.5,
                unitWidthInches: 2.5,
                unitHeightInches: 0.012,
                unitWeightOunces: 0.064,
                physicalFlags: ["raw-card", "bendable"],
                stackBehavior: "stackable-thickness",
                confidence: "conservative-estimate",
              });
            }
          },
        }),
      ).resolves.toBeUndefined();
      const evidence = output.mock.calls
        .map(([message]) => {
          try {
            return JSON.parse(String(message)) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((entry) => entry?.type === "representative-commerce-state.complete");
      expect(evidence).toMatchObject({
        representativeListingCount: expect.any(Number),
        representativeOfferCount: expect.any(Number),
        representativeAcceptedOfferCount: expect.any(Number),
      });
      expect(Number(evidence?.representativeListingCount)).toBeGreaterThan(0);
      expect(Number(evidence?.representativeOfferCount)).toBeGreaterThan(0);
      expect(completedSteps).toContain("drain remaining representative projections");
      expect(completedSteps).toContain("accept representative offers");
      expect(await countEvents(assertionPools.marketplace, "marketplace.listing.created")).toBeGreaterThan(0);
      expect(await countEvents(assertionPools.marketplace, "marketplace.offer.submitted")).toBeGreaterThan(0);
      expect(await countEvents(assertionPools.ordering, "ordering.order.created")).toBeGreaterThan(0);
    } finally {
      output.mockRestore();
    }
  }, 120_000);

  it("completes admin-QA fixtures and retains their seeded identity post-state", async () => {
    const previousConfirm = process.env.ADMIN_QA_ACTOR_FIXTURES_CONFIRM;
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      process.env.ADMIN_QA_ACTOR_FIXTURES_CONFIRM = "provision admin qa fixtures";
      await expect(runAdminQaActorFixtures({ config: createCappedSeedTestConfig() })).resolves.toBeUndefined();
      const evidence = output.mock.calls
        .map(([message]) => {
          try {
            return JSON.parse(String(message)) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((entry) => entry?.type === "admin-qa-actor-fixtures.complete");
      expect(evidence).toMatchObject({
        requiredActorMatrixSize: 6,
        provisionedActorMatrixSize: 6,
        fixtures: expect.arrayContaining([expect.objectContaining({ roleKey: "platform-admin" })]),
      });
      expect(await countEvents(assertionPools.identity, "identity.account.created")).toBeGreaterThan(0);
      expect(await countEvents(assertionPools.identity, "identity.membership.granted")).toBeGreaterThan(0);
    } finally {
      output.mockRestore();
      if (previousConfirm === undefined) delete process.env.ADMIN_QA_ACTOR_FIXTURES_CONFIRM;
      else process.env.ADMIN_QA_ACTOR_FIXTURES_CONFIRM = previousConfirm;
    }
  }, 120_000);
});
