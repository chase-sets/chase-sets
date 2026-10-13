import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  composeModuleSchemaSql,
  createCheckpointKey,
  createProjectionAwarePool,
  createSubscriptionRunner,
} from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { BcEventSubscription } from "@chase-sets/bounded-context-module";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { createId, type ListingId } from "@chase-sets/primitives/typed-ids";
import { createMarketplaceCommercialTermsResolver } from "../../../api";
import { module as marketplaceModule } from "../../../index";
import type { MarketplaceServices } from "../../../support/runtime-support/services";
import { createMarketplaceListingRuntime, type MarketplaceListingServices } from "../api/runtime";
import {
  decideMarketplaceListing,
  initialMarketplaceListingState,
  type CreateListingCommand,
  type MarketplaceListingCommand,
  type PublishListingCommand,
} from "../domain/domain";
import { buildListingModerationReactionHandlers } from "../integrations/moderation/listing-moderation-reaction";

const baseUrl = process.env.TEST_DATABASE_URL;
if (!baseUrl && process.env.CI) throw new Error("TEST_DATABASE_URL is required for listing reaction DB proof.");
const describeDb = baseUrl ? describe : describe.skip;
const directiveType = "platform-operations.reported-content.listing-removal-directed";
const auditType = "platform-operations.reported-content.action-recorded";
const reactionName = "marketplace-listing-moderation-reaction";
const directedAt = "2026-10-06T09:00:00.000-05:00";
const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: createId("usr"), forAccountId: createId("acc") },
};

function barrier() {
  let entered!: () => void;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    held,
    release,
    wait: async () => {
      entered();
      await released;
    },
  };
}

describeDb("listing moderation reaction real runner", () => {
  let pools: ReturnType<typeof createMultiContextTestPools<"marketplace" | "platform-operations">>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(
      baseUrl!,
      ["marketplace", "platform-operations"],
      "listing_reaction",
    );
    await ensureMultiContextTestDatabases(baseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools.marketplace.query(composeModuleSchemaSql(marketplaceModule));
    await pools["platform-operations"].query(composeModuleSchemaSql({ schemaSql: "" }));
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function source() {
    return createPostgresEventStore({ pool: pools["platform-operations"] });
  }
  function services(listings?: MarketplaceListingServices) {
    const composed = marketplaceModule.createServices(createProjectionAwarePool(pools.marketplace), {});
    return listings ? { ...composed, listings } : composed;
  }
  function subscription(composed: MarketplaceServices): BcEventSubscription {
    const subscriptions = marketplaceModule.buildSubscriptions!(composed);
    const declaration = subscriptions.find(({ projectionName }) => projectionName === reactionName);
    expect(declaration).toBeDefined();
    return declaration!;
  }
  function runner(declaration: BcEventSubscription) {
    return createSubscriptionRunner("marketplace", pools.marketplace, pools["platform-operations"], declaration);
  }
  function command(listings: MarketplaceListingServices, listingId: ListingId, command: MarketplaceListingCommand) {
    return listings.commandHandler({ streamId: `marketplace.listing-${listingId}`, command, context });
  }
  async function seed(listings: MarketplaceListingServices) {
    const listingId = createId("lst");
    await command(listings, listingId, createListing(listingId));
    await command(listings, listingId, publish);
    return listingId;
  }
  async function appendDirective(listingId: ListingId, actionId = createId("rca")) {
    await source().appendToStream({
      streamId: `platform-operations.reported-content-listing-${listingId}`,
      expectedVersion: "any",
      context,
      events: [{ eventType: directiveType, payload: { actionId, listingId, operatorUserId: null, directedAt } }],
    });
    return actionId;
  }
  async function removals(listingId: ListingId) {
    return (
      await pools.marketplace.query<{ payload: { listingEnforcement: unknown } }>(
        "SELECT payload FROM event_store_events WHERE stream_id = $1 AND event_type = 'marketplace.listing.operator-unlisted' ORDER BY stream_version",
        [`marketplace.listing-${listingId}`],
      )
    ).rows.map(({ payload }) => payload.listingEnforcement);
  }
  async function applications(declaration: BcEventSubscription) {
    return (
      await pools.marketplace.query<{ status: string }>(
        "SELECT status FROM event_subscription_applications WHERE projection_key = $1 ORDER BY global_position",
        [createCheckpointKey(declaration)],
      )
    ).rows;
  }
  async function rewind(declaration: BcEventSubscription) {
    await pools.marketplace.query(
      "UPDATE event_subscription_checkpoints SET last_global_position = 0 WHERE checkpoint_key = $1",
      [createCheckpointKey(declaration)],
    );
  }
  function observed(composed: MarketplaceServices) {
    const dispatch = vi.fn(composed.listings.operatorUnlistListing);
    const declaration = subscription({
      ...composed,
      listings: { ...composed.listings, operatorUnlistListing: dispatch },
    });
    const handler = vi.fn(declaration.handlers[directiveType]!);
    return { dispatch, handler, declaration: { ...declaration, handlers: { [directiveType]: handler } } };
  }
  async function historical(listings: MarketplaceListingServices) {
    const listingId = await seed(listings);
    for (const [targetType, action] of [
      ["listing", "unlist"],
      ["listing", "dismiss"],
      ["review", "withdraw-review"],
    ]) {
      await source().appendToStream({
        streamId: `platform-operations.reported-content-${targetType}-${listingId}` as never,
        expectedVersion: "any",
        context,
        events: [
          {
            eventType: auditType,
            payload: {
              actionId: createId("rca"),
              targetType,
              targetId: listingId,
              action,
              note: "Synthetic historical audit",
              operatorUserId: null,
              recordedAt: directedAt,
            },
          },
        ],
      });
    }
    return listingId;
  }

  it("first activation leaves synthetic historical audit-only listing active and processes one new directive", async () => {
    const composed = services();
    const listingId = await historical(composed.listings);
    const proof = observed(composed);
    await runner(proof.declaration).runOnce();
    expect(proof.handler).not.toHaveBeenCalled();
    expect(proof.dispatch).not.toHaveBeenCalled();
    expect((await composed.listings.loadListingState(listingId)).status).toBe("active");
    expect(await removals(listingId)).toEqual([]);
    await appendDirective(listingId);
    await runner(proof.declaration).runOnce();
    expect(proof.handler).toHaveBeenCalledTimes(1);
    expect(proof.dispatch).toHaveBeenCalledTimes(1);
    expect(await removals(listingId)).toHaveLength(1);
    expect(await applications(proof.declaration)).toEqual([{ status: "applied" }]);
  });

  it("functional historical-event-plus-adapter mutant separately fails the first-activation oracle", async () => {
    const composed = services();
    const listingId = await historical(composed.listings);
    const proof = observed(composed);
    const mutant: BcEventSubscription = {
      ...proof.declaration,
      eventTypes: [auditType],
      handlers: {
        [auditType]: async (event, handlerContext) => {
          if (event.data.targetType !== "listing" || event.data.action !== "unlist") return;
          await proof.handler(
            {
              ...event,
              type: directiveType,
              data: {
                actionId: event.data.actionId!,
                listingId: event.data.targetId!,
                operatorUserId: event.data.operatorUserId!,
                directedAt: event.data.recordedAt!,
              },
            },
            handlerContext,
          );
        },
      },
    };
    await runner(mutant).runOnce();
    await expect(async () => {
      expect(proof.dispatch).not.toHaveBeenCalled();
      expect((await composed.listings.loadListingState(listingId)).status).toBe("active");
    }).rejects.toThrow();
    expect(proof.dispatch).toHaveBeenCalledTimes(1);
    expect(await removals(listingId)).toHaveLength(1);
  });

  it("event versus source deduplication", async () => {
    const composed = services();
    const listingId = await seed(composed.listings);
    const actionId = await appendDirective(listingId);
    const proof = observed(composed);
    const first = runner(proof.declaration);
    await Promise.all([first.runOnce(), runner(proof.declaration).runOnce()]);
    await rewind(proof.declaration);
    await first.runOnce();
    await rewind(proof.declaration);
    await Promise.all([first.runOnce(), runner(proof.declaration).runOnce()]);
    expect(proof.handler).toHaveBeenCalledTimes(1);
    expect(proof.dispatch).toHaveBeenCalledTimes(1);
    expect(await applications(proof.declaration)).toEqual([{ status: "applied" }]);
    expect(await removals(listingId)).toHaveLength(1);
    await command(composed.listings, listingId, publish);
    await appendDirective(listingId, actionId);
    await first.runOnce();
    expect(proof.handler).toHaveBeenCalledTimes(2);
    expect(proof.dispatch).toHaveBeenCalledTimes(2);
    expect(await removals(listingId)).toHaveLength(1);
    expect((await composed.listings.loadListingState(listingId)).status).toBe("active");
    expect(await applications(proof.declaration)).toEqual([{ status: "applied" }, { status: "applied" }]);
    expect((await pools.marketplace.query("SELECT event_id FROM event_projection_poison_events")).rows).toEqual([]);
  });

  async function conflictProof(mutant?: "delete-retry" | "remint") {
    const inner = createPostgresEventStore({ pool: createProjectionAwarePool(pools.marketplace) });
    const gate = barrier();
    const attempts: Parameters<EventStore["appendToStream"]>[0][] = [];
    const conflicts: unknown[] = [];
    const eventStore: EventStore = {
      ...inner,
      appendToStream: async (input) => {
        if (input.events[0]?.eventType === "marketplace.listing.operator-unlisted") {
          attempts.push(input);
          if (attempts.length === 1) await gate.wait();
        }
        try {
          return await inner.appendToStream(input);
        } catch (error) {
          conflicts.push(error);
          throw error;
        }
      },
    };
    const listings = createMarketplaceListingRuntime({
      eventStore,
      db: createProjectionAwarePool(pools.marketplace),
      checkpointStore: createPostgresProjectionStore({ db: pools.marketplace }),
      commercialTermsResolver: createMarketplaceCommercialTermsResolver(pools.marketplace),
    });
    const listingId = await seed(listings);
    await appendDirective(listingId);
    const proof = observed(services(listings));
    let declaration: BcEventSubscription = proof.declaration;
    if (mutant) {
      const handlers = buildListingModerationReactionHandlers({
        operatorUnlistListing: async (params, ctx) => {
          if (mutant === "delete-retry") {
            try {
              return await proof.dispatch(params, ctx);
            } catch (error) {
              throw new Error("synthetic deleted retry", { cause: error });
            }
          }
          return proof.dispatch({ ...params, listingEnforcementActionId: createId("lea") }, ctx);
        },
      });
      declaration = { ...declaration, handlers };
    }
    const running = runner(declaration).runOnce();
    try {
      await Promise.race([
        gate.held,
        running.then(() => {
          throw new Error("Runner finished before the append barrier.");
        }),
      ]);
      expect((await listings.loadListingState(listingId)).status).toBe("active");
      const updated = await command(services().listings, listingId, {
        type: "UpdateListingPurchaseLimits",
        purchaseLimits: { maxUnitsPerOrder: 1 },
      });
      expect(updated.version).toBe(3);
    } finally {
      gate.release();
      await running;
    }
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ code: "concurrency_conflict" });
    const oracle = async () => {
      expect(attempts).toHaveLength(2);
      expect(attempts.map(({ expectedVersion }) => expectedVersion)).toEqual([2, 3]);
      expect(attempts[1]!.events).toEqual(attempts[0]!.events);
      expect(await removals(listingId)).toEqual([attempts[0]!.events[0]!.payload.listingEnforcement]);
      expect(await applications(declaration)).toEqual([{ status: "applied" }]);
      expect((await listings.loadListingState(listingId)).status).toBe("paused");
    };
    return { oracle, declaration, attempts };
  }

  it("barriered listing conflict", async () => {
    const proof = await conflictProof();
    await proof.oracle();
  });
  it.each(["delete-retry", "remint"] as const)("barriered listing conflict rejects the %s mutant", async (mutant) => {
    const proof = await conflictProof(mutant);
    await expect(proof.oracle()).rejects.toThrow();
    if (mutant === "delete-retry") {
      expect(proof.attempts).toHaveLength(1);
      expect(await applications(proof.declaration)).toEqual([{ status: "poison" }]);
    } else {
      expect(proof.attempts).toHaveLength(2);
      expect(proof.attempts[1]!.events).not.toEqual(proof.attempts[0]!.events);
    }
  });

  it("delivery disable re-enable", async () => {
    const composed = services();
    const removed = await seed(composed.listings);
    const pending = await seed(composed.listings);
    const proof = observed(composed);
    await appendDirective(removed);
    await runner(proof.declaration).runOnce();
    const reviewKey = "marketplace-review-moderation-reaction:platform-operations:v1";
    await pools.marketplace.query(
      `INSERT INTO event_subscription_checkpoints
      (checkpoint_key, projection_name, source_context_name, subscription_version, last_global_position, updated_at)
      VALUES ($1, 'marketplace-review-moderation-reaction', 'platform-operations', 1, 17, now())`,
      [reviewKey],
    );
    await appendDirective(pending);
    const disabled = marketplaceModule.buildSubscriptions!(composed).filter(
      ({ projectionName }) => projectionName !== reactionName,
    );
    expect(disabled.some(({ projectionName }) => projectionName === "marketplace-review-moderation-reaction")).toBe(
      true,
    );
    expect(
      disabled.find(
        ({ projectionName, sourceContextName }) =>
          projectionName === "marketplace-listing-projection" && sourceContextName === "marketplace",
      )?.eventTypes,
    ).toContain("marketplace.listing.operator-unlisted");
    const fresh = services();
    expect((await fresh.listings.loadListingState(removed)).status).toBe("paused");
    expect((await fresh.listings.loadListingState(pending)).status).toBe("active");
    expect(proof.dispatch).toHaveBeenCalledTimes(1);
    await runner(subscription(fresh)).runOnce();
    expect((await fresh.listings.loadListingState(pending)).status).toBe("paused");
    expect(await applications(proof.declaration)).toEqual([{ status: "applied" }, { status: "applied" }]);
    expect(
      (
        await pools.marketplace.query<{ last_global_position: string }>(
          "SELECT last_global_position FROM event_subscription_checkpoints WHERE checkpoint_key = $1",
          [reviewKey],
        )
      ).rows[0]?.last_global_position,
    ).toBe("17");
  });
});

const evidenceRequirements = {
  policyId: null,
  policyVersion: null,
  policyHash: "sha256:policy",
  evaluatedAt: directedAt,
  requirementHash: "sha256:requirements",
  matchedRuleIds: [],
  explanationCodes: [],
  requirements: { minimumPhotoCount: 0, requiredSlots: [], sellerTrustRequirements: [], buyerAcknowledgment: "none" },
} as const;
const publish: PublishListingCommand = {
  type: "PublishListing",
  readiness: {
    ready: true,
    requirementHash: evidenceRequirements.requirementHash,
    unmetCodes: [],
    coverage: { complete: true, unmetCodes: [], slots: [], activePhotoCount: 0, minimumPhotoCount: 0 },
  },
};
function createListing(listingId: ListingId): CreateListingCommand {
  const command: CreateListingCommand = {
    type: "CreateListing",
    listingId,
    accountId: context.audit.forAccountId,
    inventoryItemId: createId("itm"),
    catalogItemId: "cat_test",
    productId: "cat_test::" as never,
    itemLanguageCode: "en",
    itemTitle: "Test Card",
    itemSubtitle: null,
    selectedOptions: [],
    productSummary: null,
    productMeasureSnapshot: {
      catalogItemId: "cat_test",
      productId: "cat_test::",
      selectedOptions: [],
      measureVersion: "pm_test_v1",
      unitLengthInches: 3.5,
      unitWidthInches: 2.5,
      unitHeightInches: 0.01,
      unitWeightOunces: 0.1,
      physicalFlags: ["raw-card"],
      stackBehavior: "stackable-thickness",
      source: "profile",
      confidence: "measured",
    },
    storageLocationName: "Main",
    shipFromCode: "CHI",
    shipFromAddress: {
      name: "Seller",
      company: null,
      line1: "1 Main St",
      line2: null,
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
      phone: null,
      email: null,
    },
    priceAmount: "10.00",
    priceCurrencyCode: "USD",
    quantityCap: 1,
    evidenceRequirements,
    feeLock: {
      unitCount: 1,
      terms: {
        marketplaceSalesFeePercentageBps: 500,
        marketplaceSalesFeeFixedAmount: "0.00",
        marketplaceSalesFeeCapAmount: "25.00",
        shippingAllowancePercentageBps: 500,
        termsScheduleId: "cts_standard",
        termsAgreementId: null,
        termsResolvedAt: directedAt,
      },
      marketplaceSalesFeeUnitAmount: "0.50",
      sellerNetUnitAmount: "9.50",
      feeQuoteFingerprint: "fee_test",
    },
  };
  expect(decideMarketplaceListing(initialMarketplaceListingState, command)).toHaveLength(1);
  return command;
}
