import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// Register owner-local omission mocks before loading host/context modules.
import {
  authWriterProbe,
  upsertSessionToken,
  seedSessionToken,
  revokeSession,
  createAuthSessionEpochs,
} from "@chase-sets/auth/test-support";
import { identityWriterProbe, createIdentityOwnerEpochs } from "@chase-sets/identity/test-support";
import { inventoryWriterProbe, reserveOrderInventoryRequest } from "@chase-sets/inventory/test-support";
import {
  connectionWriterProbe,
  createConnectionPersistence,
  createConnectionEpochsForWitness,
  disconnectChannelConnectionForWitness,
} from "@chase-sets/channels/test-support";
import type { AppendToStreamInput } from "@chase-sets/event-core/storage";
import type { PgTransactionalPool, PgQueryable } from "@chase-sets/event-core-postgres";
import {
  bootstrapContextDatabase,
  drainContextRuntime,
  resolveModuleSubscriptions,
} from "@chase-sets/bounded-context-runtime";
import {
  createMultiContextTestDatabaseUrls,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { getApiHostContextNames } from "@chase-sets/platform-runtime/api";
import { module as authModule } from "@chase-sets/auth";
import { module as channelsModule } from "@chase-sets/channels";
import { module as catalogModule } from "@chase-sets/catalog";
import { module as pricingModule } from "@chase-sets/pricing";
import type { PricingServices } from "@chase-sets/pricing/server";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import { Hono } from "hono";
import type { ChannelsServices } from "@chase-sets/channels/server";
import { module as identityModule } from "@chase-sets/identity";
import type { IdentityServices } from "@chase-sets/identity/server";
import { module as inventoryModule } from "@chase-sets/inventory";
import {
  createInventoryStockAuthorityForPool,
  inventoryMutationAttemptFromSource,
  withInventoryMutationAttempt,
  type InventoryServices,
} from "@chase-sets/inventory/server";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import type {
  MarketplaceServices,
  AcceptListingTargetPriceInput,
  ListingPhotoStorage,
} from "@chase-sets/marketplace/server";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createId } from "@chase-sets/primitives/typed-ids";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { buildPlatformApiApp, createPlatformApiHost } from "../src/app";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";
import { apiContextRegistry } from "../src/context-registry";

type PlatformApiTestPools = ReturnType<typeof createPlatformApiPools>;
const listingPhotoStorage: ListingPhotoStorage = {
  async getObject() {
    return null;
  },
  async putObject(input) {
    return { key: input.key, publicUrl: `https://assets.test/${input.key}` };
  },
};

const appendProbe = vi.hoisted(() => ({
  before: undefined as ((inputs: readonly AppendToStreamInput[]) => Promise<void>) | undefined,
  beforeCommit: undefined as (() => Promise<void>) | undefined,
  commitProbeError: undefined as unknown,
  validationNow: undefined as string | undefined,
  loseReply: false,
  targetInFlight: false,
  mutant: "none" as "none" | "shared-lock" | "closed-through-wait" | "abort-cas",
  unavailable: false,
  omit: "none" as "none" | "identity" | "auth" | "channels" | "inventory",
}));

identityWriterProbe.omit = () => appendProbe.omit === "identity";
authWriterProbe.omit = () => appendProbe.omit === "auth";
connectionWriterProbe.omit = () => appendProbe.omit === "channels";
inventoryWriterProbe.omit = () => appendProbe.omit === "inventory";
connectionWriterProbe.setupResolver = async ({ providerKey, environment }) =>
  providerKey === "synthetic-provider"
    ? {
        providerKey,
        environment,
        requirements: { credential: "not-required", requiredPolicyKeys: [], binding: "one-or-more-current" },
      }
    : null;

function observedPool(pool: PgTransactionalPool): PgTransactionalPool {
  return {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      const query: PgQueryable["query"] = async <Row = Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[],
      ) => {
        if (appendProbe.unavailable && sql.includes("SELECT binding, status FROM event_request_terminals"))
          throw new Error("synthetic consumer unavailable");
        if (
          appendProbe.mutant === "abort-cas" &&
          sql.includes("UPDATE event_request_terminals") &&
          values?.[2] === "ABORTED"
        )
          return { rows: [], rowCount: 0 };
        if (
          appendProbe.mutant === "closed-through-wait" &&
          sql.includes("pg_advisory_xact_lock(hashtextextended('configuration_epoch:'")
        )
          return { rows: [], rowCount: 0 };
        if (sql === "COMMIT" && appendProbe.targetInFlight && appendProbe.beforeCommit) {
          const before = appendProbe.beforeCommit;
          appendProbe.beforeCommit = undefined;
          try {
            await before();
          } catch (error) {
            appendProbe.commitProbeError = error;
            throw error;
          }
        }
        const result = await client.query<Row>(sql, values);
        if (appendProbe.validationNow && appendProbe.targetInFlight && sql.includes("clock_timestamp()::text AS now"))
          return { ...result, rows: result.rows.map((row) => ({ ...row, now: appendProbe.validationNow })) };
        return result;
      };
      return { query, release: client.release.bind(client) };
    },
  };
}

vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chase-sets/event-core-postgres")>();
  const create: typeof actual.createPostgresEventStore = (...args) => {
    const store = actual.createPostgresEventStore(...args);
    return {
      ...store,
      async appendToStreams(inputs) {
        const targetCommand = inputs.some((input) =>
          input.events.some((event) =>
            ["marketplace.listing.target-price-accepted", "marketplace.listing.channel-activated"].includes(
              event.eventType,
            ),
          ),
        );
        if (targetCommand && appendProbe.before) {
          const before = appendProbe.before;
          appendProbe.before = undefined;
          await before(inputs);
        }
        if (!store.appendToStreams) throw new Error("Atomic append is unavailable.");
        appendProbe.targetInFlight = targetCommand;
        if (targetCommand) appendProbe.commitProbeError = undefined;
        let result;
        try {
          result = await store.appendToStreams(
            appendProbe.mutant === "shared-lock"
              ? inputs.map((input) => ({ ...input, configurationGrants: undefined }))
              : inputs,
          );
        } catch (error) {
          // The adapter has rolled back; preserve a probe assertion hidden by error normalization.
          throw targetCommand && appendProbe.commitProbeError ? appendProbe.commitProbeError : error;
        } finally {
          appendProbe.targetInFlight = false;
        }
        if (targetCommand && appendProbe.loseReply) {
          appendProbe.loseReply = false;
          throw new Error("synthetic lost committed reply");
        }
        return result;
      },
    };
  };
  return { ...actual, createPostgresEventStore: create };
});

describe("listing channel activation real composition", () => {
  let pools: PlatformApiTestPools;
  const activeContextNames = [
    "auth",
    "identity",
    "channels",
    "inventory",
    "marketplace",
    "catalog",
    "pricing",
  ] as const;
  beforeAll(async () => {
    const databaseBaseUrl = process.env.TEST_DATABASE_URL;
    if (!databaseBaseUrl) throw new Error("TEST_DATABASE_URL is required for listing composition DB proofs.");
    const databaseUrls = createMultiContextTestDatabaseUrls(
      databaseBaseUrl,
      getApiHostContextNames(apiContextRegistry, "platform-api"),
      "listing_channel_activation_10410",
    );
    await ensureMultiContextTestDatabases(
      databaseBaseUrl,
      Object.fromEntries(activeContextNames.map((name) => [name, databaseUrls[name]])),
    );
    pools = createPlatformApiPools({
      runtimeProfile: "public",
      sharedDatabaseUrl: null,
      contextDatabaseUrls: databaseUrls,
      port: 6182,
    });
  });
  // This fixture initializes owner schemas, not the host's seed bootstrap.
  beforeEach(async () => {
    await resetMultiContextTestSchemas(Object.fromEntries(activeContextNames.map((name) => [name, pools[name]])));
  }, 30_000);
  afterAll(async () => {
    if (pools) await closePlatformApiPools(pools);
  });
  beforeEach(async () => {
    appendProbe.before = undefined;
    appendProbe.beforeCommit = undefined;
    appendProbe.commitProbeError = undefined;
    appendProbe.validationNow = undefined;
    appendProbe.loseReply = false;
    appendProbe.targetInFlight = false;
    appendProbe.mutant = "none";
    appendProbe.omit = "none";
    appendProbe.unavailable = false;
    for (const [module, pool] of [
      [authModule, pools.auth],
      [identityModule, pools.identity],
      [channelsModule, pools.channels],
      [inventoryModule, pools.inventory],
      [marketplaceModule, pools.marketplace],
    ] as const)
      await bootstrapContextDatabase(module, pool);
  });
  afterEach(() => vi.restoreAllMocks());

  function host() {
    return createPlatformApiHost({
      pools: { ...pools, marketplace: observedPool(pools.marketplace) },
      hostPorts: {
        capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
        processorGateway: createFakePaymentProcessorGateway(),
        listingPhotoStorage,
      },
    });
  }

  function hostWithoutPricingEvaluation() {
    const createServices = pricingModule.createServices;
    const omit = vi.spyOn(pricingModule, "createServices").mockImplementationOnce((pool, ports) => {
      const { pricingEvaluationOwners: _omitted, ...remaining } = ports;
      return createServices(pool, remaining);
    });
    try {
      const runtime = host();
      expect(omit).toHaveBeenCalledOnce();
      expect((runtime.services.pricing as PricingServices).evaluationAuthority).toBeUndefined();
      return runtime;
    } finally {
      omit.mockRestore();
    }
  }

  async function fixture(runtime = hostWithoutPricingEvaluation()) {
    await runtime.initializeListingAuthority();
    const identity = runtime.services.identity as IdentityServices;
    const auth = runtime.services.auth as ReturnType<typeof authModule.createServices>;
    const inventory = runtime.services.inventory as InventoryServices;
    const channels = runtime.services.channels as ChannelsServices;
    const listings = (runtime.services.marketplace as MarketplaceServices).listings;
    const accountId = createId("acc"),
      userId = createId("usr"),
      membershipId = createId("mbr");
    const sessionId = createId("ses"),
      catalogItemId = createId("cat"),
      itemId = createId("inv"),
      locationId = createId("loc");
    const connectionId = `synthetic-${accountId}`;
    const context = { tenantId: createId("tnt"), audit: { performedByUserId: userId, forAccountId: accountId } };
    const principal = { userId, membershipId, sessionId, tokenHash: `synthetic-session-token-hash-${sessionId}` };
    const expiresAt = "2099-01-01T00:00:00.000Z";
    const address = {
      name: "Synthetic",
      company: null,
      line1: "1 Main St",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: null,
      email: null,
    };
    await identity.accounts.commandHandler({
      streamId: `identity.account-${accountId}`,
      context,
      command: { type: "CreateAccount", accountId, name: "Synthetic", accountType: "personal" },
    });
    await identity.users.commandHandler({
      streamId: `identity.user-${userId}`,
      context,
      command: { type: "CreateUser", userId, displayName: "Synthetic", primaryEmail: "synthetic@example.test" },
    });
    await identity.memberships.commandHandler({
      streamId: `identity.membership-${membershipId}`,
      context,
      command: {
        type: "GrantMembership",
        membershipId,
        userId,
        accountId,
        roleKey: "manager",
        assignmentAuthority: { type: "system" },
      },
    });
    await auth.sessions.commandHandler({
      streamId: `auth.session-${sessionId}`,
      context,
      command: {
        type: "StartSession",
        sessionId,
        userId,
        accountId,
        availableAccountIds: [accountId, "acc_synthetic_second"],
        authenticationMethod: "password",
        expiresAt,
      },
    });
    // A pre-enrollment SQL token exercises the landed legacy-token admission path.
    await pools.auth.query("INSERT INTO identity_session_tokens (session_id,token_hash,expires_at) VALUES ($1,$2,$3)", [
      sessionId,
      principal.tokenHash,
      expiresAt,
    ]);
    await inventory.storageLocations.commandHandler({
      streamId: `inventory.storage-location-${locationId}`,
      context,
      command: {
        type: "CreateStorageLocation",
        storageLocationId: locationId,
        accountId,
        name: "Synthetic",
        shipFromCode: "60601",
        shipFromAddress: address,
      },
    });
    await inventory.items.commandHandler({
      streamId: `inventory.item-${itemId}`,
      context,
      command: {
        type: "CreateInventoryItem",
        itemId,
        accountId,
        catalogItemId,
        productId: `${catalogItemId}::`,
        selectedOptions: [],
        storageLocationId: locationId,
        totalQuantity: 10,
        acquisitionOccurrence: { kind: "unknown" },
        commandOccurredAt: new Date().toISOString(),
      },
    });
    await inventory.channelStockAllocations.set(
      { accountId, inventoryItemId: itemId, mode: "shared-pool", partitions: [], expectedRevision: 0 },
      context,
    );
    await channels.connections.connectChannel(
      { accountId, connectionId, providerKey: "synthetic-provider" },
      { deploymentEnvironment: "local" },
      context,
    );
    await channels.connections.activateChannelConnection(
      {
        accountId,
        connectionId,
        credentialReference: null,
        bindings: [{ storageLocationId: locationId, revision: 1 }],
      },
      context,
    );
    const created = await listings.createListingFromInventorySnapshot(
      {
        accountId,
        inventoryItemId: itemId,
        catalogItemId,
        productId: `${catalogItemId}::`,
        selectedOptions: [],
        storageLocationId: locationId,
        storageLocationName: "Synthetic",
        shipFromCode: "60601",
        shipFromAddress: address,
        totalQuantity: 10,
        availableQuantity: 10,
        acquisitionCostAmount: null,
        priceAmount: "10.00",
        priceCurrencyCode: "USD",
        quantityCap: 1,
        publicationScope: "channel-only",
        idempotencyKey: "synthetic-listing-create-attempt",
      },
      context,
    );
    const accept: AcceptListingTargetPriceInput = {
      accountId,
      listingId: created.listingId,
      expectedListingVersion: created.version,
      expectedTargetPriceRevision: 0,
      target: { kind: "channel-connection", connectionId },
      priceAmount: "12.00",
      priceCurrencyCode: "USD",
      decision: { kind: "seller-reference" },
      idempotencyKey: "synthetic-accept",
    };
    const store = createPostgresEventStore({ pool: pools.marketplace });
    const businessEvents = async () =>
      (await store.readAll({ limit: 100 })).filter((event) => event.streamId.startsWith("marketplace.listing-"));
    return {
      runtime,
      identity,
      auth,
      inventory,
      channels,
      listings,
      principal,
      context,
      accept,
      businessEvents,
      connectionId,
      itemId,
      locationId,
      catalogItemId,
      accountId,
      holdId: createId("hld"),
      store,
    };
  }

  async function pricingFixture(categoryScoped = false) {
    await bootstrapContextDatabase(catalogModule, pools.catalog);
    await bootstrapContextDatabase(pricingModule, pools.pricing);
    const f = await fixture(host());
    const pricing = f.runtime.services.pricing as PricingServices;
    const catalog = f.runtime.services.catalog as ReturnType<typeof catalogModule.createServices>;
    const streamId = `catalog.item-${f.catalogItemId}`;
    const categories = [createId("ctg"), createId("ctg")] as const;
    const app = new Hono<AuthenticatedApiEnv>();
    app.use("*", async (c, next) => {
      c.set("context", f.context);
      c.set("actor", {
        ...f.principal,
        accountId: f.accountId,
        tenantId: f.context.tenantId,
        roleKey: "manager",
        permissions: ["catalog.manage", "listings.manage"],
      });
      await next();
    });
    const categoryRoutes = catalogModule.buildApis!(catalog)[0]!.router;
    if (!(categoryRoutes instanceof Hono)) throw new Error("Catalog route was not mounted.");
    app.route("/", categoryRoutes);
    const category = (method: "POST" | "DELETE", categoryId: string) =>
      app.request(`/items/${f.catalogItemId}/categories/${categoryId}`, { method });
    await catalog.items.commandHandler({
      streamId,
      context: f.context,
      command: {
        type: "CreateCatalogItem",
        itemId: f.catalogItemId,
        title: { defaultLocale: "en", values: { en: "Synthetic exact Pricing item" } },
      },
    });
    if (categoryScoped) for (const key of categories) expect((await category("POST", key)).status).toBe(201);
    const run = await pricing.repricingEngine.enqueueDryRun(
      {
        sellerAccountId: f.accountId,
        body: {
          scope: categoryScoped ? { kind: "catalog-filter", categoryIds: categories } : { kind: "all-listings" },
          excludedListingIds: [],
          maxChangesPerDay: 3,
          rules: [
            {
              conditions: [],
              directive: {
                currencyCode: "USD",
                anchorChain: [{ source: "market-estimate" }],
                offset: { mode: "absolute", amount: "0.00" },
                floor: { mode: "absolute", amount: "1.00" },
                ceiling: null,
                tolerance: { mode: "absolute", amount: "0.01" },
                rounding: { mode: "none" },
                maxMovePercent: null,
                terminal: { kind: "fallback-price", amount: f.accept.priceAmount },
              },
            },
          ],
        },
      },
      f.context,
    );
    expect(
      await pricing.repricingEngine.processNextDryRunJob({ claimOwnerId: "synthetic-pricing", claimTtlMs: 30_000 }),
    ).toBe(1);
    const installed = await pricing.repricingPolicies.activateRepricingPolicy(
      {
        accountId: f.accountId,
        dryRunId: run!.dryRunId,
        name: "Synthetic exact Pricing policy",
      },
      f.context,
    );
    expect(installed?.status).toBe("applied");
    expect((await pools.pricing.query("SELECT 1 FROM pricing_evaluated_decisions")).rows).toHaveLength(0);
    expect((await pools.pricing.query("SELECT 1 FROM pricing_repricing_daily_change_budgets")).rows).toHaveLength(0);
    const acceptance: AcceptListingTargetPriceInput = {
      ...f.accept,
      decision: {
        kind: "pricing-evaluation",
        evaluationId: "evd_synthetic_host",
        evaluationRevision: "1",
        basePriceRevision: 1,
        standingAuthorizationId: `repricing-account/${f.accountId}`,
        standingAuthorizationRevision: "1",
      },
    };
    const accept = (command = acceptance) => f.listings.acceptListingTargetPrice(command, f.context, f.principal);
    const latestTerminal = async () =>
      (
        await pools.marketplace.query<{ status: string }>(
          "SELECT status FROM event_request_terminals ORDER BY created_at DESC LIMIT 1",
        )
      ).rows[0]?.status;
    return { ...f, pricing, categories, category, acceptance, acceptPricing: accept, latestTerminal };
  }

  it("composes the real owner ports and committed target routes", () => {
    const runtime = host();
    const listings = (runtime.services.marketplace as MarketplaceServices).listings;
    expect(typeof listings.acceptListingTargetPrice).toBe("function");
    expect(typeof listings.activateListingForChannel).toBe("function");
    expect(typeof listings.readAcceptedListingTargetPrices).toBe("function");
    expect(buildPlatformApiApp(runtime)).toBeDefined();
  });

  it("fails closed before a missing listing can produce a business event", async () => {
    const f = await fixture();
    const before = await f.businessEvents();
    await expect(
      f.listings.activateListingForChannel(
        {
          accountId: f.accept.accountId,
          listingId: createId("lst"),
          connectionId: f.connectionId,
          expectedListingVersion: 1,
          expectedTargetPriceRevision: 1,
          allocationRevision: 1,
          idempotencyKey: "missing-listing",
        },
        f.context,
        f.principal,
      ),
    ).rejects.toThrow();
    expect(await f.businessEvents()).toEqual(before);
  });

  it("case 1: class C grants and class M original-terminal CAS commit acceptance then activation", async () => {
    const f = await fixture();
    const accepted = await f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal);
    const activated = await f.listings.activateListingForChannel(
      {
        accountId: f.accept.accountId,
        listingId: f.accept.listingId,
        connectionId: f.connectionId,
        expectedListingVersion: accepted.version,
        expectedTargetPriceRevision: 1,
        allocationRevision: 1,
        idempotencyKey: "synthetic-activate",
      },
      f.context,
      f.principal,
    );
    expect(activated.state).toMatchObject({
      status: "active",
      nativeVisibility: "disabled",
      nativeFeeState: "not-enrolled",
      feeLocks: [],
    });
    const events = await f.businessEvents();
    expect(events.filter((event) => event.eventType === "marketplace.listing-request.completed")).toHaveLength(2);
    expect(events.map((event) => event.eventType)).not.toContain("marketplace.listing.published");
    expect(events.map((event) => event.eventType)).not.toContain("marketplace.listing.price-updated");
    expect(
      await f.listings.readAcceptedListingTargetPrices({
        accountId: f.accept.accountId,
        targets: [{ listingId: f.accept.listingId, target: f.accept.target }],
      }),
    ).toMatchObject([{ acceptedTargetPrice: accepted.acceptedTargetPrice, activationRevision: 1 }]);
    await revokeSession(f.auth, { sessionId: f.principal.sessionId, context: f.context });
    expect(await f.listings.activateListingForChannel(activation(f, accepted.version), f.context, f.principal)).toEqual(
      activated,
    );
    await expect(
      f.listings.activateListingForChannel(
        { ...activation(f, accepted.version), allocationRevision: 2 },
        f.context,
        f.principal,
      ),
    ).rejects.toThrow("different command");
    expect(await f.businessEvents()).toEqual(events);
  });

  it("case 2: class C committed request replay survives lost reply and authority loss; changed command conflicts", async () => {
    const f = await fixture();
    appendProbe.loseReply = true;
    const original = await f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal);
    await f.auth.sessions.commandHandler({
      streamId: `auth.session-${f.principal.sessionId}`,
      context: f.context,
      command: { type: "RevokeSession" },
    });
    expect(await f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal)).toEqual(original);
    await expect(
      f.listings.acceptListingTargetPrice({ ...f.accept, priceCurrencyCode: "EUR" }, f.context, f.principal),
    ).rejects.toThrow("different command");
    expect(
      (await f.businessEvents()).filter((event) => event.eventType === "marketplace.listing-request.completed"),
    ).toHaveLength(1);
  });

  type ConfigurationPredicate = "account" | "user" | "membership" | "session" | "token" | "connection";
  async function closeFirst(predicate: ConfigurationPredicate) {
    const f = await fixture();
    const before = await f.businessEvents();
    appendProbe.before = async () => {
      if (predicate === "account")
        await f.identity.accounts.commandHandler({
          streamId: `identity.account-${f.accept.accountId}`,
          context: f.context,
          command: {
            type: "SuspendAccount",
            enforcement: {
              version: 1,
              enforcementActionId: createId("enf"),
              reason: "operator-other",
              reference: null,
            },
          },
        });
      if (predicate === "user")
        await f.identity.users.commandHandler({
          streamId: `identity.user-${f.principal.userId}`,
          context: f.context,
          command: { type: "SuspendUser" },
        });
      if (predicate === "membership")
        await f.identity.memberships.commandHandler({
          streamId: `identity.membership-${f.principal.membershipId}`,
          context: f.context,
          command: { type: "RevokeMembership" },
        });
      if (predicate === "session")
        await f.auth.sessions.commandHandler({
          streamId: `auth.session-${f.principal.sessionId}`,
          context: f.context,
          command: { type: "RevokeSession" },
        });
      if (predicate === "token") {
        const epochs = f.auth.sessionEpochs;
        if (!epochs) throw new Error("Auth Session writer topology is missing.");
        await epochs.transaction([`session/${f.principal.sessionId}`], async (db) => {
          await db.query(
            "UPDATE identity_session_tokens SET token_hash = $2, revision = revision + 1 WHERE session_id = $1",
            [f.principal.sessionId, `synthetic-rotated-token-${f.principal.sessionId}`],
          );
        });
      }
      if (predicate === "connection")
        await f.channels.connections.pauseChannelConnection(
          { accountId: f.accept.accountId, connectionId: f.connectionId },
          f.context,
        );
    };
    await expect(f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal)).rejects.toThrow();
    expect(appendProbe.before).toBeUndefined();
    expect(await f.businessEvents()).toEqual(before);
  }

  it("case 3a: class C account CLOSED-THROUGH refuses zero events", () => closeFirst("account"));
  it("case 3a: class C user CLOSED-THROUGH refuses zero events", () => closeFirst("user"));
  it("case 3a: class C membership CLOSED-THROUGH refuses zero events", () => closeFirst("membership"));
  it("case 3a: class C session CLOSED-THROUGH refuses zero events", () => closeFirst("session"));
  it("case 3a: class C token CLOSED-THROUGH refuses zero events", () => closeFirst("token"));
  it("case 3a: class C connection CLOSED-THROUGH refuses zero events", () => closeFirst("connection"));

  async function abortFirst(predicate: "item" | "allocation", mutant = false) {
    const f = await fixture();
    const accepted = await f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal);
    const before = await f.businessEvents();
    let observedStatus: string | undefined;
    appendProbe.before = async (inputs) => {
      const binding = inputs.find((input) => input.requestTerminal)?.requestTerminal;
      expect(binding).toBeDefined();
      if (predicate === "item") {
        await f.inventory.appendToStreams([
          {
            streamId: `inventory.item-${f.itemId}`,
            expectedVersion: "any",
            context: f.context,
            events: [
              {
                eventType: "inventory.item.adjusted",
                payload: { itemId: f.itemId, quantityDelta: -1, reason: "Synthetic post-prepare change" },
              },
            ],
          },
        ]);
      } else {
        await f.inventory.channelStockAllocations.set(
          {
            accountId: f.accept.accountId,
            inventoryItemId: f.itemId,
            expectedRevision: 1,
            mode: "partitioned",
            partitions: [{ channelConnectionId: f.connectionId, units: 2 }],
          },
          f.context,
        );
      }
      observedStatus = (
        await pools.marketplace.query<{ status: string }>(
          "SELECT status FROM event_request_terminals WHERE request_id = $1",
          [binding!.requestId],
        )
      ).rows[0]?.status;
    };
    if (mutant) appendProbe.mutant = "abort-cas";
    const committed = await f.listings
      .activateListingForChannel(
        {
          accountId: f.accept.accountId,
          listingId: f.accept.listingId,
          connectionId: f.connectionId,
          expectedListingVersion: accepted.version,
          expectedTargetPriceRevision: 1,
          allocationRevision: 1,
          idempotencyKey: "synthetic-activate",
        },
        f.context,
        f.principal,
      )
      .then(
        () => true,
        () => false,
      );
    expect(appendProbe.before).toBeUndefined();
    expect(observedStatus, "original terminal must be durably ABORTED before owner effects").toBe("ABORTED");
    expect(committed).toBe(false);
    expect(await f.businessEvents()).toEqual(before);
  }

  it("case 4a: class M item abort-first CAS refuses zero events", () => abortFirst("item"));
  it("case 4a: class M allocation abort-first CAS refuses zero events", () => abortFirst("allocation"));

  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const configurationPredicates = ["account", "user", "membership", "session", "token", "connection"] as const;
  function activation(f: Fixture, version: number) {
    return {
      accountId: f.accept.accountId,
      listingId: f.accept.listingId,
      connectionId: f.connectionId,
      expectedListingVersion: version,
      expectedTargetPriceRevision: 1,
      allocationRevision: 1,
      idempotencyKey: "synthetic-activate",
    };
  }
  function configurationKey(f: Fixture, predicate: ConfigurationPredicate) {
    if (predicate === "account") return `account/${f.accept.accountId}`;
    if (predicate === "user") return `user/${f.principal.userId}`;
    if (predicate === "membership") return `membership/${f.principal.membershipId}`;
    if (predicate === "connection") return `connection/${f.connectionId}`;
    return `session/${f.principal.sessionId}`;
  }
  function ownerPool(predicate: ConfigurationPredicate) {
    return predicate === "connection"
      ? pools.channels
      : predicate === "session" || predicate === "token"
        ? pools.auth
        : pools.identity;
  }
  async function invalidate(f: Fixture, predicate: ConfigurationPredicate) {
    if (predicate === "connection")
      return f.channels.connections.pauseChannelConnection(
        { accountId: f.accept.accountId, connectionId: f.connectionId },
        f.context,
      );
    if (predicate === "token")
      return upsertSessionToken(
        pools.auth,
        {
          sessionId: f.principal.sessionId,
          tokenHash: `synthetic-rotated-token-${f.principal.sessionId}`,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        f.auth.sessionEpochs,
      );
    if (predicate === "session") return revokeSession(f.auth, { sessionId: f.principal.sessionId, context: f.context });
    if (predicate === "membership")
      return f.identity.memberships.commandHandler({
        streamId: `identity.membership-${f.principal.membershipId}`,
        context: f.context,
        command: { type: "RevokeMembership" },
      });
    if (predicate === "user")
      return f.identity.users.commandHandler({
        streamId: `identity.user-${f.principal.userId}`,
        context: f.context,
        command: { type: "SuspendUser" },
      });
    return f.identity.accounts.commandHandler({
      streamId: `identity.account-${f.accept.accountId}`,
      context: f.context,
      command: {
        type: "SuspendAccount",
        enforcement: { version: 1, enforcementActionId: createId("enf"), reason: "operator-other", reference: null },
      },
    });
  }
  async function sourceFor(
    inputs: readonly AppendToStreamInput[],
    f: Fixture,
    predicate: ConfigurationPredicate,
    available = true,
  ) {
    const key = configurationKey(f, predicate);
    const grant = inputs.flatMap((input) => input.configurationGrants ?? []).find((grant) => grant.key === key);
    if (!grant) throw new Error(`Missing captured grant: ${key}`);
    const consumers = available ? [{ identity: grant.consumer, pool: observedPool(pools.marketplace) }] : [];
    const pool = ownerPool(predicate);
    const epochs =
      predicate === "connection"
        ? await createConnectionEpochsForWitness(pool, consumers)
        : predicate === "session" || predicate === "token"
          ? createAuthSessionEpochs(pool, consumers)
          : createIdentityOwnerEpochs(pool, consumers);
    return epochs.source();
  }
  async function waitForLock(namespace: string, key: string, settled: () => boolean) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await pools.marketplace.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND mode = 'ExclusiveLock'
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid::bigint = ((hashtextextended($1::text || $2::text, 0) >> 32) & 4294967295)
        AND objid::bigint = (hashtextextended($1::text || $2::text, 0) & 4294967295) AND objsubid = 1`,
        [namespace, key],
      );
      if (result.rows[0]?.waiting || settled()) return result.rows[0]?.waiting ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return 0;
  }
  async function ownerEffects(predicate: ConfigurationPredicate) {
    const pool = ownerPool(predicate);
    const events = (await pool.query("SELECT event_id FROM event_store_events ORDER BY global_position")).rows;
    const tokens =
      predicate === "token"
        ? (await pool.query("SELECT token_hash, revision FROM identity_session_tokens ORDER BY session_id")).rows
        : [];
    return { events, tokens };
  }
  async function configurationTerminalFirst(
    predicate: ConfigurationPredicate,
    mutant: "none" | "shared-lock" | "closed-through-wait" = "none",
  ) {
    const f = await fixture();
    const before = await ownerEffects(predicate);
    let writing: Promise<unknown> | undefined;
    let settled = false;
    let writeFailure: unknown;
    const consumerHistory = async () =>
      (
        await pools.marketplace.query(
          "SELECT sequence::text, record, digest FROM event_configuration_guard_history WHERE role = 'consumer' AND key = $1 ORDER BY sequence",
          [configurationKey(f, predicate)],
        )
      ).rows;
    let capturedHistory: Awaited<ReturnType<typeof consumerHistory>> | undefined;
    appendProbe.before = async () => {
      capturedHistory = await consumerHistory();
    };
    appendProbe.mutant = mutant;
    appendProbe.beforeCommit = async () => {
      writing = invalidate(f, predicate)
        .catch((error: unknown) => {
          writeFailure = error;
        })
        .finally(() => {
          settled = true;
        });
      expect(
        await waitForLock("configuration_epoch:", configurationKey(f, predicate), () => settled),
        "closure must wait on the held SHARED lock through terminal COMMIT",
      ).toBeGreaterThan(0);
      expect(
        await ownerEffects(predicate),
        "CLOSED-THROUGH must precede owner effects only after terminal COMMIT",
      ).toEqual(before);
      expect(await consumerHistory(), "CLOSED-THROUGH cannot publish before terminal COMMIT").toEqual(capturedHistory);
    };
    try {
      const result = await f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal);
      expect(result.acceptedTargetPrice).toBeDefined();
      expect(appendProbe.beforeCommit).toBeUndefined();
    } finally {
      await writing;
    }
    if (writeFailure) throw writeFailure;
    expect(await ownerEffects(predicate)).not.toEqual(before);
    expect(await f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal)).toMatchObject({
      acceptedTargetPrice: { priceAmount: "12.00" },
    });
  }

  it("case 3b: class C account terminal-first SHARED lock holds through COMMIT", () =>
    configurationTerminalFirst("account"));
  it("case 3b: class C user terminal-first SHARED lock holds through COMMIT", () => configurationTerminalFirst("user"));
  it("case 3b: class C membership terminal-first SHARED lock holds through COMMIT", () =>
    configurationTerminalFirst("membership"));
  it("case 3b: class C session terminal-first SHARED lock holds through COMMIT", () =>
    configurationTerminalFirst("session"));
  it("case 3b: class C token terminal-first SHARED lock holds through COMMIT", () =>
    configurationTerminalFirst("token"));
  it("case 3b: class C connection terminal-first SHARED lock holds through COMMIT", () =>
    configurationTerminalFirst("connection"));

  it("case 3c: class C every predicate refuses durable CLOSING before recapture", async () => {
    for (const predicate of configurationPredicates) {
      const f = await fixture();
      const before = await f.businessEvents();
      appendProbe.before = async (inputs) => {
        const source = await sourceFor(inputs, f, predicate);
        await source.beginClosure(configurationKey(f, predicate));
        await source.driveClosure(configurationKey(f, predicate));
      };
      await expect(f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal)).rejects.toThrow();
      await expect(
        f.listings.acceptListingTargetPrice(
          { ...f.accept, idempotencyKey: "closing-recapture" },
          f.context,
          f.principal,
        ),
      ).rejects.toThrow();
      expect(await f.businessEvents()).toEqual(before);
    }
  });

  it("case 3d: class C every unavailable consumer remains BLOCKED with zero owner effects", async () => {
    for (const predicate of configurationPredicates) {
      const f = await fixture();
      const before = await f.businessEvents();
      const ownerBefore = await ownerEffects(predicate);
      let status: string | undefined;
      appendProbe.before = async (inputs) => {
        const source = await sourceFor(inputs, f, predicate, false);
        await source.beginClosure(configurationKey(f, predicate));
        status = (await source.driveClosure(configurationKey(f, predicate))).status;
        throw new Error("synthetic blocked consumer");
      };
      await expect(f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal)).rejects.toThrow(
        "blocked consumer",
      );
      expect(status).toBe("BLOCKED");
      expect(await ownerEffects(predicate)).toEqual(ownerBefore);
      expect(await f.businessEvents()).toEqual(before);
    }
  });

  it("case 3e: class C old consumer incarnation after capture refuses zero events", async () => {
    const f = await fixture();
    const before = await f.businessEvents();
    appendProbe.before = async () => {
      await pools.marketplace.query(
        "UPDATE event_configuration_store_identity SET incarnation = 'synthetic-replaced-incarnation'",
      );
    };
    await expect(f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal)).rejects.toThrow();
    expect(await f.businessEvents()).toEqual(before);
  });

  it("case 3e: class C expired Session token grant after capture refuses zero events", async () => {
    const f = await fixture();
    const before = await f.businessEvents();
    appendProbe.before = async () => {
      appendProbe.validationNow = "2100-01-01T00:00:00.000Z";
    };
    await expect(f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal)).rejects.toThrow();
    expect(appendProbe.before).toBeUndefined();
    expect(await f.businessEvents()).toEqual(before);
  });

  it("case 3f: class C every partial consumer journal refuses zero events", async () => {
    for (const predicate of configurationPredicates) {
      const f = await fixture();
      const before = await f.businessEvents();
      appendProbe.before = async () => {
        await pools.marketplace.query(
          "INSERT INTO event_configuration_journal_heads (role,key,sequence,digest) VALUES ('consumer',$1,1,$2)",
          [configurationKey(f, predicate), "0".repeat(64)],
        );
      };
      await expect(f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal)).rejects.toThrow();
      expect(await f.businessEvents()).toEqual(before);
    }
  });

  it("case 3g: class C failed COMMIT rolls back Listing and request together without owner rereads", async () => {
    const f = await fixture();
    const before = await f.businessEvents();
    const clients = await Promise.all([pools.auth, pools.identity, pools.channels].map((pool) => pool.connect()));
    appendProbe.before = async () => {
      for (const client of clients) {
        await client.query("BEGIN");
        await client.query(
          "LOCK TABLE event_store_events, event_configuration_guard_history, event_configuration_journal_heads IN ACCESS EXCLUSIVE MODE",
        );
      }
      await clients[0].query("LOCK TABLE identity_session_tokens IN ACCESS EXCLUSIVE MODE");
    };
    appendProbe.beforeCommit = async () => {
      throw new Error("synthetic commit failure");
    };
    try {
      await expect(f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal)).rejects.toThrow(
        "synthetic commit failure",
      );
      expect(appendProbe.beforeCommit).toBeUndefined();
      expect(await f.businessEvents()).toEqual(before);
    } finally {
      for (const client of clients) {
        await client.query("ROLLBACK");
        client.release();
      }
    }
    await f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal);
  });

  it("case 4b: class M terminal-first COMMIT precedes stock mutation without owner rereads", async () => {
    const f = await fixture();
    const accepted = await f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal);
    const before = (await pools.inventory.query("SELECT event_id FROM event_store_events ORDER BY global_position"))
      .rows;
    let writing: Promise<unknown> | undefined;
    let settled = false;
    let failure: unknown;
    appendProbe.before = async (inputs) => {
      const binding = inputs.find((input) => input.requestTerminal)?.requestTerminal;
      if (!binding) throw new Error("Missing request terminal");
      appendProbe.beforeCommit = async () => {
        writing = f.inventory
          .appendToStreams([itemAdjustment(f)])
          .catch((error: unknown) => {
            failure = error;
          })
          .finally(() => {
            settled = true;
          });
        expect(
          await waitForLock("request_terminal:", `${binding.consumerStoreId}:${binding.requestId}`, () => settled),
        ).toBeGreaterThan(0);
        expect(
          (await pools.inventory.query("SELECT event_id FROM event_store_events ORDER BY global_position")).rows,
        ).toEqual(before);
      };
    };
    try {
      const result = await f.listings.activateListingForChannel(
        activation(f, accepted.version),
        f.context,
        f.principal,
      );
      expect(result.state.status).toBe("active");
    } finally {
      await writing;
    }
    if (failure) throw failure;
    expect((await pools.marketplace.query("SELECT status FROM event_request_terminals")).rows).toEqual([
      { status: "COMMITTED" },
    ]);
    expect((await pools.inventory.query("SELECT release_status FROM event_owner_stream_reservations")).rows).toEqual([
      { release_status: "COMMITTED" },
      { release_status: "COMMITTED" },
    ]);
  });

  it("case 4c: class M unknown original terminal blocks owner effects and resumes through durable abort", async () => {
    const f = await fixture();
    const accepted = await f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal);
    const before = await f.businessEvents();
    let blocked = false;
    appendProbe.before = async () => {
      const ownerBefore = (
        await pools.inventory.query("SELECT event_id FROM event_store_events ORDER BY global_position")
      ).rows;
      appendProbe.unavailable = true;
      try {
        blocked = await f.inventory.appendToStreams([itemAdjustment(f)]).then(
          () => false,
          () => true,
        );
      } finally {
        appendProbe.unavailable = false;
      }
      expect(
        (await pools.inventory.query("SELECT event_id FROM event_store_events ORDER BY global_position")).rows,
      ).toEqual(ownerBefore);
      throw new Error("synthetic unknown terminal");
    };
    await expect(
      f.listings.activateListingForChannel(activation(f, accepted.version), f.context, f.principal),
    ).rejects.toThrow("unknown terminal");
    expect(blocked).toBe(true);
    expect(await f.businessEvents()).toEqual(before);
    await f.inventory.appendToStreams([itemAdjustment(f)]);
    expect((await pools.marketplace.query("SELECT status FROM event_request_terminals")).rows).toEqual([
      { status: "ABORTED" },
    ]);
  });

  it("case 4d: class M pre-COMMIT failure rolls back terminal CAS and both event streams", async () => {
    const f = await fixture();
    const accepted = await f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal);
    const before = await f.businessEvents();
    appendProbe.beforeCommit = async () => {
      throw new Error("synthetic activation commit failure");
    };
    await expect(
      f.listings.activateListingForChannel(activation(f, accepted.version), f.context, f.principal),
    ).rejects.toThrow("activation commit failure");
    expect((await pools.marketplace.query("SELECT status FROM event_request_terminals")).rows).toEqual([
      { status: "OPEN" },
    ]);
    expect(await f.businessEvents()).toEqual(before);
    await expect(
      f.listings.activateListingForChannel(activation(f, accepted.version), f.context, f.principal),
    ).rejects.toThrow("original terminal");
    expect((await pools.marketplace.query("SELECT status FROM event_request_terminals")).rows).toEqual([
      { status: "ABORTED" },
    ]);
    expect(await f.businessEvents()).toEqual(before);
  });

  it("case 4e: class M replaced consumer incarnation cannot commit captured stock authority", async () => {
    const f = await fixture();
    const accepted = await f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal);
    const before = await f.businessEvents();
    appendProbe.before = async () => {
      await pools.marketplace.query(
        "UPDATE event_configuration_store_identity SET incarnation = 'synthetic-replaced-incarnation'",
      );
    };
    await expect(
      f.listings.activateListingForChannel(activation(f, accepted.version), f.context, f.principal),
    ).rejects.toThrow();
    expect((await pools.marketplace.query("SELECT status FROM event_request_terminals")).rows).toEqual([
      { status: "OPEN" },
    ]);
    expect(await f.businessEvents()).toEqual(before);
  });

  function itemAdjustment(f: Fixture): AppendToStreamInput {
    return {
      streamId: `inventory.item-${f.itemId}`,
      expectedVersion: "any",
      context: f.context,
      events: [
        {
          eventType: "inventory.item.adjusted",
          payload: { itemId: f.itemId, quantityDelta: -1, reason: "Synthetic physical writer" },
        },
      ],
    };
  }

  const physicalWriters = {
    "account command": "identity",
    "user command": "identity",
    "membership command": "identity",
    "atomic identity batch": "identity",
    "identity transaction append": "identity",
    "session revoke": "auth",
    "session logout": "auth",
    "session switch": "auth",
    "session expiry": "auth",
    "session recovery append": "auth",
    "token rotation": "auth",
    "seed token": "auth",
    "connection disconnect": "channels",
    "installed disconnect": "channels",
    "connection pause": "channels",
    "connection resume": "channels",
    "connection activation": "channels",
    "connection replay": "channels",
    "item command": "inventory",
    "positive adjustment": "inventory",
    "negative adjustment": "inventory",
    "atomic hold": "inventory",
    "hold plan append": "inventory",
    "hold release": "inventory",
    "ordering reservation": "inventory",
    "collision batch": "inventory",
    "offline sale": "inventory",
    "allocation set": "inventory",
    "aliased replay": "inventory",
    "inbound sale": "inventory",
  } as const;
  type PhysicalWriter = keyof typeof physicalWriters;
  async function projectInventory(f: Fixture) {
    await pools.inventory.query(
      "INSERT INTO inventory_catalog_items (catalog_item_id,status) VALUES ($1,'active') ON CONFLICT DO NOTHING",
      [f.catalogItemId],
    );
    await drainContextRuntime(
      {
        subscriptionRunners: resolveModuleSubscriptions([
          {
            contextName: "inventory",
            module: { ...inventoryModule, buildSubscriptions: () => [], eventSubscriptions: [], eventReactions: [] },
            services: f.inventory,
            pool: pools.inventory,
            projectionHandlerSets: inventoryModule.projectionHandlerSets?.(f.inventory) ?? [],
          },
        ]),
      },
      { settleIdleCheckpoints: true },
    );
  }
  async function setupWriter(f: Fixture, writer: PhysicalWriter) {
    if (physicalWriters[writer] === "inventory") await projectInventory(f);
    if (writer === "hold release") {
      await f.inventory.holds.commandHandler({
        streamId: `inventory.hold-${f.holdId}`,
        context: f.context,
        command: {
          type: "PlaceInventoryHold",
          holdId: f.holdId,
          accountId: f.accountId,
          itemId: f.itemId,
          quantity: 1,
          reason: "Synthetic hold",
          purpose: "manual",
          sourceRef: null,
        },
      });
      await projectInventory(f);
    }
    if (writer === "installed disconnect") {
      await pools.channels.query(
        "INSERT INTO channel_connector_pairings (pairing_id,connection_id,account_id,user_id,state,revision,code_hash,code_expires_at,created_at) VALUES ($1,$2,$3,$4,'code',1,'synthetic-code-hash','2099-01-01',clock_timestamp())",
        [`pairing-${f.connectionId}`, f.connectionId, f.accept.accountId, f.principal.userId],
      );
      await createPostgresEventStore({ pool: pools.channels }).appendToStream({
        streamId: `channels.connector-pairing-pairing-${f.connectionId}`,
        expectedVersion: "no_stream",
        context: f.context,
        events: [{ eventType: "channels.connector-pairing.code-created", payload: {} }],
      });
    }
  }
  async function writePhysical(f: Fixture, writer: PhysicalWriter) {
    const accountId = f.accountId;
    const context = f.context;
    const target = { accountId, connectionId: f.connectionId };
    if (writer === "account command") return invalidate(f, "account");
    if (writer === "user command") return invalidate(f, "user");
    if (writer === "membership command") return invalidate(f, "membership");
    if (writer === "atomic identity batch" || writer === "identity transaction append") {
      const appends: readonly AppendToStreamInput[] = [
        {
          streamId: `identity.membership-${f.principal.membershipId}`,
          expectedVersion: 1,
          context,
          events: [{ eventType: "identity.membership.role-changed", payload: { roleKey: "viewer" } }],
        },
        {
          streamId: `synthetic.audit-${accountId}`,
          expectedVersion: "no_stream",
          context,
          events: [{ eventType: "synthetic.audit", payload: {} }],
        },
      ];
      return writer === "atomic identity batch"
        ? f.identity.mutationPersistence.eventStore.appendToStreams!(appends)
        : f.identity.mutationPersistence.transaction([], (tx) => tx.append!(appends));
    }
    if (writer === "session revoke") return invalidate(f, "session");
    if (writer === "session logout") return revokeSession(f.auth, { sessionId: f.principal.sessionId, context });
    if (writer === "session switch" || writer === "session expiry")
      return f.auth.sessions.commandHandler({
        streamId: `auth.session-${f.principal.sessionId}`,
        context,
        command:
          writer === "session switch"
            ? { type: "SwitchSessionAccount", accountId: "acc_synthetic_second" }
            : { type: "ExpireSession" },
      });
    if (writer === "session recovery append")
      return f.auth.eventStore.appendToStreams!([
        {
          streamId: `auth.session-${f.principal.sessionId}`,
          expectedVersion: 1,
          context,
          events: [{ eventType: "auth.session.revoked", payload: {} }],
        },
      ]);
    if (writer === "token rotation" || writer === "seed token")
      return (writer === "seed token" ? seedSessionToken : upsertSessionToken)(
        pools.auth,
        {
          sessionId: f.principal.sessionId,
          tokenHash: `synthetic-next-token-${f.principal.sessionId}`,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        f.auth.sessionEpochs,
      );
    if (writer === "installed disconnect") return f.channels.connections.disconnectChannelConnection(target, context);
    if (writer === "connection pause") return f.channels.connections.pauseChannelConnection(target, context);
    // Resume/activation cannot start from this command's captured active state.
    // Exercise their shared physical persistence port with their exact event shape.
    if (
      writer === "connection disconnect" ||
      writer === "connection replay" ||
      writer === "connection resume" ||
      writer === "connection activation"
    ) {
      const consumer = (
        await pools.marketplace.query<{ store_id: string; incarnation: string }>(
          "SELECT store_id, incarnation FROM event_configuration_store_identity",
        )
      ).rows[0];
      const store = createConnectionPersistence(
        createPostgresEventStore({ pool: pools.channels }),
        await createConnectionEpochsForWitness(pools.channels, [
          {
            identity: { storeId: consumer.store_id, incarnation: consumer.incarnation },
            pool: observedPool(pools.marketplace),
          },
        ]),
      );
      if (writer === "connection disconnect") {
        return disconnectChannelConnectionForWitness({ eventStore: store, db: pools.channels }, target, context);
      }
      const change: AppendToStreamInput = {
        streamId: `channels.connection-${f.connectionId}`,
        expectedVersion: 2,
        context,
        events: [
          {
            eventType:
              writer === "connection resume"
                ? "channels.connection.resumed"
                : writer === "connection activation"
                  ? "channels.connection.activated"
                  : "channels.connection.paused",
            payload: {
              connectionId: f.connectionId,
              ...(writer === "connection activation"
                ? { credentialReference: null, bindings: [{ storageLocationId: f.locationId, revision: 1 }] }
                : {}),
            },
          },
        ],
      };
      return writer === "connection replay" ? store.appendToStreams!([change]) : store.appendToStream(change);
    }
    const mutation = withInventoryMutationAttempt(context, inventoryMutationAttemptFromSource(accountId, writer));
    if (writer === "item command")
      return f.inventory.items.commandHandler({
        streamId: `inventory.item-${f.itemId}`,
        context,
        command: {
          type: "AdjustInventoryItemQuantity",
          quantityDelta: -1,
          heldQuantity: 0,
          reason: "Synthetic adjustment",
          commandOccurredAt: new Date().toISOString(),
        },
      });
    if (writer === "positive adjustment" || writer === "negative adjustment")
      return f.inventory.items.adjustItem(
        {
          accountId,
          itemId: f.itemId,
          quantityDelta: writer === "positive adjustment" ? 1 : -1,
          reason: "Synthetic adjustment",
        },
        mutation,
      );
    const hold = {
      holdId: createId("hld"),
      accountId,
      itemId: f.itemId,
      quantity: 1,
      reason: "Synthetic hold",
      purpose: "manual" as const,
      sourceRef: null,
    };
    if (writer === "atomic hold") return f.inventory.holds.createHold(hold, mutation);
    if (writer === "hold plan append") {
      const plan = await f.inventory.holds.planCreateHold(hold, context);
      if (plan.kind !== "append") throw new Error("Synthetic hold plan did not append");
      return f.inventory.appendToStreams(plan.appends);
    }
    if (writer === "hold release")
      return f.inventory.holds.commandHandler({
        streamId: `inventory.hold-${f.holdId}`,
        context,
        command: { type: "ReleaseInventoryHold", releasedAt: new Date().toISOString(), releaseReason: "manual" },
      });
    if (writer === "ordering reservation")
      return reserveOrderInventoryRequest(f.inventory, {
        orderId: `ord_${accountId}`,
        request: {
          reservationRequestId: `req_${accountId}`,
          sellerAccountId: accountId,
          inventoryItemId: f.itemId,
          quantity: 1,
        },
        context,
      });
    if (writer === "collision batch" || writer === "offline sale")
      return f.inventory.holdCollisions.reduceItem(
        {
          accountId,
          itemId: f.itemId,
          requestedQuantity: 1,
          reason: "Synthetic reduction",
          ...(writer === "offline sale"
            ? {
                mode: "honor-offline" as const,
                actorRole: "owner" as const,
                offlineSale: { idempotencyKey: `sale-${accountId}`, salePriceAmount: null, channel: "other" as const },
              }
            : {}),
        },
        mutation,
      );
    if (writer === "allocation set")
      return f.inventory.channelStockAllocations.set(
        {
          accountId,
          inventoryItemId: f.itemId,
          expectedRevision: 1,
          mode: "partitioned",
          partitions: [{ channelConnectionId: f.connectionId, units: 2 }],
        },
        context,
      );
    if (writer === "inbound sale")
      return f.inventory.channelSales.record(
        {
          accountId,
          inventoryItemId: f.itemId,
          storageLocationId: f.locationId,
          requestedQuantity: 1,
          saleKey: {
            version: "v1",
            providerKey: "synthetic",
            sellerEnvironmentLineage: accountId,
            orderLineIdentity: "synthetic-line",
          },
        },
        context,
      );
    const append = f.inventory.appendToStreams;
    return append([itemAdjustment(f)]);
  }
  async function writerOmission(writer: PhysicalWriter) {
    for (const omit of [false, true]) {
      const f = await fixture();
      await setupWriter(f, writer);
      const inventory = physicalWriters[writer] === "inventory";
      const accepted = inventory
        ? await f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal)
        : undefined;
      const before = await f.businessEvents();
      let wrote = false;
      let writeFailure: unknown;
      appendProbe.before = async () => {
        appendProbe.omit = omit ? physicalWriters[writer] : "none";
        try {
          await writePhysical(f, writer);
          wrote = true;
        } catch (error) {
          writeFailure = error;
          throw error;
        } finally {
          appendProbe.omit = "none";
        }
      };
      const committed = await (
        accepted
          ? f.listings.activateListingForChannel(activation(f, accepted.version), f.context, f.principal)
          : f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal)
      ).then(
        () => true,
        () => false,
      );
      expect(wrote, `${writer} must execute the physical writer, not fail during setup: ${String(writeFailure)}`).toBe(
        true,
      );
      expect(committed, `${writer} REMOVE_PHYSICAL_WRITER_ENROLLMENT=${omit}`).toBe(omit);
      const after = await f.businessEvents();
      if (omit) {
        expect(after.length).toBe(before.length + 2);
        expect(() => expect(after, `${writer} zero-event oracle`).toEqual(before)).toThrow();
      } else expect(after).toEqual(before);
      expect(after.map((event) => event.eventType)).not.toContain("marketplace.listing.published");
    }
  }

  it("case 6: class C account command physical-writer omission", () => writerOmission("account command"));
  it("case 6: class C user command physical-writer omission", () => writerOmission("user command"));
  it("case 6: class C membership command physical-writer omission", () => writerOmission("membership command"));
  it("case 6: class C atomic identity batch physical-writer omission", () => writerOmission("atomic identity batch"));
  it("case 6: class C identity transaction append physical-writer omission", () =>
    writerOmission("identity transaction append"));
  it("case 6: class C session revoke physical-writer omission", () => writerOmission("session revoke"));
  it("case 6: class C session logout physical-writer omission", () => writerOmission("session logout"));
  it("case 6: class C session switch physical-writer omission", () => writerOmission("session switch"));
  it("case 6: class C session expiry physical-writer omission", () => writerOmission("session expiry"));
  it("case 6: class C session recovery append physical-writer omission", () =>
    writerOmission("session recovery append"));
  it("case 6: class C token rotation physical-writer omission", () => writerOmission("token rotation"));
  it("case 6: class C seed token physical-writer omission", () => writerOmission("seed token"));
  it("case 6: class C connection disconnect physical-writer omission", () => writerOmission("connection disconnect"));
  it("case 6: class C installed disconnect physical-writer omission", () => writerOmission("installed disconnect"));
  it("case 6: class C connection pause physical-writer omission", () => writerOmission("connection pause"));
  it("case 6: class C connection resume physical-writer omission", () => writerOmission("connection resume"));
  it("case 6: class C connection activation physical-writer omission", () => writerOmission("connection activation"));
  it("case 6: class C connection replay physical-writer omission", () => writerOmission("connection replay"));
  it("case 6: class M item command physical-writer omission", () => writerOmission("item command"));
  it("case 6: class M positive adjustment physical-writer omission", () => writerOmission("positive adjustment"));
  it("case 6: class M negative adjustment physical-writer omission", () => writerOmission("negative adjustment"));
  it("case 6: class M atomic hold physical-writer omission", () => writerOmission("atomic hold"));
  it("case 6: class M hold plan append physical-writer omission", () => writerOmission("hold plan append"));
  it("case 6: class M hold release physical-writer omission", () => writerOmission("hold release"));
  it("case 6: class M ordering reservation physical-writer omission", () => writerOmission("ordering reservation"));
  it("case 6: class M collision batch physical-writer omission", () => writerOmission("collision batch"));
  it("case 6: class M offline sale physical-writer omission", () => writerOmission("offline sale"));
  it("case 6: class M allocation set physical-writer omission", () => writerOmission("allocation set"));
  it("case 6: class M aliased replay physical-writer omission", () => writerOmission("aliased replay"));
  it("case 6: class M inbound sale physical-writer omission", () => writerOmission("inbound sale"));

  it("case 6: class M retained migration physical-writer omission", async () => {
    for (const omit of [false, true]) {
      const f = await fixture();
      await pools.inventory.query(
        "ALTER TABLE event_store_events DROP CONSTRAINT IF EXISTS inventory_hold_consumed_pair_binding; ALTER TABLE inventory_item_ledger DROP CONSTRAINT IF EXISTS inventory_item_ledger_consumed_null_delta",
      );
      const sourceRef = { orderId: `ord_${f.itemId}`, reservationRequestId: `rsv_${f.itemId}` };
      await createPostgresEventStore({ pool: pools.inventory }).appendToStream({
        streamId: `inventory.hold-retained-${f.itemId}`,
        expectedVersion: "no_stream",
        context: f.context,
        events: [
          {
            eventType: "inventory.hold.placed",
            payload: {
              holdId: `retained-${f.itemId}`,
              itemId: f.itemId,
              accountId: f.accept.accountId,
              quantity: 1,
              reason: "Retained synthetic hold",
              purpose: "order",
              sourceRef,
            },
          },
          {
            eventType: "inventory.hold.consumed",
            payload: {
              holdId: `retained-${f.itemId}`,
              consumedAt: new Date().toISOString(),
              consumptionReason: "dispatch",
              sourceRef,
            },
          },
        ],
      });
      await projectInventory(f);
      await pools.inventory.query(
        "DELETE FROM bounded_context_schema_migrations WHERE migration_id = '20261102_inventory_hold_consumption_handoff'",
      );
      const accepted = await f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal);
      const before = await f.businessEvents();
      let migrated = false;
      appendProbe.before = async () => {
        appendProbe.omit = omit ? "inventory" : "none";
        try {
          migrated = await bootstrapContextDatabase(inventoryModule, pools.inventory).then(
            () => true,
            () => false,
          );
        } finally {
          appendProbe.omit = "none";
        }
        if (!omit) {
          await createInventoryStockAuthorityForPool(pools.inventory, observedPool(pools.marketplace)).invalidateStock(
            f.itemId,
          );
          await bootstrapContextDatabase(inventoryModule, pools.inventory);
        }
      };
      const committed = await f.listings
        .activateListingForChannel(activation(f, accepted.version), f.context, f.principal)
        .then(
          () => true,
          () => false,
        );
      expect(migrated).toBe(omit);
      expect(committed).toBe(omit);
      const after = await f.businessEvents();
      if (omit) {
        expect(after.length).toBe(before.length + 2);
        expect(() => expect(after).toEqual(before)).toThrow();
      } else expect(await f.businessEvents()).toEqual(before);
    }
  });

  it("case 6: REMOVE_SHARED_LOCK makes the real-host closure-wait oracle red", async () => {
    await expect(configurationTerminalFirst("account", "shared-lock")).rejects.toThrow("closure must wait");
  });
  it("case 6: REMOVE_CLOSED_THROUGH_WAIT makes the real-host closure-wait oracle red", async () => {
    await expect(configurationTerminalFirst("account", "closed-through-wait")).rejects.toThrow("closure must wait");
  });
  it("case 6: REMOVE_ABORT_CAS makes the real-host durable-abort oracle red", async () => {
    await expect(abortFirst("item", true)).rejects.toThrow("original terminal must be durably ABORTED");
  });

  it("case 5: uncomposed Pricing class C/M participants refuse with zero events", async () => {
    const f = await fixture();
    const before = await f.businessEvents();
    await expect(
      f.listings.acceptListingTargetPrice(
        {
          ...f.accept,
          decision: {
            kind: "pricing-evaluation",
            evaluationId: "synthetic-evaluation",
            evaluationRevision: "1",
            basePriceRevision: 1,
            standingAuthorizationId: "synthetic-standing",
            standingAuthorizationRevision: "1",
          },
        },
        f.context,
        f.principal,
      ),
    ).rejects.toThrow("Pricing");
    expect(await f.businessEvents()).toEqual(before);
  });

  it("commits the exact Pricing pair and original terminal without native price, fee, or anchor feedback", async () => {
    const f = await pricingFixture();
    appendProbe.loseReply = true;
    const accepted = await f.acceptPricing();
    expect(accepted.acceptedTargetPrice).toMatchObject({
      decision: f.acceptance.decision,
      priceAmount: "12.00",
      priceCurrencyCode: "USD",
    });
    expect(accepted.state).toMatchObject({
      priceAmount: "10.00",
      nativeVisibility: "disabled",
      nativeFeeState: "not-enrolled",
      feeLocks: [],
    });
    expect(await f.latestTerminal()).toBe("COMMITTED");
    expect(await f.acceptPricing()).toEqual(accepted);
    await expect(f.acceptPricing({ ...f.acceptance, priceAmount: "13.00" })).rejects.toThrow("different command");
    const events = (await f.businessEvents()).map((event) => event.eventType);
    expect(events).toContain("marketplace.listing.target-price-accepted");
    expect(events).not.toContain("marketplace.listing.price-updated");
    expect(events).not.toContain("marketplace.listing.published");
    expect((await pools.pricing.query("SELECT 1 FROM pricing_market_listing_inputs")).rows).toHaveLength(0);
  });

  it("refuses a real decision when standing closes first and accepts only on a fresh epoch", async () => {
    const f = await pricingFixture();
    const before = await f.businessEvents();
    appendProbe.before = async () => {
      expect(
        (await f.pricing.repricingPolicies.setHalt(f.accountId, true, f.context, "synthetic-close-first")).status,
      ).toBe("applied");
    };
    await expect(f.acceptPricing()).rejects.toThrow();
    expect(await f.businessEvents()).toEqual(before);
    expect(await f.latestTerminal()).toBe("ABORTED");
    expect((await f.pricing.repricingPolicies.setHalt(f.accountId, false, f.context, "synthetic-reopen")).status).toBe(
      "applied",
    );
    if (f.acceptance.decision.kind !== "pricing-evaluation") throw new Error("Expected Pricing decision.");
    await expect(
      f.acceptPricing({
        ...f.acceptance,
        idempotencyKey: "synthetic-next-epoch",
        decision: {
          ...f.acceptance.decision,
          evaluationId: "evd_synthetic_reopened",
          standingAuthorizationRevision: "3",
        },
      }),
    ).resolves.toMatchObject({ acceptedTargetPrice: { priceAmount: "12.00" } });
  });

  it("holds real Pricing standing until terminal-first COMMIT before installing the halt", async () => {
    const f = await pricingFixture();
    const before = await f.pricing.repricingPolicies.getHalt(f.accountId);
    let halted: ReturnType<PricingServices["repricingPolicies"]["setHalt"]> | undefined;
    let settled = false;
    appendProbe.beforeCommit = async () => {
      halted = f.pricing.repricingPolicies
        .setHalt(f.accountId, true, f.context, "synthetic-terminal-first")
        .finally(() => {
          settled = true;
        });
      void halted.catch(() => undefined);
      expect(
        await waitForLock("configuration_epoch:", `repricing-account/${f.accountId}`, () => settled),
      ).toBeGreaterThan(0);
      expect(await f.pricing.repricingPolicies.getHalt(f.accountId)).toEqual(before);
    };
    try {
      await expect(f.acceptPricing()).resolves.toMatchObject({ acceptedTargetPrice: { priceAmount: "12.00" } });
    } finally {
      expect(await halted).toMatchObject({ status: "applied" });
    }
    expect(await f.latestTerminal()).toBe("COMMITTED");
  });

  it("orders a real Listing withdrawal ahead of the open Pricing terminal without accepting a target", async () => {
    const f = await pricingFixture();
    appendProbe.before = async () => {
      await f.listings.withdrawListing(
        {
          accountId: f.accountId,
          listingId: f.acceptance.listingId,
          expectedVersion: f.acceptance.expectedListingVersion,
          idempotencyKey: "synthetic-pricing-withdraw",
        },
        f.context,
      );
    };
    await expect(f.acceptPricing()).rejects.toThrow();
    expect(await f.latestTerminal()).toBe("ABORTED");
    const events = (await f.businessEvents()).map((event) => event.eventType);
    expect(events).toContain("marketplace.listing.withdrawn");
    expect(events).not.toContain("marketplace.listing.target-price-accepted");
  });

  it.each([
    [0, false],
    [1, false],
    [0, true],
    [1, true],
  ] as const)(
    "orders enrolled Catalog removal %s for P on both categories (terminal first: %s)",
    async (first, terminalFirst) => {
      const f = await pricingFixture(true);
      const before = await f.businessEvents();
      if (!terminalFirst)
        appendProbe.before = async () => {
          expect((await f.category("DELETE", f.categories[first])).status).toBe(200);
        };
      if (terminalFirst) {
        await f.acceptPricing();
        expect((await f.category("DELETE", f.categories[first])).status).toBe(200);
      } else {
        await expect(f.acceptPricing()).rejects.toThrow();
        expect(await f.businessEvents()).toEqual(before);
      }
      expect(await f.latestTerminal()).toBe(terminalFirst ? "COMMITTED" : "ABORTED");
      expect((await f.category("DELETE", f.categories[first === 0 ? 1 : 0])).status).toBe(200);
    },
  );
});
