import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import {
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { module as catalogModule } from "@chase-sets/catalog";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { getApiHostContextNames } from "@chase-sets/platform-runtime/api";
import { runAdminQaActorFixtures } from "../src/admin-qa-actor-fixtures";
import { createPlatformApiHost } from "../src/app";
import { getContextDatabaseEnvName, loadConfig, type PlatformApiContextName } from "../src/config";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import { runRepresentativeCommerceState } from "../src/representative-commerce-state";

const command = process.argv[2];
assert.ok(command === "representative" || command === "admin-qa", "Select one diagnostic command");
const contextNames = getApiHostContextNames(apiContextRegistry, "platform-api");
const listingPhotoStorage = {
  async getObject() {
    return null;
  },
  async putObject(input: { key: string }) {
    return { key: input.key, publicUrl: `https://assets.test/${input.key}` };
  },
};
type Pools = ReturnType<typeof createPlatformApiPools>;
let databaseUrls: Readonly<Record<PlatformApiContextName, string>>;
let pools: Pools | undefined;
const startedAt = new Date().toISOString();
const start = performance.now();
const result: Record<string, unknown> = { command, startedAt, stage: "setup" };

function config() {
  const entries = [
    ["PLATFORM_CONTROL_DATABASE_URL", databaseUrls.auth] as const,
    ...contextNames.map((name) => [getContextDatabaseEnvName(name), databaseUrls[name]] as const),
  ];
  const previous = entries.map(([name]) => [name, process.env[name]] as const);
  try {
    for (const [name, url] of entries) process.env[name] = url;
    return {
      ...loadConfig(),
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

async function countEvents(pool: Pools[PlatformApiContextName], eventType: string) {
  const query = await pool.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM event_store_events WHERE event_type = $1",
    [eventType],
  );
  return Number(query.rows[0]?.count ?? 0);
}

function describeError(error: unknown): unknown {
  if (!(error instanceof Error)) return { value: String(error) };
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause === undefined ? undefined : describeError(error.cause),
  };
}

async function main() {
  try {
    const baseUrl = process.env.TEST_DATABASE_URL;
    assert.ok(baseUrl, "TEST_DATABASE_URL is required for database-backed platform-api tests.");
    databaseUrls = createMultiContextTestDatabaseUrls(
      baseUrl,
      contextNames,
      "platform_api_seed_command_full_pools",
    ) as Readonly<Record<PlatformApiContextName, string>>;
    await ensureMultiContextTestDatabases(baseUrl, databaseUrls);
    pools = createPlatformApiPools({
      runtimeProfile: "public",
      sharedDatabaseUrl: null,
      contextDatabaseUrls: databaseUrls,
      port: 6182,
    });
    await resetMultiContextTestSchemas(pools);
    await pools.auth.query("SELECT 1");
    result.databaseReachable = true;
    result.stage = "command";
    console.log(`diagnostic command=${command} acquisitionTimeoutMs=5000 databaseReachable=true`);
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      messages.push(String(args[0]));
      originalLog(...args);
    };
    try {
      if (command === "representative") {
        const hookRuntime = createPlatformApiHost({
          runtimeProfile: "public",
          pools,
          hostPorts: { processorGateway: createFakePaymentProcessorGateway(), listingPhotoStorage },
        });
        const completedSteps: string[] = [];
        await runRepresentativeCommerceState({
          config: config(),
          execution: { deploymentEnvironment: "test", confirmation: "seed staging commerce" },
          evidenceOutPath: null,
          async afterStepCompleted(stepName) {
            completedSteps.push(stepName);
            if (stepName === "seed data profiles") {
              const catalogContext = hookRuntime.mountedContexts.find((context) => context.contextName === "catalog");
              assert.ok(catalogContext, "Expected Catalog in the seed regression host.");
              await drainLocalProjectionHandlerSets(
                catalogContext.contextName,
                catalogContext.pool,
                catalogContext.projectionHandlerSets,
              );
            }
            if (stepName === "sync catalog.catalog-item-projection") {
              const services = hookRuntime.services.catalog as ReturnType<typeof catalogModule.createServices>;
              await services.productMeasures.upsertProfile({
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
        });
        const evidence = messages
          .map(parseEvidence)
          .find((entry) => entry?.type === "representative-commerce-state.complete");
        assert.equal(typeof evidence?.representativeListingCount, "number");
        assert.equal(typeof evidence?.representativeOfferCount, "number");
        assert.equal(typeof evidence?.representativeAcceptedOfferCount, "number");
        assert.ok(Number(evidence?.representativeListingCount) > 0);
        assert.ok(Number(evidence?.representativeOfferCount) > 0);
        assert.ok(completedSteps.includes("drain remaining representative projections"));
        assert.ok(completedSteps.includes("accept representative offers"));
        assert.ok((await countEvents(pools.marketplace, "marketplace.listing.created")) > 0);
        assert.ok((await countEvents(pools.marketplace, "marketplace.offer.submitted")) > 0);
        assert.ok((await countEvents(pools.ordering, "ordering.order.created")) > 0);
      } else {
        const previous = process.env.ADMIN_QA_ACTOR_FIXTURES_CONFIRM;
        try {
          process.env.ADMIN_QA_ACTOR_FIXTURES_CONFIRM = "provision admin qa fixtures";
          await runAdminQaActorFixtures({ config: config() });
        } finally {
          if (previous === undefined) delete process.env.ADMIN_QA_ACTOR_FIXTURES_CONFIRM;
          else process.env.ADMIN_QA_ACTOR_FIXTURES_CONFIRM = previous;
        }
        const evidence = messages
          .map(parseEvidence)
          .find((entry) => entry?.type === "admin-qa-actor-fixtures.complete");
        assert.equal(evidence?.requiredActorMatrixSize, 6);
        assert.equal(evidence?.provisionedActorMatrixSize, 6);
        assert.ok(Array.isArray(evidence?.fixtures));
        assert.ok(
          evidence.fixtures.some(
            (fixture: unknown) =>
              typeof fixture === "object" &&
              fixture !== null &&
              "roleKey" in fixture &&
              fixture.roleKey === "platform-admin",
          ),
        );
        assert.ok((await countEvents(pools.identity, "identity.account.created")) > 0);
        assert.ok((await countEvents(pools.identity, "identity.membership.granted")) > 0);
      }
      result.postStateAsserted = true;
      result.commandResult = "fulfilled";
    } finally {
      console.log = originalLog;
    }
  } catch (error) {
    result.error = describeError(error);
    result.commandResult = "rejected";
    process.exitCode = 1;
  } finally {
    try {
      if (pools) await closePlatformApiPools(pools);
      result.poolsClosed = true;
    } catch (error) {
      result.cleanupError = describeError(error);
      process.exitCode = 1;
    }
    result.finishedAt = new Date().toISOString();
    result.durationMs = performance.now() - start;
    result.exitCode = process.exitCode ?? 0;
    console.log(JSON.stringify(result));
    if (process.env.DIAGNOSTIC_RESULT_PATH)
      writeFileSync(process.env.DIAGNOSTIC_RESULT_PATH, JSON.stringify(result, null, 2));
  }
}

function parseEvidence(message: string): Record<string, unknown> | null {
  try {
    return JSON.parse(message) as Record<string, unknown>;
  } catch {
    return null;
  }
}

await main();
