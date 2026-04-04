export { default as contextManifest } from "./context.json";
export * from "./common";
export * from "./ids";
export * from "./integration";
export * from "./authoring";

import { resolveContextApiMounts } from "@chase-sets/bounded-context-runtime";
import contextManifest from "./context.json";
import { buildCatalogAuthoringApi } from "./authoring";
import type { CatalogServices } from "./authoring";

export function resolveApiMounts(services: CatalogServices) {
  return resolveContextApiMounts(contextManifest.contextName, contextManifest.apiMounts, [
    buildCatalogAuthoringApi(services),
  ]);
}
