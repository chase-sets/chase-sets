import { beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { module as channelsModule } from "@chase-sets/channels";
import { module as identityModule } from "@chase-sets/identity";
import { module as inventoryModule } from "@chase-sets/inventory";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import type { MarketplaceServices } from "@chase-sets/marketplace/server";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing/test-support";
import { buildPlatformApiApp, createPlatformApiHost } from "../src/app";
import {
  createPlatformApiBootstrapTestHarness,
  listingPhotoStorage,
  type PlatformApiTestPools,
} from "./bootstrap-db-test-support";

/**
 * This is the host-owned AC1/AC3 seam. The DB Profile capture must measure
 * this file after its real command cases are enrolled; this lane deliberately
 * does not manufacture a capture fixture or run a capture workflow.
 */
describe("listing channel activation real composition", () => {
  let pools: PlatformApiTestPools;

  createPlatformApiBootstrapTestHarness(
    "listing_channel_activation_10216",
    (state) => {
      pools = state.pools;
    },
    { activeContextNames: ["identity", "channels", "inventory", "marketplace"] },
  );

  beforeEach(async () => {
    await bootstrapContextDatabase(identityModule, pools.identity);
    await bootstrapContextDatabase(channelsModule, pools.channels);
    await bootstrapContextDatabase(inventoryModule, pools.inventory);
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
  });

  it("composes the real owner ports and committed target routes", () => {
    const runtime = createPlatformApiHost({
      pools,
      hostPorts: {
        capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
        processorGateway: createFakePaymentProcessorGateway(),
        listingPhotoStorage,
      },
    });
    const app = buildPlatformApiApp(runtime);
    const listings = (runtime.services.marketplace as MarketplaceServices).listings;
    expect(typeof listings.acceptListingTargetPrice).toBe("function");
    expect(typeof listings.activateListingForChannel).toBe("function");
    expect(typeof listings.readAcceptedListingTargetPrices).toBe("function");
    expect(app).toBeDefined();
  });

  it("fails closed before a missing listing can produce a business event", async () => {
    const runtime = createPlatformApiHost({
      pools,
      hostPorts: {
        capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
        processorGateway: createFakePaymentProcessorGateway(),
        listingPhotoStorage,
      },
    });
    const listings = (runtime.services.marketplace as MarketplaceServices).listings;
    await expect(
      listings.activateListingForChannel(
        {
          accountId: "acc_missing",
          listingId: "lst_missing",
          connectionId: "con_missing",
          expectedListingVersion: 1,
          expectedTargetPriceRevision: 1,
          allocationRevision: 1,
          idempotencyKey: "missing-listing-command",
        },
        {
          tenantId: "tnt_10216",
          audit: { performedByUserId: "usr_missing", forAccountId: "acc_missing" },
        } as never,
      ),
    ).rejects.toThrow();
  });
});
