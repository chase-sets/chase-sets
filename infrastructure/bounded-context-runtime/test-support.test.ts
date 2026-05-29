import { describe, expect, it } from "vitest";
import { createMultiContextTestDatabaseUrls } from "./test-support";
import { ensureOwnedPostgresDatabases } from "./provisioning";

type QueryCall = Readonly<{
  sql: string;
  params: readonly unknown[];
}>;

function createAdminPool(options?: { existingRoles?: readonly string[]; existingDatabases?: readonly string[] }) {
  const existingRoles = new Set(options?.existingRoles ?? []);
  const existingDatabases = new Set(options?.existingDatabases ?? []);
  const calls: QueryCall[] = [];

  return {
    calls,
    pool: {
      query: async (sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });

        if (sql.includes("FROM pg_roles")) {
          return {
            rows: [{ exists: existingRoles.has(String(params[0])) }],
          };
        }

        if (sql.includes("FROM pg_database")) {
          return {
            rows: [{ exists: existingDatabases.has(String(params[0])) }],
          };
        }

        return { rows: [] };
      },
    },
  };
}

describe("test-support database ownership", () => {
  it("creates per-context owned database URLs from an admin connection", () => {
    const urls = createMultiContextTestDatabaseUrls(
      "postgresql://postgres:postgres@localhost:5432/postgres",
      ["catalog", "identity"] as const,
      "acceptance_suite",
    );

    const catalogUrl = new URL(urls.catalog);
    expect(catalogUrl.pathname).toMatch(/^\/acceptance_suite_catalog_/);
    expect(catalogUrl.username).toBe(catalogUrl.pathname.slice(1));
    expect(catalogUrl.password).toBe(catalogUrl.pathname.slice(1));

    const identityUrl = new URL(urls.identity);
    expect(identityUrl.pathname).toMatch(/^\/acceptance_suite_identity_/);
    expect(identityUrl.username).toBe(identityUrl.pathname.slice(1));
    expect(identityUrl.password).toBe(identityUrl.pathname.slice(1));
  });

  it("creates missing roles and databases with matching ownership", async () => {
    const { calls, pool } = createAdminPool();

    await ensureOwnedPostgresDatabases(pool as never, {
      auth: "postgresql://auth:auth@localhost:5432/auth",
      identity: "postgresql://identity:identity@localhost:5432/identity",
    });

    expect(calls.map((call) => call.sql)).toContain(`CREATE ROLE "auth" WITH LOGIN PASSWORD 'auth'`);
    expect(calls.map((call) => call.sql)).toContain(`CREATE DATABASE "auth" OWNER "auth"`);
    expect(calls.map((call) => call.sql)).toContain(`GRANT ALL PRIVILEGES ON DATABASE "identity" TO "identity"`);
  });

  it("is idempotent for existing roles and databases", async () => {
    const { calls, pool } = createAdminPool({
      existingRoles: ["auth"],
      existingDatabases: ["auth"],
    });

    await ensureOwnedPostgresDatabases(pool as never, {
      auth: "postgresql://auth:auth@localhost:5432/auth",
    });

    expect(calls.map((call) => call.sql)).not.toContain(`CREATE ROLE "auth" WITH LOGIN PASSWORD 'auth'`);
    expect(calls.map((call) => call.sql)).not.toContain(`CREATE DATABASE "auth" OWNER "auth"`);
    expect(calls.map((call) => call.sql)).toContain(`ALTER ROLE "auth" WITH LOGIN PASSWORD 'auth'`);
    expect(calls.map((call) => call.sql)).toContain(`ALTER DATABASE "auth" OWNER TO "auth"`);
  });
});
