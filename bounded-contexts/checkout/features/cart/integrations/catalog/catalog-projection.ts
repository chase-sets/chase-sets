import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildCatalogMirrorProjectionHandlers } from "@chase-sets/event-core-postgres/catalog-mirror";

export function buildCheckoutCatalogProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return buildCatalogMirrorProjectionHandlers(db, {
    tablePrefix: "checkout_catalog",
    optionalHandlers: { metadataRevised: true },
  });
}
