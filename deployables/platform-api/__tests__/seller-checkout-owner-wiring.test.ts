import { describe, expect, it, vi } from "vitest";
import { module as checkoutModule } from "@chase-sets/checkout";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createPlatformApiHost } from "../src/app";
import { closePlatformApiPools, createPlatformApiPools } from "../src/database-pools";

describe("seller checkout production owner host port", () => {
  it("passes manifest-selected readers into Checkout using the real, distinct owner pools", async () => {
    const pools = createPlatformApiPools({
      runtimeProfile: "public",
      sharedDatabaseUrl: "postgresql://localhost/synthetic_never_connected",
      contextDatabaseUrls: {
        checkout: "postgresql://localhost/synthetic_checkout_never_connected",
        fulfillment: "postgresql://localhost/synthetic_fulfillment_never_connected",
        settlement: "postgresql://localhost/synthetic_settlement_never_connected",
      },
      port: 6182,
    });
    const checkout = pools.checkout as PgTransactionalPool;
    const fulfillment = pools.fulfillment as PgTransactionalPool;
    const settlement = pools.settlement as PgTransactionalPool;
    expect(checkout).not.toBe(fulfillment);
    expect(checkout).not.toBe(settlement);
    const checkoutQuery = vi.spyOn(checkout, "query").mockResolvedValue({ rows: [] });
    const fulfillmentQuery = vi.spyOn(fulfillment, "query").mockResolvedValue({ rows: [] });
    const settlementQuery = vi.spyOn(settlement, "query").mockResolvedValue({ rows: [] });
    const create = vi.spyOn(checkoutModule, "createServices");
    try {
      const host = createPlatformApiHost({
        runtimeProfile: "public",
        pools,
        hostPorts: { capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" } },
      });
      const services = host.services.checkout;
      expect(services).toBeDefined();
      expect(create).toHaveBeenCalledTimes(1);
      const call = create.mock.calls[0];
      const owners = call?.[1]?.sellerCheckoutOwners;
      expect(owners).toBeDefined();
      if (!owners) throw new Error("Manifest omitted sellerCheckoutOwners");
      const owner = { kind: "account", accountId: "acc_synthetic_owner" } as const;
      expect((await owners.readRisk(owner)).rowState).toBe("absent");
      await owners.resolveOrigin(owner, {
        origin: {
          name: "Synthetic",
          line1: "1 Main St",
          line2: null,
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          country: "US",
        },
        labelPreference: "prepaid-label",
      });
      await owners.readFulfillment({ owner, shipFromLocationId: "sfl_synthetic", labelPreference: "prepaid-label" });
      expect(settlementQuery).toHaveBeenCalledWith(expect.stringContaining("settlement_account_risk_sources"), [
        owner.accountId,
      ]);
      expect(fulfillmentQuery).toHaveBeenCalledWith(expect.stringContaining("WHERE s.stream_id"), [
        "fulfillment.seller-shipping-account:acc_synthetic_owner",
      ]);
      expect(checkoutQuery).not.toHaveBeenCalled();
      expect(settlementQuery).toHaveBeenCalledTimes(1);
      expect(fulfillmentQuery).toHaveBeenCalledTimes(2);
    } finally {
      create.mockRestore();
      checkoutQuery.mockRestore();
      fulfillmentQuery.mockRestore();
      settlementQuery.mockRestore();
      await closePlatformApiPools(pools);
    }
  });
});
