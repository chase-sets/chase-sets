import { describe, expect, it } from "vitest";
import {
  GRANT_KINDS,
  WAKE_LISTENER_EVENT_STORE_TABLES,
  quoteIdentifier,
  readGrants,
  statementsForGrant,
} from "./apply-digitalocean-database-grant.mjs";

describe("database grant kinds", () => {
  it("keeps owner grants on the existing full-usage statements", () => {
    const statements = statementsForGrant({
      database: "chase_sets_staging_checkout",
      user: "cs_staging_checkout",
      kind: "owner",
    });

    expect(statements).toEqual([
      'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "chase_sets_staging_checkout" TO "cs_staging_checkout"',
      'GRANT USAGE, CREATE ON SCHEMA public TO "cs_staging_checkout"',
    ]);
  });

  it("grants wake-listener users CONNECT, schema USAGE, and event-store SELECT only", () => {
    const statements = statementsForGrant({
      database: "chase_sets_staging_checkout",
      user: "cs_staging_checkout_wake_listener",
      kind: "wake-listener",
    });

    expect(statements[0]).toBe(
      'GRANT CONNECT ON DATABASE "chase_sets_staging_checkout" TO "cs_staging_checkout_wake_listener"',
    );
    expect(statements[1]).toBe('GRANT USAGE ON SCHEMA public TO "cs_staging_checkout_wake_listener"');
    expect(statements).toHaveLength(2 + WAKE_LISTENER_EVENT_STORE_TABLES.length);

    for (const [index, tableName] of WAKE_LISTENER_EVENT_STORE_TABLES.entries()) {
      const statement = statements[2 + index];
      expect(statement).toContain(`to_regclass('public.${tableName}')`);
      expect(statement).toContain(`GRANT SELECT ON TABLE public."${tableName}" TO "cs_staging_checkout_wake_listener"`);
    }

    const serialized = statements.join("\n");
    expect(serialized).not.toContain("INSERT");
    expect(serialized).not.toContain("UPDATE");
    expect(serialized).not.toContain("DELETE");
    expect(serialized).not.toMatch(/GRANT [^\n]*CREATE/);
    expect(serialized).not.toContain("TEMPORARY");
    expect(WAKE_LISTENER_EVENT_STORE_TABLES).toEqual(["event_store_events", "event_store_streams"]);
  });

  it("escapes identifiers in generated statements", () => {
    expect(quoteIdentifier('weird"name')).toBe('"weird""name"');
    const [connect] = statementsForGrant({ database: 'data"base', user: 'user"name', kind: "wake-listener" });
    expect(connect).toBe('GRANT CONNECT ON DATABASE "data""base" TO "user""name"');
  });
});

describe("grant input parsing", () => {
  it("defaults the grant kind to owner and accepts wake-listener", () => {
    const grants = readGrants({
      DATABASE_GRANTS_JSON: JSON.stringify([
        { database: "db_a", user: "user_a" },
        { database: "db_b", user: "user_b", kind: "wake-listener" },
      ]),
    });

    expect(grants).toEqual([
      { database: "db_a", user: "user_a", kind: "owner" },
      { database: "db_b", user: "user_b", kind: "wake-listener" },
    ]);
  });

  it("rejects unknown grant kinds and malformed entries", () => {
    expect(() =>
      readGrants({ DATABASE_GRANTS_JSON: JSON.stringify([{ database: "db", user: "u", kind: "superuser" }]) }),
    ).toThrow(GRANT_KINDS.join(", "));
    expect(() => readGrants({ DATABASE_GRANTS_JSON: JSON.stringify([{ database: "db" }]) })).toThrow(
      "must include database and user strings",
    );
    expect(() => readGrants({ DATABASE_GRANTS_JSON: "[]" })).toThrow("non-empty array");
  });

  it("falls back to the single-grant env contract as an owner grant", () => {
    expect(readGrants({ DATABASE_GRANT_NAME: "db_a", DATABASE_GRANT_USER: "user_a" })).toEqual([
      { database: "db_a", user: "user_a", kind: "owner" },
    ]);
  });
});
