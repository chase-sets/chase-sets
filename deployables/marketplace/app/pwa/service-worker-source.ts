export const marketplaceServiceWorkerSource = String.raw`
const CACHE_NAME = "chase-sets-marketplace-pwa-v1";
const OFFLINE_URL = "/offline";
const CORE_ASSETS = [
  OFFLINE_URL,
  "/icons/chase-sets-192.png",
  "/icons/chase-sets-512.png",
  "/icons/chase-sets-maskable-192.png",
  "/icons/chase-sets-maskable-512.png"
];

function isCredentialedRequest(request) {
  return request.headers.has("authorization") || request.headers.has("cookie");
}

function isExcludedPath(pathname) {
  return pathname.startsWith("/api/") ||
    pathname === "/sign-in" ||
    pathname === "/sign-out" ||
    pathname === "/register" ||
    pathname.startsWith("/account") ||
    pathname.startsWith("/checkout") ||
    pathname.startsWith("/payment") ||
    pathname.startsWith("/payments") ||
    pathname.startsWith("/orders");
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

  return url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/favicon.svg" ||
    url.pathname === "/favicon.ico" ||
    url.pathname.endsWith(".woff") ||
    url.pathname.endsWith(".woff2");
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
