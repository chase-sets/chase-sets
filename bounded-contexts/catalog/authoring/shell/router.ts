import { useSyncExternalStore } from "react";

export type CatalogAdminRoute = {
  entity: string;
  id?: string;
};

function parseHash(): CatalogAdminRoute {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash) {
    return { entity: "dimensions" };
  }

  const [entity, id] = hash.split("/");
  return { entity, id };
}

let currentRoute = typeof window === "undefined" ? { entity: "dimensions" } : parseHash();
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

export function useCatalogAdminRouter(): CatalogAdminRoute {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
