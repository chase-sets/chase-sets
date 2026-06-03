import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogAssetStorage } from "../../features/source-observations/api/asset-storage";
import type { TcgplayerAutomationCatalogClient } from "../../features/source-observations/api/tcgplayer-automation-catalog-client";

export type CatalogRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  assetStorage?: CatalogAssetStorage;
  tcgplayerAutomationCatalogClient?: TcgplayerAutomationCatalogClient;
}>;
