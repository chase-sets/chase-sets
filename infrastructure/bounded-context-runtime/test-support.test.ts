import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { describe, expect, it, vi } from "vitest";
import {
  createAccountUserTestActor,
  createAdminTestActor,
  createAnonymousTestActor,
  createInternalSystemTestActor,
  createInternalSystemTestRequestContext,
  createMultiContextTestDatabaseUrls,
  createTestApp,
  createTestEventStoreContext,
  resetMockState,
} from "./test-support";
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

describe("test-support API route helpers", () => {
  it("creates scenario actors with useful defaults and local overrides", () => {
    expect(createAnonymousTestActor()).toBeNull();

    expect(createAccountUserTestActor({ permissions: ["orders.view"], accountId: "acc_buyer" })).toMatchObject({
      sessionId: "ses_test",
      tenantId: "tnt_identity",
      accountId: "acc_buyer",
      roleKey: "owner",
      permissions: ["orders.view"],
    });

    expect(createAdminTestActor()).toMatchObject({
      userId: "usr_admin",
      accountId: "acc_admin",
      roleKey: "platform-admin",
      permissions: expect.arrayContaining(["security.manage"]),
    });

    expect(createInternalSystemTestActor()).toMatchObject({
      userId: "usr_system",
      accountId: "acc_system",
      roleKey: "system",
      permissions: ["system"],
    });
  });

  it("sets the supplied actor and derives the default audit context", async () => {
    type ApiEnv = {
      Variables: {
        actor: ReturnType<typeof createAccountUserTestActor> | null;
        context: EventStoreContext | null;
      };
    };
    const actor = createAccountUserTestActor({
      userId: "usr_buyer",
      accountId: "acc_buyer",
      permissions: ["orders.view"],
    });
    const app = createTestApp<ApiEnv>({
      actor,
      routes: (routeApp) => {
        routeApp.get("/who", (c) =>
          c.json({
            actor: c.var.actor,
            context: c.var.context,
          }),
        );
      },
    });

    const response = await app.request("/who");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      actor: {
        userId: "usr_buyer",
        accountId: "acc_buyer",
      },
      context: {
        tenantId: "tnt_identity",
        audit: {
          performedByUserId: "usr_buyer",
          forAccountId: "acc_buyer",
        },
      },
    });
  });

  it("honors explicit context for anonymous routes that still need system audit metadata", async () => {
    type ApiEnv = {
      Variables: {
        actor: ReturnType<typeof createAnonymousTestActor>;
        context: EventStoreContext;
      };
    };
    const system = createInternalSystemTestRequestContext({
      context: {
        tenantId: "ten_test",
        trace: { traceId: "trc_test" as never },
      },
    });
    const app = createTestApp<ApiEnv>({
      actor: createAnonymousTestActor(),
      context: system.context ?? createTestEventStoreContext(createInternalSystemTestActor()),
      routes: (routeApp) => {
        routeApp.get("/bootstrap", (c) =>
          c.json({
            actor: c.var.actor,
            context: c.var.context,
          }),
        );
      },
    });

    const response = await app.request("/bootstrap");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      actor: null,
      context: {
        tenantId: "ten_test",
        audit: {
          performedByUserId: "usr_system",
          forAccountId: "acc_system",
        },
        trace: {
          traceId: "trc_test",
        },
      },
    });
  });

  it("clears all mock calls and resets explicitly listed mock implementations", () => {
    const cleared = vi.fn();
    const reset = vi.fn(() => "before-reset");
    cleared("called");
    reset.mockReturnValue("configured");

    resetMockState(reset);

    expect(cleared).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(reset()).toBe("before-reset");
  });
});

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
