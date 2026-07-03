import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildCatalogScopeRegistryProjectionHandlers } from "../read-model/projection";
import { getCatalogScopeRecord, listCatalogScopeRecords } from "../read-model/queries";

export type CatalogScopeRegistryRuntimeDeps = Readonly<{
  db: PgQueryable;
}>;

export function createCatalogScopeRegistryRuntime(deps: CatalogScopeRegistryRuntimeDeps) {
  return {
    listScopeRecords: (params?: Parameters<typeof listCatalogScopeRecords>[1]) =>
      listCatalogScopeRecords(deps.db, params),
    getScopeRecord: (scopeRecordId: string) => getCatalogScopeRecord(deps.db, scopeRecordId),
    projectors: [
      {
        projectionName: "catalog-scope-registry-projection",
        handlers: buildCatalogScopeRegistryProjectionHandlers(deps.db),
      },
    ] satisfies readonly ProjectionHandlerSet[],
  };
}
