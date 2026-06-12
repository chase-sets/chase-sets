import { describe, expect, it } from "vitest";
import type { PgQueryable } from "./types";
import {
  appendJsonbArrayElement,
  patchJsonbArrayElement,
  removeJsonbArrayElement,
  replaceJsonbArrayElement,
  transitionStatus,
  updateRow,
  upsertRow,
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
