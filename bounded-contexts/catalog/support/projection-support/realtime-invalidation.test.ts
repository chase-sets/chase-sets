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
    } as never);

    expect(handler).toHaveBeenCalledOnce();
    const sqlCalls = query.mock.calls.map(([sql]) => sql);
    expect(sqlCalls[0]).toContain("UPDATE catalog_dimensions");
    expect(sqlCalls.some((sql) => sql.includes("INSERT INTO realtime_projection_outbox"))).toBe(true);

    const outboxCall = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO realtime_projection_outbox"));
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

  it("forwards projection handler context and writes invalidation through the transaction db", async () => {
    const baseQuery = vi.fn(async () => ({ rows: [] }));
    const txQuery = vi.fn(async (sql: string) => ({
      rows: sql.includes("RETURNING outbox_id") ? [{ outbox_id: "42" }] : [],
    }));
    const db = { query: baseQuery } satisfies PgQueryable;
    const txDb = { query: txQuery } satisfies PgQueryable;
    const handler = vi.fn(async (_event, context) => {
      await context?.db?.query("UPDATE catalog_dimensions SET status = $1", ["active"]);
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

    await handlers["catalog.dimension.activated"]?.(
      {
        type: "catalog.dimension.activated",
        streamId: "catalog.dimension-dim_1",
        globalPosition: "9",
        streamPosition: "2",
        data: {},
        metadata: {},
        timing: {
          recordedAt: "2026-05-20T12:00:00.000Z",
        },
      } as never,
      { db: txDb as never },
    );

    expect(handler).toHaveBeenCalledWith(expect.any(Object), { db: txDb });
    expect(baseQuery).not.toHaveBeenCalled();
    expect(txQuery.mock.calls.map(([sql]) => sql)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("UPDATE catalog_dimensions"),
        expect.stringContaining("INSERT INTO realtime_projection_outbox"),
      ]),
    );
  });

  it("can suppress invalidation for an intermediate projection event", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const db = { query } satisfies PgQueryable;
    const handler = vi.fn(async () => undefined);
    const handlers = withCatalogAdminRealtimeInvalidation({ "catalog.source.chunk": handler }, db, {
      projectionName: "catalog-source-observation-projection",
      surface: "source-observations",
      shouldInvalidate: (_eventType, event) => (event.data as { final: boolean }).final,
    });

    await handlers["catalog.source.chunk"]?.({
      type: "catalog.source.chunk",
      streamId: "catalog.source-observation-obs_1",
      globalPosition: "9",
      streamPosition: "2",
      data: { final: false },
      metadata: {},
      timing: { recordedAt: "2026-05-20T12:00:00.000Z" },
    } as never);

    expect(handler).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
  });
});
