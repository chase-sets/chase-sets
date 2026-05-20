import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { withCatalogAdminRealtimeInvalidation } from "./realtime-invalidation";

describe("catalog admin realtime invalidation", () => {
  it("records a projection patch after the wrapped projection handler updates the read model", async () => {
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("RETURNING outbox_id")) {
        return { rows: [{ outbox_id: "42" }] };
      }

      return { rows: [] };
    });
    const db = { query } satisfies PgQueryable;
    const handler = vi.fn(async () => {
      await db.query("UPDATE catalog_dimensions SET status = $1", ["active"]);
    });
    const handlers = withCatalogAdminRealtimeInvalidation(
      {
        "catalog.dimension.activated": handler,
      },
      db,
      {
        projectionName: "catalog-dimension-projection",
        surface: "dimensions",
      },
    );

    await handlers["catalog.dimension.activated"]?.({
      type: "catalog.dimension.activated",
      streamId: "catalog.dimension-dim_1",
      globalPosition: "9",
      streamPosition: "2",
      data: {},
      metadata: {},
      timing: {
        recordedAt: "2026-05-20T12:00:00.000Z",
      },
    });

    expect(handler).toHaveBeenCalledOnce();
    const sqlCalls = query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls[0]).toContain("UPDATE catalog_dimensions");
    expect(sqlCalls.some((sql) => sql.includes("INSERT INTO realtime_projection_outbox"))).toBe(true);

    const outboxCall = query.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO realtime_projection_outbox")
    );
    const values = outboxCall?.[1] as readonly unknown[];
    expect(values[1]).toBe("catalog-dimension-projection");
    expect(values[2]).toBe("dimensions:catalog.dimension-dim_1");
    expect(JSON.parse(String(values[4]))).toMatchObject({
      kind: "projection.patch",
      context: "catalog",
      projection: "catalog-dimension-projection",
      topics: ["catalog:admin:dimensions"],
      changes: [
        {
          op: "summary",
          entity: "catalog.adminProjection",
          id: "dimensions:catalog.dimension-dim_1",
        },
      ],
    });
  });
});
