export { default as contextManifest } from "./context.json";

import { defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json";
import type { CollectionsHostPorts, CollectionsServices } from "./support/runtime-support/services";
import { createCollectionsServices } from "./support/runtime-support/services";
import { collectionsSchemaSql } from "./support/runtime-support/schema";

export const module = defineBoundedContextModule<CollectionsServices, PgTransactionalPool, CollectionsHostPorts>({
  manifest: contextManifest,
  schemaSql: collectionsSchemaSql,
  createServices: (pool, ports) => createCollectionsServices(pool, ports),
  buildApis: () => [],
});
