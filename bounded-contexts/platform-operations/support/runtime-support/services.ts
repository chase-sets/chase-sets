import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  createReleaseControlsPolicyRuntime,
  type ReleaseControlsPolicyServices,
} from "../../features/release-controls/api/runtime";

export type PlatformOperationsServices = Readonly<{
  db: PgTransactionalPool;
  releaseControls: ReleaseControlsPolicyServices;
}>;

export function createPlatformOperationsServices(pool: PgTransactionalPool): PlatformOperationsServices {
  const eventStore = createPostgresEventStore({ pool });

  return {
    db: pool,
    releaseControls: createReleaseControlsPolicyRuntime({ eventStore }),
  };
}
