import { describe, expect, it } from "vitest";
import { createPostgresEventStore } from "./event-store";
import { withPgTransaction } from "./types";

describe("postgres event store", () => {
  it("pushes readAll event type and stream prefix filters into SQL", async () => {
    const queries: { sql: string; params: readonly unknown[] }[] = [];
    const store = createPostgresEventStore({
      pool: {
        query: async (sql: string, params: readonly unknown[] = []) => {
          queries.push({ sql, params });
          return { rows: [] };
        },
      } as never,
    });

    await store.readAll({
      afterGlobalPosition: "42" as never,
      tenantId: "tenant_1" as never,
      eventTypes: ["catalog.catalog-item.published", "catalog.catalog-item.published"],
      streamPrefixes: ["catalog.item-", "catalog.category-"],
      limit: 25,
    });

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("global_position > $1::bigint");
    expect(queries[0].sql).toContain("tenant_id = $2");
    expect(queries[0].sql).toContain("event_type = ANY($3::text[])");
    expect(queries[0].sql).toContain("(stream_id LIKE $4 || '%' OR stream_id LIKE $5 || '%')");
    expect(queries[0].sql).toContain("LIMIT $6");
    expect(queries[0].params).toEqual([
      "42",
      "tenant_1",
      ["catalog.catalog-item.published"],
      "catalog.item-",
      "catalog.category-",
      25,
    ]);
  });
});

describe("postgres transaction helper", () => {
  it("commits successful work and releases the client", async () => {
    const queries: string[] = [];
    let released = false;
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => {
        released = true;
      },
    };

    await expect(
      withPgTransaction(
        {
          query: client.query,
          connect: async () => client,
        },
        async (tx) => {
          await tx.query("SELECT 1");
          return "ok";
        },
      ),
    ).resolves.toBe("ok");

    expect(queries).toEqual(["BEGIN", "SELECT 1", "COMMIT"]);
    expect(released).toBe(true);
  });

  it("rolls back failed work and releases the client", async () => {
    const queries: string[] = [];
    let released = false;
    const client = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
      release: () => {
        released = true;
      },
    };

    await expect(
      withPgTransaction(
        {
          query: client.query,
          connect: async () => client,
        },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");

    expect(queries).toEqual(["BEGIN", "ROLLBACK"]);
    expect(released).toBe(true);
  });
});
