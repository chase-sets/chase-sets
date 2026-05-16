import { describe, expect, it } from "vitest";
import {
  adminServiceWorkerPolicy,
  adminServiceWorkerSource,
  isAdminServiceWorkerExcludedPath,
  isAdminServiceWorkerStaticAssetPath,
} from "./service-worker-source";

describe("admin service worker source", () => {
  it("keeps admin APIs and auth journey routes out of service worker handling", () => {
    expect(adminServiceWorkerPolicy.excludedPathPrefixes).toEqual(
      expect.arrayContaining(["/api/", "/health/"]),
    );
    expect(isAdminServiceWorkerExcludedPath("/api/catalog/items")).toBe(true);
    expect(isAdminServiceWorkerExcludedPath("/sign-out")).toBe(true);
    expect(isAdminServiceWorkerExcludedPath("/catalog-items")).toBe(false);
  });

  it("uses an offline fallback without caching admin document responses", () => {
    expect(adminServiceWorkerPolicy.offlineUrl).toBe("/offline");
    expect(adminServiceWorkerPolicy.coreAssets).toContain("/offline");
    expect(isAdminServiceWorkerStaticAssetPath("/assets/app.css")).toBe(true);
    expect(isAdminServiceWorkerStaticAssetPath("/icons/chase-sets-admin-192.png")).toBe(
      true,
    );
    expect(isAdminServiceWorkerStaticAssetPath("/api/catalog/items")).toBe(false);
    expect(adminServiceWorkerSource).toContain(
      "fetch(event.request).catch(() => caches.match(OFFLINE_URL))",
    );
    expect(adminServiceWorkerSource).not.toContain("skipWaiting");
  });
});
