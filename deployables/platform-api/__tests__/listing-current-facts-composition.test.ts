import { expect, it, vi } from "vitest";
import { module as marketplaceModule } from "@chase-sets/marketplace";
import type { module as identityModule } from "@chase-sets/identity";
import type { CatalogServices } from "@chase-sets/catalog/server";
import { createPlatformApiHost } from "../src/app";
import { createPlatformApiPools, closePlatformApiPools } from "../src/database-pools";

it("binds current readiness to the mounted Identity and Catalog owner APIs", async () => {
  const pools = createPlatformApiPools({
    runtimeProfile: "public",
    sharedDatabaseUrl: "postgresql://localhost/synthetic_unused",
    contextDatabaseUrls: {},
    port: 6182,
  });
  const create = marketplaceModule.createServices;
  const observed: { ports?: Parameters<typeof create>[1] } = {};
  const capture = vi.spyOn(marketplaceModule, "createServices").mockImplementation((pool, ports) => {
    observed.ports = ports;
    return create(pool, ports);
  });
  try {
    const runtime = createPlatformApiHost({ runtimeProfile: "public", pools, hostPorts: {} });
    const identity = runtime.services.identity as ReturnType<typeof identityModule.createServices>;
    const catalog = runtime.services.catalog as CatalogServices;
    const now = new Date().toISOString();
    const sellerFacts: Awaited<ReturnType<typeof identity.listingAuthority.readCurrentSeller>> = {
      value: { accountId: "acc_synthetic", active: true, badgeKeys: [] },
      generatedAt: now,
      validBefore: now,
    };
    const productFacts = { value: [], generatedAt: now, validBefore: now };
    const seller = vi.spyOn(identity.listingAuthority, "readCurrentSeller").mockResolvedValue(sellerFacts);
    const products = vi.spyOn(catalog.listingAuthority, "readCurrentProducts").mockResolvedValue(productFacts);
    const ports = observed.ports?.listingCurrentOwnerFacts;
    expect(ports).toBeDefined();
    expect(await ports!.seller("acc_synthetic")).toBe(sellerFacts);
    expect(await ports!.products([])).toBe(productFacts);
    expect(seller).toHaveBeenCalledExactlyOnceWith("acc_synthetic", { maxAgeMs: 1000 });
    expect(products).toHaveBeenCalledExactlyOnceWith([], { maxAgeMs: 1000 });
    Reflect.deleteProperty(runtime.services, "identity");
    expect(() => ports!.seller("acc_synthetic")).toThrow("not mounted");
  } finally {
    capture.mockRestore();
    await closePlatformApiPools(pools);
  }
});
