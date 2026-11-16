import { beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { module as authModule } from "@chase-sets/auth";
import { module as channelsModule } from "@chase-sets/channels";
import type { ChannelsServices } from "@chase-sets/channels/server";
import { module as identityModule } from "@chase-sets/identity";
import type { IdentityServices } from "@chase-sets/identity/server";
import { module as inventoryModule } from "@chase-sets/inventory";
import type { InventoryServices } from "@chase-sets/inventory/server";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import type { MarketplaceServices, AcceptListingTargetPriceInput } from "@chase-sets/marketplace/server";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { createId } from "@chase-sets/primitives/typed-ids";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { buildPlatformApiApp, createPlatformApiHost } from "../src/app";
import {
  createPlatformApiBootstrapTestHarness,
  listingPhotoStorage,
  type PlatformApiTestPools,
} from "./bootstrap-db-test-support";

const appendProbe = vi.hoisted(() => ({
  before: undefined as (() => Promise<void>) | undefined,
  loseReply: false,
}));
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
          await before();
        }
        if (!store.appendToStreams) throw new Error("Atomic append is unavailable.");
        const result = await store.appendToStreams(inputs);
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
  createPlatformApiBootstrapTestHarness(
    "listing_channel_activation_10410",
    (state) => {
      pools = state.pools;
    },
    { activeContextNames: ["auth", "identity", "channels", "inventory", "marketplace"] },
  );
  beforeEach(async () => {
    appendProbe.before = undefined;
    appendProbe.loseReply = false;
    for (const [module, pool] of [
      [authModule, pools.auth],
      [identityModule, pools.identity],
      [channelsModule, pools.channels],
      [inventoryModule, pools.inventory],
      [marketplaceModule, pools.marketplace],
    ] as const)
      await bootstrapContextDatabase(module, pool);
  });

  function host() {
    return createPlatformApiHost({
      pools,
      hostPorts: {
        capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
        processorGateway: createFakePaymentProcessorGateway(),
        listingPhotoStorage,
        setupResolver: {
          resolve: async () => ({
            providerKey: "synthetic-provider",
            environment: "sandbox" as const,
            requirements: {
              credential: "not-required" as const,
              requiredPolicyKeys: [],
              binding: "one-or-more-current" as const,
            },
          }),
        },
      },
    });
  }

  async function fixture() {
    const runtime = host();
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
    const connectionId = "synthetic-connection";
    const context = { tenantId: createId("tnt"), audit: { performedByUserId: userId, forAccountId: accountId } };
    const principal = { userId, membershipId, sessionId, tokenHash: "synthetic-session-token-hash" };
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
        availableAccountIds: [accountId],
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
        idempotencyKey: "synthetic-create",
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
    };
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

  it.each(["account", "user", "membership", "session", "token", "connection"] as const)(
    "case 3a: class C %s CLOSED-THROUGH after capture refuses with zero Listing/request events",
    async (predicate) => {
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
              [f.principal.sessionId, "synthetic-rotated-token"],
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
    },
  );

  it.each(["item", "allocation"] as const)(
    "case 4a: class M %s invalidation aborts the original request before applying stock changes",
    async (predicate) => {
      const f = await fixture();
      const accepted = await f.listings.acceptListingTargetPrice(f.accept, f.context, f.principal);
      const before = await f.businessEvents();
      appendProbe.before = async () => {
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
        expect(
          (await pools.marketplace.query<{ status: string }>("SELECT status FROM event_request_terminals")).rows,
        ).toEqual([{ status: "ABORTED" }]);
      };
      await expect(
        f.listings.activateListingForChannel(
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
        ),
      ).rejects.toThrow();
      expect(appendProbe.before).toBeUndefined();
      expect(await f.businessEvents()).toEqual(before);
    },
  );

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
});
