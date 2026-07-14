import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { buildCatalogMirrorProjectionHandlers, type PgQueryable } from "@chase-sets/event-core-postgres";

export function buildSavedListCatalogProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return buildCatalogMirrorProjectionHandlers(db, {
    tablePrefix: "collections_catalog",
    itemStatusTransitions: {
      published: "active",
      retired: "retired",
      archived: "missing",
    },
    refreshProductSchemaOnItemPublished: true,
    blueprintDraftStatusOnUpsert: false,
    optionalHandlers: { displayIdentityResolved: true },
  });
}
