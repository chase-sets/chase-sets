export type ServiceWorkerCredentialedRequestHandling = "allow" | "skip";

type WebLoaderArgs = Readonly<{
  request: Request;
}>;

export type ServiceWorkerPolicy = Readonly<{
  cacheName: string;
  offlineUrl: string;
  coreAssets: readonly string[];
  excludedExactPaths: readonly string[];
  excludedPathPrefixes: readonly string[];
  staticAssetExactPaths: readonly string[];
  staticAssetPathPrefixes: readonly string[];
  staticAssetExtensions: readonly string[];
  credentialedRequestHandling?: ServiceWorkerCredentialedRequestHandling;
}>;

export type WebManifestIcon = Readonly<{
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}>;

export type WebManifest = Readonly<{
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: "standalone";
  orientation: "any";
  categories: readonly string[];
  theme_color: string;
  background_color: string;
  icons: readonly WebManifestIcon[];
}>;

type ImportMetaWithEnv = ImportMeta & {
  env?: Readonly<{
    PROD?: boolean;
  }>;
};

export function registerAppServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }

  if (!isProductionBuild()) {
    return;
  }

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {
      // Service worker registration is a progressive enhancement.
    });
  });
}

export function isServiceWorkerExcludedPath(policy: ServiceWorkerPolicy, pathname: string) {
  return (
    policy.excludedExactPaths.includes(pathname) ||
    policy.excludedPathPrefixes.some((prefix) => pathname.startsWith(prefix))
  );
}

export function isServiceWorkerStaticAssetPath(policy: ServiceWorkerPolicy, pathname: string) {
  return (
    policy.staticAssetPathPrefixes.some((prefix) => pathname.startsWith(prefix)) ||
    policy.staticAssetExactPaths.includes(pathname) ||
    policy.staticAssetExtensions.some((extension) => pathname.endsWith(extension))
  );
}

export function buildServiceWorkerSource(policy: ServiceWorkerPolicy) {
  const sourcePolicy = JSON.stringify({
    ...policy,
    credentialedRequestHandling: policy.credentialedRequestHandling ?? "allow",
  });

  return String.raw`
const SERVICE_WORKER_POLICY = ${sourcePolicy};
const CACHE_NAME = SERVICE_WORKER_POLICY.cacheName;
const OFFLINE_URL = SERVICE_WORKER_POLICY.offlineUrl;
const CORE_ASSETS = SERVICE_WORKER_POLICY.coreAssets;

function isCredentialedRequest(request) {
  return request.headers.has("authorization") || request.headers.has("cookie");
}

function shouldSkipCredentialedRequest(request) {
  return SERVICE_WORKER_POLICY.credentialedRequestHandling === "skip" &&
    isCredentialedRequest(request);
}

function isExcludedPath(pathname) {
  return SERVICE_WORKER_POLICY.excludedExactPaths.includes(pathname) ||
    SERVICE_WORKER_POLICY.excludedPathPrefixes.some((prefix) => pathname.startsWith(prefix));
}

function shouldHandleNavigation(event) {
  const request = event.request;

  if (request.method !== "GET" || request.mode !== "navigate" || shouldSkipCredentialedRequest(request)) {
    return false;
  }

  const url = new URL(request.url);

  if (url.origin !== self.location.origin || isExcludedPath(url.pathname)) {
    return false;
  }

  return true;
}

function shouldHandleStaticAsset(event) {
  const request = event.request;

  if (request.method !== "GET" || shouldSkipCredentialedRequest(request)) {
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

  if (!shouldHandleNavigation(event)) {
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(OFFLINE_URL))
  );
});
`;
}

export function createWebManifestLoader(manifest: WebManifest | (() => WebManifest)) {
  return function loader(_args: WebLoaderArgs) {
    return Response.json(typeof manifest === "function" ? manifest() : manifest, {
      headers: {
        "Cache-Control": "public, max-age=3600",
        "Content-Type": "application/manifest+json; charset=utf-8",
      },
    });
  };
}

export function createServiceWorkerRoute(source: string | (() => string)) {
  return function loader(_args: WebLoaderArgs) {
    return new Response(typeof source === "function" ? source() : source, {
      headers: {
        "Cache-Control": "no-cache",
        "Content-Type": "application/javascript; charset=utf-8",
        "Service-Worker-Allowed": "/",
      },
    });
  };
}

function isProductionBuild() {
  const meta = import.meta as ImportMetaWithEnv;

  return meta.env?.PROD === true;
}
