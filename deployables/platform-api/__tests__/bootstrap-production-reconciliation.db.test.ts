import { describe, expect, it, vi } from "vitest";
import {
  bootstrapContextDatabase,
  drainContextRuntime,
  drainLocalProjectionHandlerSets,
  SCHEMA_MIGRATIONS_TABLE,
  seedProfilesOverlap,
} from "@chase-sets/bounded-context-runtime";
import { module as catalogModule } from "@chase-sets/catalog";
import { catalogSeedIds, representativeProductContentsScenario } from "@chase-sets/catalog-seed";
import { module as identityModule } from "@chase-sets/identity";
import {
  productionLikeDataProfiles,
  representativeCommerceStateDataProfiles,
  seedApiHostIfEmpty,
} from "@chase-sets/platform-runtime/api";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { publicPolicyValueKeys } from "@chase-sets/public-presence/server";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { buildPlatformApiApp, createPlatformApiHost } from "../src/app";
import type { PlatformApiContextName } from "../src/config";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";
import { apiContextRegistry } from "../src/generated/api-context-registry";
import { runRepresentativeCommerceState } from "../src/representative-commerce-state";
import {
  createPlatformApiBootstrapTestHarness,
  hasSettledWithin,
  holdSchemaBootstrapAdvisoryLock,
  listingPhotoStorage,
} from "./bootstrap-db-test-support";
import type { PlatformApiTestPools } from "./bootstrap-db-test-support";

const identityApiContextRegistry = apiContextRegistry.filter((context) => context.contextName === "identity");
const retainedRepresentativeAccount = {
  accountId: "acc_repr_staging_collector_account" as AccountId,
  userId: "usr_repr_staging_collector_user",
  contactMethodId: "ctm_repr_staging_collector_email",
  shippingAddressId: "adr_repr_staging_collector_home",
  name: "Staging Collector",
  accountType: "personal",
  displayName: "Staging Collector",
  primaryEmail: "staging-collector@chasesets.test",
  givenName: "Staging",
  familyName: "Collector",
} as const;
type RepresentativeAccountProfile = Readonly<{
  accountId: AccountId;
  name: string;
  accountType: "personal" | "business" | "enterprise";
  displayName: string;
}>;

let databaseUrls: Readonly<Record<PlatformApiContextName, string>>;
let pools: PlatformApiTestPools;
createPlatformApiBootstrapTestHarness("platform_api_bootstrap_production_reconciliation", (state) => {
  databaseUrls = state.databaseUrls;
  pools = state.pools;
});

function createIdentitySeedHost(pools: PlatformApiTestPools) {
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
    mountedContexts: runtime.mountedContexts.filter((context) => context.contextName === "identity"),
  };
}

async function countRepresentativeAccountCreatedEvents(
  pool: PlatformApiTestPools["identity"],
  accountId?: string,
): Promise<number> {
  const result = await pool.query<Readonly<{ count: string }>>(
    `SELECT COUNT(*) AS count
     FROM event_store_events
     WHERE event_type = 'identity.account.created'
       AND ($1::text IS NULL OR stream_id = 'identity.account-' || $1)`,
    [accountId ?? null],
  );

  return Number(result.rows[0]?.count ?? 0);
}

async function countRepresentativeIdentityCreationEvents(
  pool: PlatformApiTestPools["identity"],
): Promise<Readonly<Record<string, number>>> {
  const eventTypes = [
    "identity.account.created",
    "identity.user.created",
    "identity.membership.granted",
    "identity.consent.recorded",
    "identity.shipping-address.added",
  ] as const;
  const result = await pool.query<Readonly<{ event_type: string; count: string }>>(
    `SELECT event_type, COUNT(*) AS count
     FROM event_store_events
     WHERE event_type = ANY($1::text[])
     GROUP BY event_type`,
    [eventTypes],
  );
  const counts = Object.fromEntries(eventTypes.map((eventType) => [eventType, 0]));
  for (const row of result.rows) {
    counts[row.event_type] = Number(row.count);
  }
  return counts;
}

async function countCreationEvents(
  pool: PlatformApiTestPools[PlatformApiContextName],
  eventType: string,
): Promise<Readonly<{ eventCount: number; streamCount: number }>> {
  const result = await pool.query<Readonly<{ event_count: string; stream_count: string }>>(
    `SELECT COUNT(*) AS event_count, COUNT(DISTINCT stream_id) AS stream_count
     FROM event_store_events
     WHERE event_type = $1`,
    [eventType],
  );
  return {
    eventCount: Number(result.rows[0]?.event_count ?? 0),
    streamCount: Number(result.rows[0]?.stream_count ?? 0),
  };
}

async function representativeParticipantIdentities(
  pools: PlatformApiTestPools,
): Promise<Readonly<{ sellerAccountIds: readonly string[]; buyerAccountIds: readonly string[] }>> {
  const [listings, offers] = await Promise.all([
    pools.marketplace.query<Readonly<{ account_id: string }>>(
      `SELECT DISTINCT account_id
       FROM marketplace_listing_pages
       WHERE listing_id LIKE 'lst$_repr$_%' ESCAPE '$'
       ORDER BY account_id`,
    ),
    pools.marketplace.query<Readonly<{ buyer_account_id: string }>>(
      `SELECT DISTINCT buyer_account_id
       FROM marketplace_offer_pages
       WHERE offer_id LIKE 'off$_repr$_%' ESCAPE '$'
       ORDER BY buyer_account_id`,
    ),
  ]);
  return {
    sellerAccountIds: listings.rows.map((row) => row.account_id),
    buyerAccountIds: offers.rows.map((row) => row.buyer_account_id),
  };
}

async function ensureRepresentativeProductContentsTestMeasureProfile(
  runtime: ReturnType<typeof createPlatformApiHost>,
): Promise<void> {
  const catalogServices = runtime.services.catalog as ReturnType<typeof catalogModule.createServices>;
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

async function appendRepresentativeAccountCreatedEvent(
  runtime: ReturnType<typeof createIdentitySeedHost>,
  profile: RepresentativeAccountProfile,
): Promise<void> {
  const identityServices = runtime.services.identity as ReturnType<typeof identityModule.createServices>;
  await identityServices.accounts.commandHandler({
    streamId: `identity.account-${profile.accountId}`,
    command: {
      type: "CreateAccount",
      ...profile,
    },
    context: {
      tenantId: "tnt_identity",
      audit: {
        performedByUserId: "usr_identity_bootstrap",
        forAccountId: "acc_identity_bootstrap",
      },
      trace: {},
    } as never,
  });
}

async function runRepresentativeIdentitySeed(runtime: ReturnType<typeof createIdentitySeedHost>): Promise<void> {
  await seedApiHostIfEmpty(identityApiContextRegistry, "platform-api", runtime, {
    enabledDataProfiles: representativeCommerceStateDataProfiles,
    environmentName: "test",
    runtimeProfile: "public",
  });
}

describe("platform api bootstrap production reconciliation", () => {
  it("bootstraps and reconciles every whitelisted public policy value in the production landing profile", async () => {
    const landingPools = createPlatformApiPools({
      runtimeProfile: "landing",
      sharedDatabaseUrl: null,
      contextDatabaseUrls: databaseUrls,
      port: 6184,
    });

    try {
      const runtime = createPlatformApiHost({
        runtimeProfile: "landing",
        pools: landingPools,
        hostPorts: {
          processorGateway: createFakePaymentProcessorGateway(),
          listingPhotoStorage,
        },
      });
      const bootstrapOptions = {
        enabledDataProfiles: productionLikeDataProfiles,
        environmentName: "production",
        runtimeProfile: "landing",
      } as const;

      expect(runtime.mountedContexts.map(({ contextName, mountRole }) => [contextName, mountRole])).toEqual(
        expect.arrayContaining([
          ["commercial-terms", "source-only"],
          ["settlement", "source-only"],
        ]),
      );

      await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, bootstrapOptions);
      await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, {
        ...bootstrapOptions,
        enabledDataProfiles: ["critical-bootstrap"],
      });

      const app = buildPlatformApiApp(runtime, { runtimeProfile: "landing" });
      const response = await app.request("/api/public-presence/policy-values");
      const body = (await response.json()) as { values: Readonly<Record<string, unknown>> };

      expect(response.status).toBe(200);
      expect(Object.keys(body.values).sort()).toEqual([...publicPolicyValueKeys].sort());

      for (const [contextName, policyKeys] of [
        [
          "commercial-terms",
          ["commercial-terms.marketplace-sales-fee-schedule", "commercial-terms.checkout-processing-fee"],
        ],
        ["settlement", ["settlement.clearance-window", "settlement.payout-bounds"]],
      ] as const) {
        const result = await landingPools[contextName].query<Readonly<{ policy_key: string; count: string }>>(
          `SELECT policy_key, COUNT(*) AS count
             FROM platform_policy_documents
            WHERE policy_key = ANY($1::text[])
              AND status = 'active'
            GROUP BY policy_key
            ORDER BY policy_key`,
          [policyKeys],
        );
        expect(result.rows.map(({ policy_key, count }) => [policy_key, Number(count)])).toEqual(
          [...policyKeys].sort().map((policyKey) => [policyKey, 1]),
        );
      }
    } finally {
      await closePlatformApiPools(landingPools);
    }
  }, 120_000);

  it("reconciles a queued active public bootstrap after its predecessor fails with partial Commercial Terms history", async () => {
    const queuedPools = createPlatformApiPools({
      runtimeProfile: "public",
      sharedDatabaseUrl: null,
      contextDatabaseUrls: databaseUrls,
      port: 6185,
    });
    const predecessorRuntime = createPlatformApiHost({
      runtimeProfile: "public",
      pools,
      hostPorts: {
        processorGateway: createFakePaymentProcessorGateway(),
        listingPhotoStorage,
      },
    });
    const queuedRuntime = createPlatformApiHost({
      runtimeProfile: "public",
      pools: queuedPools,
      hostPorts: {
        processorGateway: createFakePaymentProcessorGateway(),
        listingPhotoStorage,
      },
    });
    const commercialTermsContext = predecessorRuntime.mountedContexts.find(
      (context) => context.contextName === "commercial-terms",
    );
    if (!commercialTermsContext?.module.seed) {
      throw new Error("Expected a seeded active Commercial Terms context in the public runtime.");
    }
    expect(commercialTermsContext.mountRole).toBe("active");

    await bootstrapContextDatabase(commercialTermsContext.module, commercialTermsContext.pool);
    await commercialTermsContext.module.seed(commercialTermsContext.pool, commercialTermsContext.services, {
      enabledDataProfiles: ["scenario-seed"],
      environmentName: "test",
    });

    const legacyEventsBeforeBootstrap = await pools["commercial-terms"].query<Readonly<{ count: string }>>(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE stream_id LIKE 'commercial-terms.%'`,
    );
    const criticalPoliciesBeforeBootstrap = await pools["commercial-terms"].query<Readonly<{ count: string }>>(
      `SELECT COUNT(*) AS count
       FROM platform_policy_documents
       WHERE policy_key = ANY($1::text[])
         AND status = 'active'`,
      [["commercial-terms.marketplace-sales-fee-schedule", "commercial-terms.checkout-processing-fee"]],
    );
    expect(Number(legacyEventsBeforeBootstrap.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(criticalPoliciesBeforeBootstrap.rows[0]?.count ?? 0)).toBe(0);

    let signalPredecessorSeedReached: () => void = () => undefined;
    const predecessorSeedReached = new Promise<void>((resolve) => {
      signalPredecessorSeedReached = resolve;
    });
    let failPredecessorSeed: () => void = () => undefined;
    const predecessorMayFail = new Promise<void>((resolve) => {
      failPredecessorSeed = resolve;
    });
    const failingPredecessorRuntime = {
      ...predecessorRuntime,
      mountedContexts: predecessorRuntime.mountedContexts.map((context) => {
        if (context.contextName !== "commercial-terms") return context;
        return {
          ...context,
          module: {
            ...context.module,
            seed: async () => {
              signalPredecessorSeedReached();
              await predecessorMayFail;
              throw new Error("test-only predecessor failed before critical policy convergence");
            },
          },
        };
      }),
    } satisfies typeof predecessorRuntime;
    const bootstrapOptions = {
      enabledDataProfiles: productionLikeDataProfiles,
      environmentName: "production",
      runtimeProfile: "public",
      schemaBootstrap: {
        lockAcquisitionTimeoutMs: 120_000,
        lockTimeoutMs: 50,
        lockTimeoutRetryBudgetMs: 1_000,
        lockTimeoutRetryBaseDelayMs: 25,
        lockTimeoutRetryMaxDelayMs: 50,
        lockTimeoutRetryJitterMs: 0,
      },
    } as const;
    const predecessorBootstrap = seedApiHostIfEmpty(
      apiContextRegistry,
      "platform-api",
      failingPredecessorRuntime,
      bootstrapOptions,
    );
    await predecessorSeedReached;
    const queuedBootstrap = seedApiHostIfEmpty(apiContextRegistry, "platform-api", queuedRuntime, bootstrapOptions);

    try {
      await expect(hasSettledWithin(queuedBootstrap, 100)).resolves.toBe(false);
      failPredecessorSeed();
      await expect(predecessorBootstrap).rejects.toThrow(
        "test-only predecessor failed before critical policy convergence",
      );
      await expect(queuedBootstrap).resolves.toBeUndefined();

      for (const [contextName, policyKeys] of [
        [
          "commercial-terms",
          ["commercial-terms.marketplace-sales-fee-schedule", "commercial-terms.checkout-processing-fee"],
        ],
        ["settlement", ["settlement.clearance-window", "settlement.payout-bounds"]],
      ] as const) {
        const result = await queuedPools[contextName].query<Readonly<{ policy_key: string; count: string }>>(
          `SELECT policy_key, COUNT(*) AS count
           FROM platform_policy_documents
           WHERE policy_key = ANY($1::text[])
             AND status = 'active'
           GROUP BY policy_key
           ORDER BY policy_key`,
          [policyKeys],
        );
        expect(result.rows.map(({ policy_key, count }) => [policy_key, Number(count)])).toEqual(
          [...policyKeys].sort().map((policyKey) => [policyKey, 1]),
        );
      }

      const app = buildPlatformApiApp(queuedRuntime, { runtimeProfile: "public" });
      const response = await app.request("/api/public-presence/policy-values");
      const body = (await response.json()) as { values: Readonly<Record<string, unknown>> };
      expect(response.status).toBe(200);
      expect(Object.keys(body.values).sort()).toEqual([...publicPolicyValueKeys].sort());

      await expect(
        seedApiHostIfEmpty(apiContextRegistry, "platform-api", queuedRuntime, bootstrapOptions),
      ).resolves.toBeUndefined();
      const dayAfterPolicies = await queuedPools["commercial-terms"].query<
        Readonly<{ policy_key: string; count: string }>
      >(
        `SELECT policy_key, COUNT(*) AS count
         FROM platform_policy_documents
         WHERE policy_key = ANY($1::text[])
           AND status = 'active'
         GROUP BY policy_key
         ORDER BY policy_key`,
        [["commercial-terms.marketplace-sales-fee-schedule", "commercial-terms.checkout-processing-fee"]],
      );
      expect(dayAfterPolicies.rows.map(({ policy_key, count }) => [policy_key, Number(count)])).toEqual([
        ["commercial-terms.checkout-processing-fee", 1],
        ["commercial-terms.marketplace-sales-fee-schedule", 1],
      ]);
    } finally {
      failPredecessorSeed();
      await Promise.allSettled([predecessorBootstrap, queuedBootstrap]);
      await closePlatformApiPools(queuedPools);
    }
  }, 240_000);

  it("serializes two concurrent full production-like API host bootstraps with a database advisory lock", async () => {
    const secondPools = createPlatformApiPools({
      runtimeProfile: "public",
      sharedDatabaseUrl: null,
      contextDatabaseUrls: databaseUrls,
      port: 6183,
    });
    const firstRuntime = createPlatformApiHost({
      runtimeProfile: "public",
      pools,
      hostPorts: {
        processorGateway: createFakePaymentProcessorGateway(),
        listingPhotoStorage,
      },
    });
    const secondRuntime = createPlatformApiHost({
      runtimeProfile: "public",
      pools: secondPools,
      hostPorts: {
        processorGateway: createFakePaymentProcessorGateway(),
        listingPhotoStorage,
      },
    });
    const unlockBootstrap = await holdSchemaBootstrapAdvisoryLock(firstRuntime.mountedContexts[0]!.pool as never);
    const schemaBootstrap = {
      lockAcquisitionTimeoutMs: 120_000,
      lockTimeoutMs: 50,
      lockTimeoutRetryBudgetMs: 1_000,
      lockTimeoutRetryBaseDelayMs: 25,
      lockTimeoutRetryMaxDelayMs: 50,
      lockTimeoutRetryJitterMs: 0,
    } as const;
    const firstBootstrap = seedApiHostIfEmpty(apiContextRegistry, "platform-api", firstRuntime, {
      enabledDataProfiles: productionLikeDataProfiles,
      environmentName: "staging",
      runtimeProfile: "public",
      schemaBootstrap,
    });
    const secondBootstrap = seedApiHostIfEmpty(apiContextRegistry, "platform-api", secondRuntime, {
      enabledDataProfiles: productionLikeDataProfiles,
      environmentName: "staging",
      runtimeProfile: "public",
      schemaBootstrap,
    });

    try {
      await expect(hasSettledWithin(Promise.allSettled([firstBootstrap, secondBootstrap]), 100)).resolves.toBe(false);
      await unlockBootstrap();

      await expect(Promise.all([firstBootstrap, secondBootstrap])).resolves.toEqual([undefined, undefined]);
    } finally {
      await unlockBootstrap();
      await Promise.allSettled([firstBootstrap, secondBootstrap]);
      await closePlatformApiPools(secondPools);
    }

    const migrations = await pools.catalog.query<Readonly<{ migration_count: string }>>(
      `SELECT COUNT(*) AS migration_count FROM ${SCHEMA_MIGRATIONS_TABLE}`,
    );
    expect(Number(migrations.rows[0]?.migration_count ?? 0)).toBeGreaterThan(0);
  }, 240_000);

  it("limits and reconciles every production-like seed context against current-code state", async () => {
    const runtime = createPlatformApiHost({
      pools,
      hostPorts: {
        processorGateway: createFakePaymentProcessorGateway(),
        listingPhotoStorage,
      },
    });
    const bootstrapOptions = {
      enabledDataProfiles: productionLikeDataProfiles,
      environmentName: "staging",
    } as const;
    const reconciliationAttempts = new Map<string, number[]>();
    const productionSeedContextNames = runtime.mountedContexts
      .filter((context) => context.module.seed && seedProfilesOverlap(context.module.seedProfiles, bootstrapOptions))
      .map((context) => context.contextName);
    const probedRuntime = {
      ...runtime,
      mountedContexts: runtime.mountedContexts.map((context) => {
        const seed = context.module.seed;
        if (!seed || !productionSeedContextNames.includes(context.contextName)) {
          return context;
        }

        return {
          ...context,
          module: {
            ...context.module,
            seed: async (...args: Parameters<typeof seed>) => {
              const existingEvents = await context.pool.query<Readonly<{ count: string }>>(
                "SELECT COUNT(*) AS count FROM event_store_events",
              );
              const existingEventCount = Number(existingEvents.rows[0]?.count ?? 0);
              const attempts = reconciliationAttempts.get(context.contextName) ?? [];
              attempts.push(existingEventCount);
              reconciliationAttempts.set(context.contextName, attempts);
              await seed(...args);
            },
          },
        };
      }),
    } satisfies typeof runtime;

    expect(productionSeedContextNames.length).toBeGreaterThan(0);

    await expect(
      seedApiHostIfEmpty(apiContextRegistry, "platform-api", probedRuntime, bootstrapOptions),
    ).resolves.toBeUndefined();

    const identityAccounts = await pools.identity.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM identity_accounts",
    );
    const catalogItems = await pools.catalog.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM catalog_items",
    );
    const catalogBlueprintEvents = await pools.catalog.query<Readonly<{ count: string }>>(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE event_type = 'catalog.blueprint.created'`,
    );
    const activeCatalogDisplayTemplates = await pools.catalog.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM catalog_display_templates WHERE status = 'active'",
    );
    const publishedMarketplaceSalesFeeScheduleEvents = await pools["commercial-terms"].query<
      Readonly<{ count: string }>
    >(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE event_type = 'platform-policy.document.created'
         AND payload->>'policyKey' = 'commercial-terms.marketplace-sales-fee-schedule'`,
    );
    const commercialTermsAgreementEvents = await pools["commercial-terms"].query<Readonly<{ count: string }>>(
      `SELECT COUNT(*) AS count
       FROM event_store_events
       WHERE event_type IN ('commercial-terms.agreement.created', 'platform-policy.document.created')
         AND stream_id LIKE 'commercial-terms.agreement-%'`,
    );
    const marketplaceListings = await pools.marketplace.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM marketplace_listing_pages",
    );
    const reputationReviews = await pools.marketplace.query<Readonly<{ count: string }>>(
      "SELECT COUNT(*) AS count FROM marketplace_review_pages",
    );

    expect(Number(identityAccounts.rows[0]?.count ?? 0)).toBe(0);
    expect(Number(catalogItems.rows[0]?.count ?? 0)).toBe(0);
    expect(Number(catalogBlueprintEvents.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(activeCatalogDisplayTemplates.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    expect(Number(publishedMarketplaceSalesFeeScheduleEvents.rows[0]?.count ?? 0)).toBe(1);
    expect(Number(commercialTermsAgreementEvents.rows[0]?.count ?? 0)).toBe(0);
    expect(Number(marketplaceListings.rows[0]?.count ?? 0)).toBe(0);
    expect(Number(reputationReviews.rows[0]?.count ?? 0)).toBe(0);

    await drainContextRuntime(runtime);
    await expect(
      seedApiHostIfEmpty(apiContextRegistry, "platform-api", probedRuntime, bootstrapOptions),
    ).resolves.toBeUndefined();

    expect([...reconciliationAttempts.keys()].sort()).toEqual([...productionSeedContextNames].sort());
    for (const contextName of productionSeedContextNames) {
      const attempts = reconciliationAttempts.get(contextName);
      expect(attempts, `${contextName} should seed once and reconcile once`).toHaveLength(2);
      expect(attempts?.[0], `${contextName} first boot should start empty`).toBe(0);
      expect(attempts?.[1], `${contextName} second boot should traverse not-empty reconciliation`).toBeGreaterThan(0);
    }

    // Negative control: make the first production-like seed reject only when its context events
    // already exist. The same host-level second boot must surface that reconciliation-hostile
    // validation instead of silently skipping the context.
    const hostileContextName = productionSeedContextNames[0]!;
    let hostileExistingEventCount = 0;
    const hostileRuntime = {
      ...runtime,
      mountedContexts: runtime.mountedContexts.map((context) => {
        if (context.contextName !== hostileContextName || !context.module.seed) {
          return context;
        }

        return {
          ...context,
          module: {
            ...context.module,
            seed: async () => {
              const existingEvents = await context.pool.query<Readonly<{ count: string }>>(
                "SELECT COUNT(*) AS count FROM event_store_events",
              );
              hostileExistingEventCount = Number(existingEvents.rows[0]?.count ?? 0);
              if (hostileExistingEventCount > 0) {
                throw new Error(`test-only reconciliation-hostile validation: ${context.contextName}`);
              }
            },
          },
        };
      }),
    } satisfies typeof runtime;

    await expect(
      seedApiHostIfEmpty(apiContextRegistry, "platform-api", hostileRuntime, bootstrapOptions),
    ).rejects.toThrow(`test-only reconciliation-hostile validation: ${hostileContextName}`);
    expect(hostileExistingEventCount).toBeGreaterThan(0);
  }, 240_000);

  it("upgrades legacy published Display Templates through the not-empty Catalog reconciliation path", async () => {
    const runtime = createPlatformApiHost({
      pools,
      hostPorts: {
        processorGateway: createFakePaymentProcessorGateway(),
        listingPhotoStorage,
      },
    });
    const bootstrapOptions = {
      enabledDataProfiles: productionLikeDataProfiles,
      environmentName: "production",
    } as const;

    await seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, bootstrapOptions);
    await drainContextRuntime(runtime);

    // Recreate the long-lived production shape: both active card-scope Reference Types
    // predate additive seed attributes, while the active template projection still has
    // the old required-key set.
    const catalogServices = catalogModule.createServices(pools.catalog, {});
    const referenceTypes = await pools.catalog.query<
      Readonly<{
        reference_type_id: string;
        key: string;
        name_i18n: unknown;
        description_i18n: unknown;
        attribute_keys: string[];
      }>
    >(
      `SELECT reference_type_id, key, name_i18n, description_i18n, attribute_keys
       FROM catalog_reference_types
       WHERE key = ANY($1::text[])
       ORDER BY key`,
      [["expansion", "set"]],
    );
    const expansion = referenceTypes.rows.find((row) => row.key === "expansion")!;
    for (const referenceType of referenceTypes.rows) {
      await catalogServices.referenceData.referenceTypeCommandHandler({
        streamId: `catalog.reference-type-${referenceType.reference_type_id}`,
        command: {
          type: "ReviseReferenceType",
          key: referenceType.key,
          name: referenceType.name_i18n as never,
          description: referenceType.description_i18n as never,
          attributeKeys: [
            ...referenceType.attribute_keys.filter((key) => key !== "printed-card-count"),
            `operator-owned-${referenceType.key}-attribute`,
          ],
        },
        context: {
          tenantId: "tnt_bootstrap-legacy" as never,
          audit: {
            performedByUserId: "usr_bootstrap-legacy" as never,
            forAccountId: "acc_bootstrap-legacy" as never,
          },
        },
      });
    }
    await drainLocalProjectionHandlerSets("catalog", pools.catalog, catalogServices.referenceData.projectors);

    // Production deploy 29662384117 found this stream durably blocked by a May connection-timeout
    // poison event. Its new Expansion revision was deferred without an application-ledger row,
    // while the unblocked Set revision applied and the shared projector checkpoint advanced.
    const expansionStreamId = `catalog.reference-type-${expansion.reference_type_id}`;
    const firstExpansionEvent = await pools.catalog.query<
      Readonly<{ event_id: string; event_type: string; global_position: string; stream_version: string }>
    >(
      `SELECT event_id, event_type, global_position, stream_version
       FROM event_store_events
       WHERE stream_id = $1
       ORDER BY stream_version
       LIMIT 1`,
      [expansionStreamId],
    );
    const firstBlocked = firstExpansionEvent.rows[0]!;
    await pools.catalog.query(
      `UPDATE event_subscription_applications
       SET status = 'poison',
           error_message = 'timeout exceeded when trying to connect',
           updated_at = now()
       WHERE projection_key = $1
         AND event_id = $2`,
      ["catalog-reference-data-projection:catalog:v1", firstBlocked.event_id],
    );
    await pools.catalog.query(
      `INSERT INTO event_projection_poison_events (
         projection_key,
         event_id,
         projection_name,
         projection_kind,
         target_context_name,
         source_context_name,
         projection_revision,
         subscription_version,
         stream_id,
         stream_version,
         event_type,
         global_position,
         failure_kind,
         error_message,
         error_stack,
         state,
         retry_count,
         first_seen_at,
         last_seen_at,
         resolved_at
       ) VALUES ($1, $2, 'catalog-reference-data-projection', 'subscription', 'catalog', 'catalog',
                 NULL, 1, $3, $4::bigint, $5, $6::bigint, 'poison',
                 'timeout exceeded when trying to connect', NULL, 'blocked', 0, now(), now(), NULL)`,
      [
        "catalog-reference-data-projection:catalog:v1",
        firstBlocked.event_id,
        expansionStreamId,
        firstBlocked.stream_version,
        firstBlocked.event_type,
        firstBlocked.global_position,
      ],
    );
    await pools.catalog.query(
      `INSERT INTO event_projection_blocked_streams (
         projection_key,
         stream_id,
         first_blocked_global_position,
         first_blocked_stream_version,
         last_seen_global_position,
         deferred_event_count,
         state,
         updated_at
       ) VALUES ($1, $2, $3::bigint, $4::bigint, $3::bigint, 0, 'blocked', now())`,
      [
        "catalog-reference-data-projection:catalog:v1",
        expansionStreamId,
        firstBlocked.global_position,
        firstBlocked.stream_version,
      ],
    );

    await catalogServices.referenceData.referenceTypeCommandHandler({
      streamId: expansionStreamId,
      command: {
        type: "ReviseReferenceType",
        key: expansion.key,
        name: expansion.name_i18n as never,
        description: expansion.description_i18n as never,
        attributeKeys: [
          ...expansion.attribute_keys.filter((key) => key !== "printed-card-count"),
          "operator-owned-expansion-attribute",
          "deferred-operator-owned-attribute",
        ],
      },
      context: {
        tenantId: "tnt_bootstrap-deferred-operator" as never,
        audit: {
          performedByUserId: "usr_bootstrap-deferred-operator" as never,
          forAccountId: "acc_bootstrap-deferred-operator" as never,
        },
      },
    });
    await drainLocalProjectionHandlerSets("catalog", pools.catalog, catalogServices.referenceData.projectors);

    await pools.catalog.query(
      `UPDATE catalog_display_templates
       SET required_field_keys = $2::jsonb
       WHERE display_template_id = $1`,
      [
        catalogSeedIds.displayTemplates.pokemonSingleCardDefault,
        JSON.stringify(["card-name", "card-number", "expansion"]),
      ],
    );

    // Negative control: authoring remains fail-closed until bootstrap reconciles the seed-owned dependency.
    await expect(
      catalogServices.displayTemplates.commandHandler({
        streamId: `catalog.display-template-${catalogSeedIds.displayTemplates.pokemonSingleCardDefault}`,
        command: {
          type: "ReviseDisplayTemplate",
          key: "pokemon-single-card-default",
          name: { defaultLocale: "en", values: { en: "Pokemon single card" } },
          target: { kind: "blueprint", id: catalogSeedIds.blueprints.pokemonCardSingle },
          priority: 10,
          titleTemplate: "{field.card-name} {field.card-number}[/{reference.expansion.attributes.printed-card-count}]",
          subtitleTemplate: "{reference.expansion.name} [{field.card-variant} ]{field.rarity}",
        },
        context: {
          tenantId: "tnt_bootstrap-negative-control" as never,
          audit: {
            performedByUserId: "usr_bootstrap-negative-control" as never,
            forAccountId: "acc_bootstrap-negative-control" as never,
          },
        },
      }),
    ).rejects.toThrow("references undeclared attribute 'printed-card-count'");

    await expect(
      seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, bootstrapOptions),
    ).resolves.toBeUndefined();

    const reconciledReferenceTypes = await pools.catalog.query<Readonly<{ key: string; attribute_keys: string[] }>>(
      `SELECT key, attribute_keys
       FROM catalog_reference_types
       WHERE key = ANY($1::text[])
       ORDER BY key`,
      [["expansion", "set"]],
    );
    const activeTemplate = await pools.catalog.query<Readonly<{ required_field_keys: string[]; status: string }>>(
      `SELECT required_field_keys, status
       FROM catalog_display_templates
       WHERE display_template_id = $1`,
      [catalogSeedIds.displayTemplates.pokemonSingleCardDefault],
    );
    const recoveredProjectionFailure = await pools.catalog.query<Readonly<{ state: string }>>(
      `SELECT state
       FROM event_projection_poison_events
       WHERE projection_key = 'catalog-reference-data-projection:catalog:v1'
         AND stream_id = $1`,
      [expansionStreamId],
    );
    const recoveredBlockedStream = await pools.catalog.query<Readonly<{ state: string }>>(
      `SELECT state
       FROM event_projection_blocked_streams
       WHERE projection_key = 'catalog-reference-data-projection:catalog:v1'
         AND stream_id = $1`,
      [expansionStreamId],
    );

    expect(reconciledReferenceTypes.rows).toHaveLength(2);
    for (const referenceType of reconciledReferenceTypes.rows) {
      expect(referenceType.attribute_keys).toContain("printed-card-count");
      expect(referenceType.attribute_keys).toContain(`operator-owned-${referenceType.key}-attribute`);
    }
    expect(reconciledReferenceTypes.rows.find((row) => row.key === "expansion")?.attribute_keys).toContain(
      "deferred-operator-owned-attribute",
    );
    expect(recoveredProjectionFailure.rows[0]?.state).toBe("resolved");
    expect(recoveredBlockedStream.rows[0]?.state).toBe("resolved");
    expect(activeTemplate.rows[0]).toEqual({
      required_field_keys: ["card-name", "card-number", "expansion", "rarity"],
      status: "active",
    });
  }, 240_000);

  it("proves the reviewed projection guard fails at User, then resumes a full retained Identity seed", async () => {
    const runtime = createIdentitySeedHost(pools);
    const identityContext = runtime.mountedContexts[0];
    if (!identityContext) {
      throw new Error("Expected the focused Identity host composition to mount Identity.");
    }

    await runRepresentativeIdentitySeed(runtime);
    const retainedCounts = await countRepresentativeIdentityCreationEvents(pools.identity);
    expect(retainedCounts).toEqual({
      "identity.account.created": 5,
      "identity.user.created": 5,
      "identity.membership.granted": 5,
      "identity.consent.recorded": 5,
      "identity.shipping-address.added": 5,
    });
    const projectedUser = await pools.identity.query("SELECT user_id FROM identity_users WHERE user_id = $1", [
      retainedRepresentativeAccount.userId,
    ]);
    expect(projectedUser.rows).toHaveLength(0);

    const identityServices = runtime.services.identity as ReturnType<typeof identityModule.createServices>;
    await expect(
      identityServices.users.commandHandler({
        streamId: `identity.user-${retainedRepresentativeAccount.userId}`,
        command: {
          type: "CreateUser",
          userId: retainedRepresentativeAccount.userId as never,
          displayName: retainedRepresentativeAccount.name,
          primaryEmail: retainedRepresentativeAccount.primaryEmail,
          givenName: retainedRepresentativeAccount.givenName,
          familyName: retainedRepresentativeAccount.familyName,
          primaryContactMethod: {
            contactMethodId: retainedRepresentativeAccount.contactMethodId,
            type: "email",
            value: retainedRepresentativeAccount.primaryEmail,
            verifiedAt: "2026-05-27T00:00:00.000Z",
          },
        },
        context: {
          tenantId: "tnt_identity",
          audit: {
            performedByUserId: "usr_identity_bootstrap",
            forAccountId: "acc_identity_bootstrap",
          },
          trace: {},
        } as never,
      }),
    ).rejects.toThrow("User has already been created.");

    await expect(runRepresentativeIdentitySeed(runtime)).resolves.toBeUndefined();

    expect(await countRepresentativeIdentityCreationEvents(pools.identity)).toEqual(retainedCounts);
  }, 120_000);

  it("keeps every representative Identity creation event count stable on an ordinary day-after bootstrap", async () => {
    const runtime = createIdentitySeedHost(pools);
    const identityContext = runtime.mountedContexts[0];
    if (!identityContext) {
      throw new Error("Expected the focused Identity host composition to mount Identity.");
    }

    await expect(runRepresentativeIdentitySeed(runtime)).resolves.toBeUndefined();
    const firstRunCounts = await countRepresentativeIdentityCreationEvents(pools.identity);
    expect(Object.values(firstRunCounts)).toEqual([5, 5, 5, 5, 5]);

    await drainLocalProjectionHandlerSets(
      identityContext.contextName,
      identityContext.pool,
      identityContext.projectionHandlerSets,
    );
    await expect(runRepresentativeIdentitySeed(runtime)).resolves.toBeUndefined();

    expect(await countRepresentativeIdentityCreationEvents(pools.identity)).toEqual(firstRunCounts);
  }, 120_000);

  it("rejects a conflicting retained representative Account profile with actionable detail", async () => {
    const runtime = createIdentitySeedHost(pools);
    await bootstrapContextDatabase(identityModule, pools.identity);
    await appendRepresentativeAccountCreatedEvent(runtime, {
      ...retainedRepresentativeAccount,
      displayName: "Conflicting Collector",
    });

    const conflict = await runRepresentativeIdentitySeed(runtime).then(
      () => null,
      (error: unknown) => error,
    );
    expect(conflict).toBeInstanceOf(Error);
    expect((conflict as Error).message).toContain(
      `Representative Identity Account conflict for '${retainedRepresentativeAccount.accountId}': existing committed profile`,
    );
    expect((conflict as Error).message).toContain(
      `"displayName":"Conflicting Collector"} does not match requested deterministic profile`,
    );
    expect(await countRepresentativeAccountCreatedEvents(pools.identity, retainedRepresentativeAccount.accountId)).toBe(
      1,
    );
  }, 120_000);

  it("rejects a conflicting retained representative User profile with actionable detail", async () => {
    const runtime = createIdentitySeedHost(pools);
    await runRepresentativeIdentitySeed(runtime);
    const identityServices = runtime.services.identity as ReturnType<typeof identityModule.createServices>;
    const beforeCounts = await countRepresentativeIdentityCreationEvents(pools.identity);

    await identityServices.users.commandHandler({
      streamId: `identity.user-${retainedRepresentativeAccount.userId}`,
      command: {
        type: "UpdateUserProfile",
        displayName: "Conflicting Collector",
        givenName: retainedRepresentativeAccount.givenName,
        familyName: retainedRepresentativeAccount.familyName,
      },
      context: {
        tenantId: "tnt_identity",
        audit: {
          performedByUserId: "usr_identity_bootstrap",
          forAccountId: "acc_identity_bootstrap",
        },
        trace: {},
      } as never,
    });

    const conflict = await runRepresentativeIdentitySeed(runtime).then(
      () => null,
      (error: unknown) => error,
    );
    expect(conflict).toBeInstanceOf(Error);
    expect((conflict as Error).message).toContain(
      `Representative Identity User conflict for '${retainedRepresentativeAccount.userId}': existing committed profile`,
    );
    expect((conflict as Error).message).toContain(`"displayName":"Conflicting Collector"`);
    expect((conflict as Error).message).toContain("does not match requested deterministic profile");
    expect((conflict as Error).message).toContain(
      "Resolve the conflicting User stream before resuming representative seeding.",
    );
    expect(await countRepresentativeIdentityCreationEvents(pools.identity)).toEqual(beforeCounts);
  }, 120_000);

  it("rejects a conflicting retained representative Shipping Address profile with actionable detail", async () => {
    const runtime = createIdentitySeedHost(pools);
    await runRepresentativeIdentitySeed(runtime);
    const identityServices = runtime.services.identity as ReturnType<typeof identityModule.createServices>;
    const beforeCounts = await countRepresentativeIdentityCreationEvents(pools.identity);
    const addressBook = await identityServices.shippingAddresses.getShippingAddressBookState(
      retainedRepresentativeAccount.accountId,
    );
    const existing = addressBook?.addresses.find(
      (address) => address.shippingAddressId === retainedRepresentativeAccount.shippingAddressId,
    );
    if (!existing) {
      throw new Error("Expected the retained representative Shipping Address.");
    }

    await identityServices.shippingAddresses.commandHandler({
      streamId: `identity.shipping-address-book-${retainedRepresentativeAccount.accountId}`,
      command: {
        type: "UpdateShippingAddress",
        shippingAddressId: retainedRepresentativeAccount.shippingAddressId as never,
        label: existing.label,
        address: {
          name: existing.name,
          company: existing.company,
          line1: "999 Conflicting Address",
          line2: existing.line2,
          city: existing.city,
          state: existing.state,
          postalCode: existing.postalCode,
          country: existing.country,
          phone: existing.phone,
          email: existing.email,
          verification: existing.verification,
        },
        makeDefault: true,
        updatedAt: "2026-05-28T00:00:00.000Z",
      },
      context: {
        tenantId: "tnt_identity",
        audit: {
          performedByUserId: "usr_identity_bootstrap",
          forAccountId: "acc_identity_bootstrap",
        },
        trace: {},
      } as never,
    });

    const conflict = await runRepresentativeIdentitySeed(runtime).then(
      () => null,
      (error: unknown) => error,
    );
    expect(conflict).toBeInstanceOf(Error);
    expect((conflict as Error).message).toContain(
      `Representative Identity Shipping Address conflict for '${retainedRepresentativeAccount.shippingAddressId}': existing committed profile`,
    );
    expect((conflict as Error).message).toContain(`"line1":"999 Conflicting Address"`);
    expect((conflict as Error).message).toContain("does not match requested deterministic profile");
    expect((conflict as Error).message).toContain(
      "Resolve the conflicting Shipping Address stream before resuming representative seeding.",
    );
    expect(await countRepresentativeIdentityCreationEvents(pools.identity)).toEqual(beforeCounts);
  }, 120_000);

  it("resumes the real representative commerce command after offer acceptance without duplicate creation events", async () => {
    const runtime = createPlatformApiHost({
      runtimeProfile: "public",
      pools,
      hostPorts: {
        processorGateway: createFakePaymentProcessorGateway(),
        listingPhotoStorage,
      },
    });
    const commandOptions = {
      pools,
      runtime,
      execution: {
        deploymentEnvironment: "test",
        confirmation: "seed staging commerce",
      },
      evidenceOutPath: null,
      async afterStepCompleted(stepName: string) {
        if (stepName === "seed data profiles") {
          const catalogContext = runtime.mountedContexts.find((context) => context.contextName === "catalog");
          if (!catalogContext) {
            throw new Error("Expected the representative commerce test host to mount Catalog.");
          }
          await drainLocalProjectionHandlerSets(
            catalogContext.contextName,
            catalogContext.pool,
            catalogContext.projectionHandlerSets,
          );
        }
        if (stepName === "sync catalog.catalog-item-projection") {
          await ensureRepresentativeProductContentsTestMeasureProfile(runtime);
        }
      },
    } as const;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expect(
        runRepresentativeCommerceState({
          ...commandOptions,
          async afterStepCompleted(stepName) {
            await commandOptions.afterStepCompleted(stepName);
            if (stepName === "accept representative offers") {
              throw new Error("intentional representative commerce interruption");
            }
          },
        }),
      ).rejects.toThrow("intentional representative commerce interruption");

      const failureDiagnostic = errorLog.mock.calls
        .map(([message]) => {
          try {
            return JSON.parse(String(message)) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .find((entry) => entry?.type === "representative-commerce-state.failed");
      expect(failureDiagnostic).toMatchObject({
        lastCompletedStep: "accept representative offers",
        failedStep: null,
        error: "intentional representative commerce interruption",
      });
      expect(String(failureDiagnostic?.operatorGuidance)).toContain("Resume this command unchanged once.");
      expect(String(failureDiagnostic?.operatorGuidance)).toContain("do not loop retries");
    } finally {
      errorLog.mockRestore();
    }

    const retainedIdentityEvents = await countRepresentativeIdentityCreationEvents(pools.identity);
    const retainedListings = await countCreationEvents(pools.marketplace, "marketplace.listing.created");
    const retainedOffers = await countCreationEvents(pools.marketplace, "marketplace.offer.submitted");
    const retainedParticipants = await representativeParticipantIdentities(pools);
    expect(Object.values(retainedIdentityEvents)).toEqual([5, 5, 5, 5, 5]);
    expect(retainedListings.eventCount).toBeGreaterThan(0);
    expect(retainedListings.eventCount).toBe(retainedListings.streamCount);
    expect(retainedOffers.eventCount).toBeGreaterThan(0);
    expect(retainedOffers.eventCount).toBe(retainedOffers.streamCount);
    expect(retainedParticipants.sellerAccountIds.length).toBeGreaterThan(0);
    expect(retainedParticipants.buyerAccountIds.length).toBeGreaterThan(0);

    await expect(runRepresentativeCommerceState(commandOptions)).resolves.toBeUndefined();

    const completedOrders = await countCreationEvents(pools.ordering, "ordering.order.created");
    expect(completedOrders.eventCount).toBeGreaterThan(0);
    expect(completedOrders.eventCount).toBe(retainedOffers.eventCount);
    expect(completedOrders.eventCount).toBe(completedOrders.streamCount);
    expect(await countRepresentativeIdentityCreationEvents(pools.identity)).toEqual(retainedIdentityEvents);
    expect(await countCreationEvents(pools.marketplace, "marketplace.listing.created")).toEqual(retainedListings);
    expect(await countCreationEvents(pools.marketplace, "marketplace.offer.submitted")).toEqual(retainedOffers);
    expect(await representativeParticipantIdentities(pools)).toEqual(retainedParticipants);

    const cohort = await pools.marketplace.query<Readonly<{ catalog_item_id: string }>>(
      `SELECT DISTINCT catalog_catalog_item_id AS catalog_item_id
       FROM marketplace_listing_pages
       WHERE listing_id LIKE 'lst$_repr$_%' ESCAPE '$'
         AND catalog_catalog_item_id = ANY($1::text[])`,
      [representativeProductContentsScenario.requiredCatalogItemIds],
    );
    expect(
      cohort.rows.length / representativeProductContentsScenario.requiredCatalogItemIds.length,
    ).toBeGreaterThanOrEqual(0.9);

    await expect(runRepresentativeCommerceState(commandOptions)).resolves.toBeUndefined();
    expect(await countRepresentativeIdentityCreationEvents(pools.identity)).toEqual(retainedIdentityEvents);
    expect(await countCreationEvents(pools.marketplace, "marketplace.listing.created")).toEqual(retainedListings);
    expect(await countCreationEvents(pools.marketplace, "marketplace.offer.submitted")).toEqual(retainedOffers);
    expect(await countCreationEvents(pools.ordering, "ordering.order.created")).toEqual(completedOrders);
    expect(await representativeParticipantIdentities(pools)).toEqual(retainedParticipants);
  }, 300_000);
});
