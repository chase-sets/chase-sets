import { createPostgresEventStore, createPostgresProjectionStore } from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createAuthenticityCaseRuntime } from "../../features/cases/api/runtime";
import {
  createPlatformOperatedFacilityDirectory,
  type AuthenticityFacilityConfig,
  type AuthenticityFacilityDirectoryPort,
} from "./facility-directory";

const DEFAULT_PLATFORM_FACILITY_CONFIG: AuthenticityFacilityConfig = {
  facilityId: "facility_platform_1",
  operatingIdentity: "Chase Sets Authenticity Facility",
  address: {
    name: "Chase Sets Authenticity Facility",
    line1: "Configured by platform operations",
    city: "Chicago",
    state: "IL",
    postalCode: "60601",
    country: "US",
  },
};

export type AuthenticityServices = Readonly<{
  cases: ReturnType<typeof createAuthenticityCaseRuntime>;
  facilityDirectory: AuthenticityFacilityDirectoryPort;
  projectors: readonly ProjectionHandlerSet[];
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

export type AuthenticityHostPorts = Readonly<{
  facilityDirectory?: AuthenticityFacilityDirectoryPort;
}>;

export function createAuthenticityServices(
  pool: PgTransactionalPool,
  ports: AuthenticityHostPorts = {},
): AuthenticityServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "authenticity" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const deps = { eventStore, checkpointStore, db } as const;

  const cases = createAuthenticityCaseRuntime(deps);
  const facilityDirectory =
    ports.facilityDirectory ?? createPlatformOperatedFacilityDirectory(DEFAULT_PLATFORM_FACILITY_CONFIG);

  return {
    cases,
    facilityDirectory,
    projectors: [...cases.projectors],
    pool,
    db,
  };
}
