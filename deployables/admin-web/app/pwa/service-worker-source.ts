import {
  buildServiceWorkerSource,
  isServiceWorkerExcludedPath,
  isServiceWorkerStaticAssetPath,
  type ServiceWorkerPolicy,
} from "@chase-sets/platform-runtime/pwa";

export const adminServiceWorkerPolicy = {
  cacheName: "chase-sets-admin-pwa-v1",
  offlineUrl: "/offline",
  coreAssets: [
    "/offline",
    "/icons/chase-sets-admin-192.png",
    "/icons/chase-sets-admin-512.png",
    "/icons/chase-sets-admin-maskable-192.png",
    "/icons/chase-sets-admin-maskable-512.png",
  ],
  excludedExactPaths: [
    "/sign-in",
    "/sign-out",
    "/account-select",
    "/access/sign-in",
    "/access/sign-out",
    "/access/account-select",
  ],
  excludedPathPrefixes: ["/api/", "/health/"],
  staticAssetExactPaths: ["/favicon.svg", "/favicon.ico"],
  staticAssetPathPrefixes: ["/assets/", "/icons/"],
  staticAssetExtensions: [".woff", ".woff2"],
  credentialedRequestHandling: "allow",
} as const satisfies ServiceWorkerPolicy;

export function isAdminServiceWorkerExcludedPath(pathname: string) {
  return isServiceWorkerExcludedPath(adminServiceWorkerPolicy, pathname);
}

export function isAdminServiceWorkerStaticAssetPath(pathname: string) {
  return isServiceWorkerStaticAssetPath(adminServiceWorkerPolicy, pathname);
}

export const adminServiceWorkerSource = buildServiceWorkerSource(adminServiceWorkerPolicy);
