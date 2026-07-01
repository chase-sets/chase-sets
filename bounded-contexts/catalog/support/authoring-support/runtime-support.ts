import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { CatalogAssetStorage } from "../../features/source-observations/api/asset-storage";
import type { SourceObservationTelemetry } from "../../features/source-observations/api/catalog-integration-observability";
import type { TcgplayerAutomationCatalogClient } from "../../features/source-observations/api/tcgplayer-automation-catalog-client";

export type CatalogRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  notificationWaiterPool?: PgTransactionalPool;
  assetStorage?: CatalogAssetStorage;
  tcgplayerAutomationCatalogClient?: TcgplayerAutomationCatalogClient;
  sourceObservationTelemetry?: SourceObservationTelemetry;
}>;
