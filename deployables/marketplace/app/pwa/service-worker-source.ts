import {
  buildServiceWorkerSource,
  isServiceWorkerExcludedPath,
  isServiceWorkerStaticAssetPath,
  type ServiceWorkerPolicy,
} from "@chase-sets/platform-runtime/pwa";

export const marketplaceServiceWorkerPolicy = {
  cacheName: "chase-sets-marketplace-pwa-v1",
  offlineUrl: "/offline",
  coreAssets: [
    "/offline",
    "/icons/chase-sets-192.png",
    "/icons/chase-sets-512.png",
    "/icons/chase-sets-maskable-192.png",
    "/icons/chase-sets-maskable-512.png",
  ],
  excludedExactPaths: ["/guest-checkout/exit", "/sign-in", "/sign-out", "/register"],
  excludedPathPrefixes: ["/api/", "/account", "/checkout", "/payment", "/payments", "/orders"],
  staticAssetExactPaths: ["/favicon.svg", "/favicon.ico"],
  staticAssetPathPrefixes: ["/assets/", "/icons/"],
  staticAssetExtensions: [".woff", ".woff2"],
  credentialedRequestHandling: "skip",
} as const satisfies ServiceWorkerPolicy;

export function isMarketplaceServiceWorkerExcludedPath(pathname: string) {
  return isServiceWorkerExcludedPath(marketplaceServiceWorkerPolicy, pathname);
}

export function isMarketplaceServiceWorkerStaticAssetPath(pathname: string) {
  return isServiceWorkerStaticAssetPath(marketplaceServiceWorkerPolicy, pathname);
}

export const marketplaceServiceWorkerSource = buildServiceWorkerSource(marketplaceServiceWorkerPolicy);
