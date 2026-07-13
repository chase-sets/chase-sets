import { describe, expect, it } from "vitest";
import { eventStoreEventsReadIndexStatements } from "./event-store-indexes";
import { eventCorePostgresSchemaSql } from "./schema";

describe("event-core Postgres schema", () => {
  it("keeps the global-position sequence uncached for gap-safe horizons", () => {
    expect(eventCorePostgresSchemaSql).toContain("ALTER SEQUENCE event_store_events_global_position_seq CACHE 1");
  });

  it("keeps event-store read indexes in the package-owned schema", () => {
    for (const statement of eventStoreEventsReadIndexStatements) {
      expect(eventCorePostgresSchemaSql).toContain(statement.boot);
      expect(statement.concurrent).toContain(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${statement.name}`);
    }

    expect(eventCorePostgresSchemaSql).not.toContain("CREATE INDEX CONCURRENTLY");
    expect(eventStoreEventsReadIndexStatements.map((statement) => statement.name)).toEqual([
      "event_store_events_stream_idx",
      "event_store_events_global_idx",
      "event_store_events_tenant_global_idx",
      "event_store_events_type_idx",
      "event_store_events_type_global_idx",
      "event_store_events_tenant_type_global_idx",
      "event_store_events_stream_prefix_global_idx",
      "event_store_events_context_category_type_global_idx",
      "event_store_events_context_category_global_idx",
    ]);
  });
});
