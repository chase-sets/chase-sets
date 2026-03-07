import { useState, useEffect, useSyncExternalStore } from "react";

export interface Route {
  entity: string;
  id?: string;
}

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (!hash) return { entity: "dimensions" };
  const [entity, id] = hash.split("/");
  return { entity, id };
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
