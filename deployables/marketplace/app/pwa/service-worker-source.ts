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
  excludedExactPaths: ["/sign-in", "/sign-out", "/register"],
  excludedPathPrefixes: [
    "/api/",
    "/account",
    "/checkout",
    "/payment",
    "/payments",
    "/orders",
  ],
  staticAssetExactPaths: ["/favicon.svg", "/favicon.ico"],
  staticAssetPathPrefixes: ["/assets/", "/icons/"],
  staticAssetExtensions: [".woff", ".woff2"],
} as const;

export function isMarketplaceServiceWorkerExcludedPath(pathname: string) {
  return (
    marketplaceServiceWorkerPolicy.excludedExactPaths.includes(pathname as never) ||
    marketplaceServiceWorkerPolicy.excludedPathPrefixes.some((prefix) =>
      pathname.startsWith(prefix),
    )
  );
}

export function isMarketplaceServiceWorkerStaticAssetPath(pathname: string) {
  return (
    marketplaceServiceWorkerPolicy.staticAssetPathPrefixes.some((prefix) =>
      pathname.startsWith(prefix),
    ) ||
    marketplaceServiceWorkerPolicy.staticAssetExactPaths.includes(pathname as never) ||
    marketplaceServiceWorkerPolicy.staticAssetExtensions.some((extension) =>
      pathname.endsWith(extension),
    )
  );
}

const sourcePolicy = JSON.stringify(marketplaceServiceWorkerPolicy);

export const marketplaceServiceWorkerSource = String.raw`
const SERVICE_WORKER_POLICY = ${sourcePolicy};
const CACHE_NAME = SERVICE_WORKER_POLICY.cacheName;
const OFFLINE_URL = SERVICE_WORKER_POLICY.offlineUrl;
const CORE_ASSETS = SERVICE_WORKER_POLICY.coreAssets;

function isCredentialedRequest(request) {
  return request.headers.has("authorization") || request.headers.has("cookie");
}

function isExcludedPath(pathname) {
  return SERVICE_WORKER_POLICY.excludedExactPaths.includes(pathname) ||
    SERVICE_WORKER_POLICY.excludedPathPrefixes.some((prefix) => pathname.startsWith(prefix));
}

function shouldHandleFetch(event) {
  const request = event.request;

  if (request.method !== "GET" || isCredentialedRequest(request)) {
    return false;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin || isExcludedPath(url.pathname)) {
    return false;
  }

  return request.mode === "navigate";
}

function shouldHandleStaticAsset(event) {
  const request = event.request;

  if (request.method !== "GET" || isCredentialedRequest(request)) {
    return false;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin || isExcludedPath(url.pathname)) {
    return false;
  }

  return SERVICE_WORKER_POLICY.staticAssetPathPrefixes.some((prefix) =>
      url.pathname.startsWith(prefix)
    ) ||
    SERVICE_WORKER_POLICY.staticAssetExactPaths.includes(url.pathname) ||
    SERVICE_WORKER_POLICY.staticAssetExtensions.some((extension) =>
      url.pathname.endsWith(extension)
    );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName))
      )
    )
  );
});

self.addEventListener("fetch", (event) => {
  if (shouldHandleStaticAsset(event)) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) {
          return cached;
        }

        return fetch(event.request).then((response) => {
          if (!response || response.status !== 200) {
            return response;
          }

          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        });
      })
    );
    return;
  }

  if (!shouldHandleFetch(event)) {
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(OFFLINE_URL))
  );
});
`;
