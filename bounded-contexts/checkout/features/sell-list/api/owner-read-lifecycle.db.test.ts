import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { module as fulfillmentModule } from "@chase-sets/fulfillment";
import { createSellerCheckoutReadinessReader, createSellerShippingSetupServices } from "@chase-sets/fulfillment/server";
import { module as settlementModule } from "@chase-sets/settlement";
import { createSellerCheckoutRiskReader } from "@chase-sets/settlement/server";
import { module as checkoutModule } from "../../../index";
import type { CheckoutSellerCheckoutOwners } from "../../../api";
import { createCheckoutSellListRuntime } from "./runtime";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for seller checkout owner lifecycle proof.");
const describeDb = databaseUrl ? describe : describe.skip;
const names = ["checkout", "fulfillment", "settlement"] as const;
const owner = { kind: "anonymous", anonymousSellListId: "anon_lifecycle" } as const;
const targetAccountId = "acc_lifecycle" as const;
const setup = {
  origin: {
    name: "Synthetic Seller",
    line1: "1 Main St",
    line2: null,
    city: "Wichita",
    state: "KS",
    postalCode: "67202",
    country: "US",
  },
  labelPreference: "prepaid-label",
} as const;
const context: EventStoreContext = {
  tenantId: "tnt_lifecycle" as never,
  audit: { performedByUserId: "usr_lifecycle" as never, forAccountId: targetAccountId },
};
const actor: ResolvedActor = {
  sessionId: "ses_lifecycle",
  tenantId: "tnt_lifecycle",
  userId: "usr_lifecycle",
  accountId: "acc_admin",
  membershipId: "mem_lifecycle",
  roleKey: "platform-admin",
  permissions: [],
};
const adminContext: EventStoreContext = {
  ...context,
  audit: { ...context.audit, forAccountId: actor.accountId as never },
};

describeDb("AC4 composed production owner lifecycle across real merge", () => {
  let pools: Readonly<Record<(typeof names)[number], PgTransactionalPool>>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseUrl!, names, "checkout_owner_lifecycle");
    await ensureMultiContextTestDatabases(databaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(checkoutModule, pools.checkout);
    await bootstrapContextDatabase(fulfillmentModule, pools.fulfillment);
    await bootstrapContextDatabase(settlementModule, pools.settlement);
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  function shipping() {
    return createSellerShippingSetupServices({
      pool: pools.fulfillment,
      operatorAuthority: async (requester) => ({
        kind: "granted",
        membershipId: requester.membershipId,
        roleKey: "platform-admin",
        rolePermissions: [],
      }),
    });
  }
  function ports(): CheckoutSellerCheckoutOwners {
    const source = shipping();
    return {
      readRisk: createSellerCheckoutRiskReader(pools.settlement),
      readFulfillment: createSellerCheckoutReadinessReader(pools.fulfillment),
      resolveOrigin: source.resolveOrigin,
      invalidateAnonymousOwner: source.invalidateAnonymousOwner,
    };
  }
  function runtime(eventStore: EventStore = createPostgresEventStore({ pool: pools.checkout })) {
    return createCheckoutSellListRuntime({
      db: pools.checkout,
      eventStore,
      checkpointStore: createPostgresProjectionStore({ db: pools.checkout }),
      sellerCheckoutOwners: ports(),
    });
  }
  async function enable() {
    const source = shipping();
    await source.saveSetup(owner, setup, context);
    await source.changeSupport(
      actor,
      { owner, action: "initialize", reason: "Synthetic lifecycle proof", operationId: "initialize_lifecycle" },
      adminContext,
    );
    const resolved = await source.resolveOrigin(owner, setup);
    if (resolved.status !== "accepted") throw new Error("Missing real source binding");
    return resolved;
  }

  it("reads actual driver revisions/timestamps and matches full manual origins for each owner", async () => {
    for (const currentOwner of [owner, { kind: "account", accountId: targetAccountId }] as const) {
      await shipping().saveSetup(currentOwner, setup, context);
      await shipping().changeSupport(
        actor,
        {
          owner: currentOwner,
          action: "initialize",
          reason: "Synthetic owner proof",
          operationId: `initialize_${currentOwner.kind}`,
        },
        adminContext,
      );
      const id = currentOwner.kind === "account" ? currentOwner.accountId : currentOwner.anonymousSellListId;
      const captured = await runtime().createReadinessSnapshot({
        sellerAccountId: id,
        shipFrom: setup.origin,
        label: { preference: setup.labelPreference },
      });
      expect(captured.sellerReadiness).toMatchObject({
        shipFrom: "ready",
        label: "ready",
        provider: "ready",
        risk: "ready",
      });
      expect(captured.ownerReads?.risk?.rowState).toBe("absent");
      const row = await pools.fulfillment.query<{ current_version: string; recorded_at: Date }>(
        `SELECT s.current_version, e.recorded_at FROM event_store_streams s JOIN event_store_events e ON e.stream_id=s.stream_id AND e.stream_version=s.current_version WHERE s.stream_id=$1`,
        [`fulfillment.seller-shipping-${currentOwner.kind}:${id}`],
      );
      expect(captured.ownerReads?.fulfillment?.sourceRevision).toBe(Number(row.rows[0]!.current_version));
      expect(captured.ownerReads?.fulfillment?.sourceTimestamp).toBe(row.rows[0]!.recorded_at.toISOString());
      const conflict = await runtime().createReadinessSnapshot({
        sellerAccountId: id,
        shipFrom: { ...setup.origin, line1: "2 Main St" },
        label: { preference: setup.labelPreference },
      });
      expect(conflict.sellerReadiness.shipFrom).toBe("blocked");
    }
  });

  it.each([false, true])(
    "durably fences an empty merge before success, including setupPresent=%s and restart",
    async (setupPresent) => {
      if (setupPresent) await enable();
      const merge = { sourceOwnerId: owner.anonymousSellListId, targetAccountId };
      expect(await runtime().mergeSellListIntoAccount(merge, context)).toEqual({ mergedLineCount: 0 });
      expect(await runtime().mergeSellListIntoAccount(merge, context)).toEqual({ mergedLineCount: 0 });
      expect(await shipping().resolveOrigin(owner, setup)).toMatchObject({ status: "blocked" });
      await expect(shipping().saveSetup(owner, setup, context)).rejects.toThrow("invalidated");
      const state = await shipping().readSetup(owner);
      expect(state.supportStatus).toBe("invalidated");
      expect((await shipping().readSetup({ kind: "account", accountId: targetAccountId })).setup).toBeNull();
      const otherTarget = { ...merge, targetAccountId: "acc_other" as never };
      await expect(runtime().mergeSellListIntoAccount(otherTarget, context)).rejects.toThrow("conflicting-operation");
    },
  );

  it("retains the fence through partial target failure and converges after retry/restart without copying support", async () => {
    const before = await enable();
    const real = createPostgresEventStore({ pool: pools.checkout });
    let fail = true;
    let writes = 0;
    const failing: EventStore = {
      ...real,
      appendToStream: async (input) => {
        if (input.streamId === `checkout.sell-list-${targetAccountId}` && fail && ++writes === 2)
          throw new Error("synthetic second target write failure");
        return real.appendToStream(input);
      },
    };
    const services = runtime(failing);
    for (const suffix of ["one", "two"]) {
      await services.commandHandler({
        streamId: `checkout.sell-list-${owner.anonymousSellListId}`,
        command: {
          type: "AddSellListLine",
          sellerAccountId: owner.anonymousSellListId as never,
          lineId: `sll_${suffix}` as never,
          lineType: "product",
          offerId: null,
          listingId: null,
          buyerAccountId: null,
          buyerDisplayName: null,
          offerPriceAmount: null,
          catalogItemId: "cat_lifecycle",
          productId: "cat_lifecycle::raw",
          itemTitle: "Synthetic Item",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          quantity: 1,
          fallbackMode: "none",
          minimumListingPriceAmount: null,
        },
        context,
      });
    }
    const merge = { sourceOwnerId: owner.anonymousSellListId, targetAccountId };
    await expect(services.mergeSellListIntoAccount(merge, context)).rejects.toThrow(
      "synthetic second target write failure",
    );
    expect((await createSellerCheckoutReadinessReader(pools.fulfillment)(before.key)).label.status).toBe("blocked");
    expect((await shipping().readSetup(owner)).supportStatus).toBe("invalidated");
    await expect(shipping().saveSetup(owner, setup, context)).rejects.toThrow("invalidated");
    fail = false;
    expect((await runtime().mergeSellListIntoAccount(merge, context)).mergedLineCount).toBe(2);
    expect((await runtime().mergeSellListIntoAccount(merge, context)).mergedLineCount).toBe(0);
    expect((await shipping().readSetup({ kind: "account", accountId: targetAccountId })).setup).toBeNull();
    expect(
      (await real.readStream({ streamId: `checkout.sell-list-${targetAccountId}` })).map((event) => event.eventType),
    ).toEqual(["checkout.sell-list.line-added", "checkout.sell-list.line-added"]);
    console.log(
      "seller-checkout-durable-timing",
      JSON.stringify({
        before,
        after: await shipping().readSetup(owner),
        restart: await runtime().createReadinessSnapshot({
          sellerAccountId: owner.anonymousSellListId,
          shipFrom: setup.origin,
          label: { preference: setup.labelPreference },
        }),
      }),
    );
  });
});
