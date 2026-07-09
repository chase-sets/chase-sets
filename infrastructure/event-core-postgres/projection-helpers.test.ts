import { describe, expect, it } from "vitest";
import type { PgQueryable } from "./types";
import {
  appendJsonbArrayElement,
  patchJsonbArrayElement,
  removeJsonbArrayElement,
  replaceJsonbArrayElement,
  refreshAffectedRows,
  runBoundedProjectionCascade,
  runInProjectionCascadeContext,
  transitionStatus,
  updateRow,
  upsertRow,
  type ProjectionCascadeController,
  type ProjectionCascadeCursor,
} from "./projection-helpers";

const NOW = "2026-06-12T12:00:00.000Z";

type QueryCall = Readonly<{
  sql: string;
  values: readonly unknown[];
}>;

describe("projection helpers", () => {
  it("builds a const-column upsert and serializes JSONB values", async () => {
    const { db, calls } = recordingDb([{ contact_methods: [] }]);

    await expect(
      upsertRow(db, {
        table: "auth_identity_users",
        insertColumns: ["user_id", "contact_methods", "updated_at"],
        conflictColumns: ["user_id"],
        updateColumns: ["contact_methods", "updated_at"],
        values: {
          user_id: "usr_1",
          contact_methods: [{ contactMethodId: "cm_1" }],
          updated_at: NOW,
        },
        casts: { contact_methods: "jsonb" },
        returning: ["contact_methods"],
      }),
    ).resolves.toEqual({ rows: [{ contact_methods: [] }], rowCount: 1 });

    expect(calls).toEqual([
      {
        sql: normalizeSql(
          `INSERT INTO auth_identity_users (user_id, contact_methods, updated_at)
           VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (user_id) DO UPDATE
           SET contact_methods = EXCLUDED.contact_methods, updated_at = EXCLUDED.updated_at
           RETURNING contact_methods`,
        ),
        values: ["usr_1", JSON.stringify([{ contactMethodId: "cm_1" }]), NOW],
      },
    ]);
  });

  it("supports keyed updates with JSONB casts and returning rows", async () => {
    const { db, calls } = recordingDb([{ contact_methods: [{ contactMethodId: "cm_1" }] }]);

    await updateRow(db, {
      table: "auth_identity_users",
      setColumns: ["display_name", "contact_methods"],
      values: {
        display_name: "Test User",
        contact_methods: [{ contactMethodId: "cm_1" }],
      },
      casts: { contact_methods: "jsonb" },
      where: {
        columns: ["user_id"],
        values: { user_id: "usr_1" },
      },
      returning: ["contact_methods"],
    });

    expect(calls).toEqual([
      {
        sql: normalizeSql(
          `UPDATE auth_identity_users
           SET display_name = $1, contact_methods = $2::jsonb
           WHERE user_id = $3
           RETURNING contact_methods`,
        ),
        values: ["Test User", JSON.stringify([{ contactMethodId: "cm_1" }]), "usr_1"],
      },
    ]);
  });

  it("reads affected row ids and refreshes each selected id", async () => {
    const { db, calls } = recordingDb([{ catalog_item_id: "item_1" }, { catalog_item_id: "item_2" }]);
    const refreshed: string[] = [];

    await expect(
      refreshAffectedRows(db, {
        select: { column: "catalog_item_id" },
        from: { table: "discovery_search_catalog_items" },
        where: [{ column: "category_ids", operator: "@>", cast: "jsonb", value: ["cat_1"] }],
        orderBy: [{ column: "catalog_item_id" }],
        refresh: async (id) => {
          refreshed.push(id);
        },
      }),
    ).resolves.toEqual(["item_1", "item_2"]);

    expect(calls).toEqual([
      {
        sql: normalizeSql(
          `SELECT catalog_item_id AS catalog_item_id
           FROM discovery_search_catalog_items
           WHERE category_ids @> $1::jsonb
           ORDER BY catalog_item_id ASC`,
        ),
        values: [JSON.stringify(["cat_1"])],
      },
    ]);
    expect(refreshed).toEqual(["item_1", "item_2"]);
  });

  it("refreshes affected rows serially for single-client projection safety", async () => {
    const { db } = recordingDb([{ catalog_item_id: "item_1" }, { catalog_item_id: "item_2" }]);
    let activeRefreshes = 0;
    let maxActiveRefreshes = 0;

    await refreshAffectedRows(db, {
      select: { column: "catalog_item_id" },
      from: { table: "discovery_search_catalog_items" },
      refresh: async () => {
        activeRefreshes += 1;
        maxActiveRefreshes = Math.max(maxActiveRefreshes, activeRefreshes);
        await Promise.resolve();
        activeRefreshes -= 1;
      },
    });

    expect(maxActiveRefreshes).toBe(1);
  });

  it("checks cancellation before and between affected row refreshes", async () => {
    const { db } = recordingDb([{ catalog_item_id: "item_1" }, { catalog_item_id: "item_2" }]);
    const refreshed: string[] = [];
    let checks = 0;

    await refreshAffectedRows(db, {
      select: { column: "catalog_item_id" },
      from: { table: "discovery_search_catalog_items" },
      throwIfCancelled: () => {
        checks += 1;
      },
      refresh: async (id) => {
        refreshed.push(id);
      },
    });

    expect(checks).toBe(4);
    expect(refreshed).toEqual(["item_1", "item_2"]);
  });

  it("builds affected-row reads with structured joins and aliases", async () => {
    const { db, calls } = recordingDb([{ catalog_item_id: "item_1" }]);

    await refreshAffectedRows(db, {
      select: { tableAlias: "item", column: "catalog_item_id", distinct: true },
      from: { table: "discovery_search_catalog_items", alias: "item" },
      joins: [
        {
          table: "discovery_search_catalog_blueprint_dimensions",
          alias: "rule",
          on: [
            {
              left: { tableAlias: "rule", column: "blueprint_id" },
              right: { tableAlias: "item", column: "blueprint_id" },
            },
          ],
        },
      ],
      where: [{ tableAlias: "rule", column: "dimension_id", value: "dim_1" }],
      refresh: async () => undefined,
    });

    expect(calls).toEqual([
      {
        sql: normalizeSql(
          `SELECT DISTINCT item.catalog_item_id AS catalog_item_id
           FROM discovery_search_catalog_items AS item
           INNER JOIN discovery_search_catalog_blueprint_dimensions AS rule
             ON rule.blueprint_id = item.blueprint_id
           WHERE rule.dimension_id = $1`,
        ),
        values: ["dim_1"],
      },
    ]);
  });

  it("can derive multiple affected ids from each selected row", async () => {
    const { db, calls } = recordingDb([{ category_ids: ["cat_1", "cat_2"] }]);
    const refreshed: string[] = [];

    await refreshAffectedRows(db, {
      select: { column: "category_ids" },
      from: { table: "discovery_category_catalog_items" },
      where: [{ column: "catalog_item_id", value: "item_1" }],
      idsFromRow: (row) => (Array.isArray(row.category_ids) ? row.category_ids.filter(isString) : []),
      refresh: async (id) => {
        refreshed.push(id);
      },
    });

    expect(calls).toEqual([
      {
        sql: normalizeSql(
          `SELECT category_ids AS category_ids
           FROM discovery_category_catalog_items
           WHERE catalog_item_id = $1`,
        ),
        values: ["item_1"],
      },
    ]);
    expect(refreshed).toEqual(["cat_1", "cat_2"]);
  });

  it("expresses status transitions as a narrow keyed update", async () => {
    const { db, calls } = recordingDb();

    await transitionStatus(db, {
      table: "auth_identity_accounts",
      idColumn: "account_id",
      id: "acc_1",
      status: "suspended",
      updatedAt: NOW,
    });

    expect(calls).toEqual([
      {
        sql: normalizeSql(
          `UPDATE auth_identity_accounts
           SET status = $1, updated_at = $2
           WHERE account_id = $3`,
        ),
        values: ["suspended", NOW, "acc_1"],
      },
    ]);
  });

  it("appends JSONB elements atomically and can return the updated column", async () => {
    const { db, calls } = recordingDb([{ auth_methods: ["password"] }]);

    await appendJsonbArrayElement(db, {
      table: "auth_identity_users",
      key: { column: "user_id", value: "usr_1" },
      column: "auth_methods",
      element: "password",
      unique: true,
      orderBy: [{ kind: "text" }],
      updatedAt: { value: NOW },
      returning: ["auth_methods"],
    });

    expect(calls).toEqual([
      {
        sql: normalizeSql(
          `UPDATE auth_identity_users
           SET auth_methods = (
             SELECT COALESCE(jsonb_agg(projected.value ORDER BY projected.value #>> '{}' ASC), '[]'::jsonb)
             FROM (
               SELECT candidate.value, MIN(candidate.ordinal) AS ordinal
               FROM jsonb_array_elements(auth_methods || jsonb_build_array($1::jsonb)) WITH ORDINALITY AS candidate(value, ordinal)
               GROUP BY candidate.value
             ) AS projected(value, ordinal)
           ),
           updated_at = $2
           WHERE user_id = $3
           RETURNING auth_methods`,
        ),
        values: [JSON.stringify("password"), NOW, "usr_1"],
      },
    ]);
  });

  it("removes JSONB elements by path match", async () => {
    const { db, calls } = recordingDb();

    await removeJsonbArrayElement(db, {
      table: "discovery_search_catalog_items",
      key: { column: "catalog_item_id", value: "cat_1" },
      column: "field_values",
      match: { kind: "pathText", path: ["fieldId"], value: "fld_1" },
      updatedAt: { value: NOW },
    });

    expect(calls).toEqual([
      {
        sql: normalizeSql(
          `UPDATE discovery_search_catalog_items
           SET field_values = (
             SELECT COALESCE(jsonb_agg(projected.value ORDER BY projected.ordinal), '[]'::jsonb)
             FROM (
               SELECT candidate.value, candidate.ordinal
               FROM jsonb_array_elements(field_values) WITH ORDINALITY AS candidate(value, ordinal)
               WHERE NOT (candidate.value #>> '{fieldId}' = $1)
             ) AS projected(value, ordinal)
           ),
           updated_at = $2
           WHERE catalog_item_id = $3`,
        ),
        values: ["fld_1", NOW, "cat_1"],
      },
    ]);
  });

  it("replaces JSONB elements and supports deterministic object ordering", async () => {
    const { db, calls } = recordingDb([{ social_login_links: [] }]);
    const link = {
      providerName: "google",
      providerSubject: "sub_1",
      email: "person@example.com",
      linkedAt: NOW,
    };

    await replaceJsonbArrayElement(db, {
      table: "auth_identity_users",
      key: { column: "user_id", value: "usr_1" },
      column: "social_login_links",
      match: {
        kind: "all",
        matches: [
          { kind: "pathText", path: ["providerName"], value: "google" },
          { kind: "pathText", path: ["providerSubject"], value: "sub_1" },
        ],
      },
      element: link,
      orderBy: [
        { kind: "pathText", path: ["providerName"] },
        { kind: "pathText", path: ["providerSubject"] },
      ],
      updatedAt: { value: NOW },
      returning: ["social_login_links"],
    });

    expect(calls).toEqual([
      {
        sql: normalizeSql(
          `UPDATE auth_identity_users
           SET social_login_links = (
             SELECT COALESCE(
               jsonb_agg(projected.value ORDER BY projected.value #>> '{providerName}' ASC, projected.value #>> '{providerSubject}' ASC),
               '[]'::jsonb
             )
             FROM (
               SELECT candidate.value, candidate.ordinal
               FROM jsonb_array_elements(social_login_links) WITH ORDINALITY AS candidate(value, ordinal)
               WHERE NOT ((candidate.value #>> '{providerName}' = $1) AND (candidate.value #>> '{providerSubject}' = $2))
               UNION ALL
               SELECT $3::jsonb AS value, 2147483647 AS ordinal
             ) AS projected(value, ordinal)
           ),
           updated_at = $4
           WHERE user_id = $5
           RETURNING social_login_links`,
        ),
        values: ["google", "sub_1", JSON.stringify(link), NOW, "usr_1"],
      },
    ]);
  });

  it("patches JSONB object elements in place", async () => {
    const { db, calls } = recordingDb([{ contact_methods: [] }]);

    await patchJsonbArrayElement(db, {
      table: "auth_identity_users",
      key: { column: "user_id", value: "usr_1" },
      column: "contact_methods",
      match: { kind: "pathText", path: ["contactMethodId"], value: "cm_1" },
      patch: { verifiedAt: NOW },
      updatedAt: { value: NOW },
      returning: ["contact_methods"],
    });

    expect(calls).toEqual([
      {
        sql: normalizeSql(
          `UPDATE auth_identity_users
           SET contact_methods = (
             SELECT COALESCE(jsonb_agg(projected.value ORDER BY projected.ordinal), '[]'::jsonb)
             FROM (
               SELECT CASE
                 WHEN candidate.value #>> '{contactMethodId}' = $1 THEN candidate.value || $2::jsonb
                 ELSE candidate.value
               END AS value,
               candidate.ordinal
               FROM jsonb_array_elements(contact_methods) WITH ORDINALITY AS candidate(value, ordinal)
             ) AS projected(value, ordinal)
           ),
           updated_at = $3
           WHERE user_id = $4
           RETURNING contact_methods`,
        ),
        values: ["cm_1", JSON.stringify({ verifiedAt: NOW }), NOW, "usr_1"],
      },
    ]);
  });

  it("rejects unsafe identifiers and missing values before querying", async () => {
    const { db, calls } = recordingDb();

    await expect(
      updateRow(db, {
        table: "auth_identity_users; DROP TABLE auth_identity_users",
        setColumns: ["display_name"],
        values: { display_name: "Test" },
        where: { columns: ["user_id"], values: { user_id: "usr_1" } },
      }),
    ).rejects.toThrow("Invalid SQL identifier");

    await expect(
      upsertRow(db, {
        table: "auth_identity_users",
        insertColumns: ["user_id", "display_name"],
        conflictColumns: ["user_id"],
        values: { user_id: "usr_1" } as never,
      }),
    ).rejects.toThrow('Projection row values are missing column "display_name"');

    await expect(
      refreshAffectedRows(db, {
        select: { column: "catalog_item_id" },
        from: { table: "discovery_search_catalog_items" },
        joins: [
          {
            table: "unsafe; DROP TABLE unsafe",
            on: [{ left: { column: "catalog_item_id" }, right: { column: "catalog_item_id" } }],
          },
        ],
        refresh: async () => undefined,
      }),
    ).rejects.toThrow("Invalid SQL identifier");

    expect(calls).toEqual([]);
  });
});

function recordingDb(rows: readonly Record<string, unknown>[] = []): Readonly<{ db: PgQueryable; calls: QueryCall[] }> {
  const calls: QueryCall[] = [];

  return {
    calls,
    db: {
      query: async <Row>(sql: string, values: readonly unknown[] = []) => {
        calls.push({ sql: normalizeSql(sql), values });
        return { rows: rows as Row[], rowCount: rows.length };
      },
    },
  };
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

describe("runBoundedProjectionCascade", () => {
  type FakeController = ProjectionCascadeController & { refreshedCount: () => number };

  function createFakeController(budget: number): FakeController {
    const cursors = new Map<number, ProjectionCascadeCursor>();
    let ordinal = -1;
    let remaining = budget;
    let exhausted = false;
    let refreshed = 0;
    return {
      nextOrdinal: () => (ordinal += 1),
      budgetRemaining: () => remaining,
      isExhausted: () => exhausted,
      consume: (count: number) => {
        remaining -= count;
        refreshed += count;
      },
      markExhausted: () => {
        exhausted = true;
      },
      refreshedCount: () => refreshed,
      loadCursor: (o: number) => Promise.resolve(cursors.get(o) ?? { cursorId: null, completed: false }),
      saveCursor: (o: number, cursorId: string | null, completed: boolean) => {
        cursors.set(o, { cursorId, completed });
        return Promise.resolve();
      },
    };
  }

  it("processes the whole set in one slice when no controller is active", async () => {
    const slices: string[][] = [];
    await runBoundedProjectionCascade(["b", "a", "a", "c"], async (ids) => {
      slices.push([...ids]);
    });
    // De-duplicated, single pass, order preserved from the caller's set.
    expect(slices).toEqual([["b", "a", "c"]]);
  });

  it("completes a set that fits the budget in one pass without exhausting", async () => {
    const controller = createFakeController(10);
    const slices: string[][] = [];
    await runInProjectionCascadeContext(controller, () =>
      runBoundedProjectionCascade(["i3", "i1", "i2"], async (ids) => {
        slices.push([...ids]);
      }),
    );
    expect(slices).toEqual([["i1", "i2", "i3"]]);
    expect(controller.isExhausted()).toBe(false);
    expect(await controller.loadCursor(0)).toEqual({ cursorId: "i3", completed: true });
  });

  it("bounds a large set per pass and resumes from the cursor on the next pass", async () => {
    const ids = ["i1", "i2", "i3", "i4", "i5"];

    const first = createFakeController(2);
    const firstSlices: string[][] = [];
    await runInProjectionCascadeContext(first, () =>
      runBoundedProjectionCascade(ids, async (slice) => {
        firstSlices.push([...slice]);
      }),
    );
    expect(firstSlices).toEqual([["i1", "i2"]]);
    expect(first.isExhausted()).toBe(true);
    expect(first.refreshedCount()).toBe(2);
    const cursorAfterFirst = await first.loadCursor(0);
    expect(cursorAfterFirst).toEqual({ cursorId: "i2", completed: false });

    // Second pass resumes from the persisted cursor (pre-seeded on a fresh controller).
    const second = createFakeController(10);
    await second.saveCursor(0, cursorAfterFirst.cursorId, cursorAfterFirst.completed);
    const secondSlices: string[][] = [];
    await runInProjectionCascadeContext(second, () =>
      runBoundedProjectionCascade(ids, async (slice) => {
        secondSlices.push([...slice]);
      }),
    );
    expect(secondSlices).toEqual([["i3", "i4", "i5"]]);
    expect(second.isExhausted()).toBe(false);
    expect(await second.loadCursor(0)).toEqual({ cursorId: "i5", completed: true });
  });

  it("skips a site whose cursor is already completed (idempotent resume)", async () => {
    const controller = createFakeController(10);
    await controller.saveCursor(0, "i9", true);
    const slices: string[][] = [];
    await runInProjectionCascadeContext(controller, () =>
      runBoundedProjectionCascade(["i1", "i2"], async (ids) => {
        slices.push([...ids]);
      }),
    );
    expect(slices).toEqual([]);
    expect(controller.isExhausted()).toBe(false);
  });

  it("defers later sites once the shared per-pass budget is exhausted", async () => {
    const controller = createFakeController(2);
    const siteA: string[][] = [];
    const siteB: string[][] = [];
    await runInProjectionCascadeContext(controller, async () => {
      await runBoundedProjectionCascade(["a1", "a2", "a3"], async (ids) => {
        siteA.push([...ids]);
      });
      await runBoundedProjectionCascade(["b1", "b2"], async (ids) => {
        siteB.push([...ids]);
      });
    });
    // Site A consumes the whole budget and exhausts the pass; site B is deferred.
    expect(siteA).toEqual([["a1", "a2"]]);
    expect(siteB).toEqual([]);
    expect(controller.isExhausted()).toBe(true);
    expect(await controller.loadCursor(0)).toEqual({ cursorId: "a2", completed: false });
    expect(await controller.loadCursor(1)).toEqual({ cursorId: null, completed: false });
  });
});
