import { describe, expect, it } from "vitest";
import { marketplaceServiceWorkerSource } from "./service-worker-source";

describe("marketplace service worker source", () => {
  it("keeps authenticated and transactional requests out of the offline cache", () => {
    expect(marketplaceServiceWorkerSource).toContain('request.method !== "GET"');
    expect(marketplaceServiceWorkerSource).toContain('request.headers.has("authorization")');
    expect(marketplaceServiceWorkerSource).toContain('request.headers.has("cookie")');
    expect(marketplaceServiceWorkerSource).toContain('pathname.startsWith("/api/")');
    expect(marketplaceServiceWorkerSource).toContain('pathname.startsWith("/account")');
    expect(marketplaceServiceWorkerSource).toContain('pathname.startsWith("/checkout")');
    expect(marketplaceServiceWorkerSource).toContain('pathname.startsWith("/payment")');
    expect(marketplaceServiceWorkerSource).toContain('pathname.startsWith("/orders")');
  });

  it("uses network-first document navigation with the offline fallback", () => {
    expect(marketplaceServiceWorkerSource).toContain('request.mode === "navigate"');
    expect(marketplaceServiceWorkerSource).toContain('const OFFLINE_URL = "/offline"');
    expect(marketplaceServiceWorkerSource).toContain('url.pathname.startsWith("/assets/")');
    expect(marketplaceServiceWorkerSource).toContain('url.pathname.startsWith("/icons/")');
    expect(marketplaceServiceWorkerSource).toContain(
      "fetch(event.request).catch(() => caches.match(OFFLINE_URL))",
    );
    expect(marketplaceServiceWorkerSource).not.toContain("skipWaiting");
  });
});
