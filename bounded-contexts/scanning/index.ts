export { default as contextManifest } from "./context.json" with { type: "json" };
import { defineBoundedContextModule } from "@chase-sets/bounded-context-module";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import { eventCorePostgresSchemaSql } from "@chase-sets/event-core-postgres";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import contextManifest from "./context.json" with { type: "json" };
import { scanSessionSchemaSql } from "./features/scan-sessions/read-model/schema";
import { createScanSessionRuntime } from "./features/scan-sessions/api/runtime";

export type ScanningServices = Readonly<{
  scanSessions: ReturnType<typeof createScanSessionRuntime>;
  db: PgTransactionalPool;
  projectors: ReturnType<typeof createScanSessionRuntime>["projectors"];
}>;
export type ScanningHostPorts = Readonly<Record<string, never>>;

export const module = defineBoundedContextModule<ScanningServices, PgTransactionalPool, ScanningHostPorts>({
  manifest: contextManifest,
  schemaSql: [eventCorePostgresSchemaSql, scanSessionSchemaSql].join("\n"),
  createServices: (pool) => {
    const runtime = createScanSessionRuntime({
      eventStore: createPostgresEventStore({ pool, wakeNotifications: { enabled: false } }),
      db: pool,
    });
    return { scanSessions: runtime, db: pool, projectors: runtime.projectors };
  },
  buildApis: () => [],
  projectionHandlerSets: (services) => services.projectors,
});

export * from "./features/scan-sessions/domain/scan-session";
