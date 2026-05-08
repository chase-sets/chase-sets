import { describe, expect, it } from "vitest";
import {
  isMarketplaceServiceWorkerExcludedPath,
  isMarketplaceServiceWorkerStaticAssetPath,
  marketplaceServiceWorkerPolicy,
  marketplaceServiceWorkerSource,
} from "./service-worker-source";

describe("marketplace service worker source", () => {
  it("keeps authenticated and transactional requests out of the offline cache", () => {
    expect(marketplaceServiceWorkerPolicy.excludedPathPrefixes).toEqual(
      expect.arrayContaining(["/api/", "/account", "/checkout", "/payment", "/orders"]),
    );
    expect(isMarketplaceServiceWorkerExcludedPath("/api/payments")).toBe(true);
    expect(isMarketplaceServiceWorkerExcludedPath("/checkout/payments/pay_1")).toBe(true);
    expect(isMarketplaceServiceWorkerExcludedPath("/search")).toBe(false);
  });

  it("uses network-first document navigation with the offline fallback", () => {
    expect(marketplaceServiceWorkerPolicy.offlineUrl).toBe("/offline");
    expect(marketplaceServiceWorkerPolicy.coreAssets).toContain("/offline");
    expect(isMarketplaceServiceWorkerStaticAssetPath("/assets/app.css")).toBe(true);
    expect(isMarketplaceServiceWorkerStaticAssetPath("/icons/chase-sets-192.png")).toBe(true);
    expect(isMarketplaceServiceWorkerStaticAssetPath("/account/payments/pay_1")).toBe(false);
    expect(marketplaceServiceWorkerSource).toContain(
      "fetch(event.request).catch(() => caches.match(OFFLINE_URL))",
    );
    expect(marketplaceServiceWorkerSource).not.toContain("skipWaiting");
  });
});
