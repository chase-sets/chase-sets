import { describe, expect, it } from "vitest";
import {
  buildServiceWorkerSource,
  createServiceWorkerRoute,
  createWebManifestLoader,
  isServiceWorkerExcludedPath,
  isServiceWorkerStaticAssetPath,
  type ServiceWorkerPolicy,
} from "./pwa";

const basePolicy = {
  cacheName: "chase-sets-test-pwa-v1",
  offlineUrl: "/offline",
  coreAssets: ["/offline"],
  excludedExactPaths: ["/sign-in"],
  excludedPathPrefixes: ["/api/"],
  staticAssetExactPaths: ["/favicon.svg"],
  staticAssetPathPrefixes: ["/assets/"],
  staticAssetExtensions: [".woff2"],
} as const satisfies ServiceWorkerPolicy;

describe("pwa helpers", () => {
  it("classifies excluded and static asset paths from app policy", () => {
    expect(isServiceWorkerExcludedPath(basePolicy, "/api/items")).toBe(true);
    expect(isServiceWorkerExcludedPath(basePolicy, "/sign-in")).toBe(true);
    expect(isServiceWorkerExcludedPath(basePolicy, "/search")).toBe(false);
    expect(isServiceWorkerStaticAssetPath(basePolicy, "/assets/app.css")).toBe(true);
    expect(isServiceWorkerStaticAssetPath(basePolicy, "/favicon.svg")).toBe(true);
    expect(isServiceWorkerStaticAssetPath(basePolicy, "/fonts/app.woff2")).toBe(true);
    expect(isServiceWorkerStaticAssetPath(basePolicy, "/api/items")).toBe(false);
  });

  it("keeps marketplace credential skipping as an explicit service worker policy", () => {
    const source = buildServiceWorkerSource({
      ...basePolicy,
      credentialedRequestHandling: "skip",
    });

    expect(source).toContain('"credentialedRequestHandling":"skip"');
    expect(source).toContain('SERVICE_WORKER_POLICY.credentialedRequestHandling === "skip"');
    expect(source).toContain("shouldSkipCredentialedRequest(request)");
    expect(source).toContain("fetch(event.request).catch(() => caches.match(OFFLINE_URL))");
    expect(source).not.toContain("skipWaiting");
  });

  it("keeps admin navigation handling without credential skipping by default", () => {
    const source = buildServiceWorkerSource(basePolicy);

    expect(source).toContain('"credentialedRequestHandling":"allow"');
    expect(source).toContain('request.mode !== "navigate"');
    expect(source).toContain("shouldHandleNavigation(event)");
    expect(source).toContain("shouldHandleStaticAsset(event)");
  });

  it("builds manifest and service worker route loaders", async () => {
    const manifestLoader = createWebManifestLoader({
      name: "Chase Sets Test",
      short_name: "CS Test",
      description: "Test manifest",
      start_url: "/",
      scope: "/",
      display: "standalone",
      orientation: "any",
      categories: ["productivity"],
      theme_color: "#000000",
      background_color: "#ffffff",
      icons: [],
    });
    const manifest = manifestLoader({ request: new Request("https://example.test/manifest.webmanifest") });

    expect(manifest.headers.get("Content-Type")).toContain("application/manifest+json");
    await expect(manifest.json()).resolves.toMatchObject({ name: "Chase Sets Test" });

    const serviceWorkerLoader = createServiceWorkerRoute("self.addEventListener('fetch', () => undefined);");
    const serviceWorker = serviceWorkerLoader({ request: new Request("https://example.test/service-worker.js") });

    expect(serviceWorker.headers.get("Service-Worker-Allowed")).toBe("/");
    expect(serviceWorker.headers.get("Content-Type")).toContain("application/javascript");
    await expect(serviceWorker.text()).resolves.toContain("fetch");
  });
});
