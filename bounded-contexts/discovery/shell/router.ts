import { useSyncExternalStore } from "react";

export interface MarketplaceRoute {
  page: "search" | "items";
  id?: string;
}

function parseHash(): MarketplaceRoute {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash || hash === "search") {
    return { page: "search" };
  }

  const [page, id] = hash.split("/");
  if (page === "items" && id) {
    return { page: "items", id };
  }

  return { page: "search" };
}

let currentRoute: MarketplaceRoute = typeof window === "undefined" ? { page: "search" } : parseHash();
const listeners = new Set<() => void>();
let routerInitialized = false;

function ensureRouterListener() {
  if (routerInitialized || typeof window === "undefined") {
    return;
  }

  window.addEventListener("hashchange", () => {
    currentRoute = parseHash();
    for (const listener of listeners) {
      listener();
    }
  });

  routerInitialized = true;
}

function subscribe(listener: () => void) {
  ensureRouterListener();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return currentRoute;
}

export function useMarketplaceRouter(): MarketplaceRoute {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
