import { useSyncExternalStore } from "react";

export interface Route {
  page: "search" | "items";
  id?: string;
}

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash || hash === "search") return { page: "search" };
  const parts = hash.split("/");
  if (parts[0] === "items" && parts[1]) {
    return { page: "items", id: parts[1] };
  }
  return { page: "search" };
}

let currentRoute = parseHash();
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return currentRoute;
}

window.addEventListener("hashchange", () => {
  currentRoute = parseHash();
  for (const cb of listeners) cb();
});

export function useHashRouter(): Route {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function navigate(path: string) {
  window.location.hash = path;
}
