import { describe, expect, it } from "vitest";
import {
  checkTestDatabase,
  dbPreflightRemediationMessage,
  TEST_DATABASE_ALLOWED_HOSTS,
  TEST_DATABASE_CONNECTION_TIMEOUT_MS,
  runDbTestPreflight,
} from "./db-test-preflight.mjs";

describe("db test preflight", () => {
  it("loads generated TEST_DATABASE_URL before checking reachability", async () => {
    const env = {};
    const checkedUrls = [];

    await runDbTestPreflight({
      env,
      loadEnvironment: ({ env: targetEnv }) => {
        targetEnv.TEST_DATABASE_URL = "postgresql://postgres:postgres@localhost:7120/postgres";
      },
      checkDatabase: async ({ databaseUrl }) => {
        checkedUrls.push(databaseUrl);
      },
    });

    expect(checkedUrls).toEqual([env.TEST_DATABASE_URL]);
    expect(env.TEST_DATABASE_URL).toMatch(/^postgresql:\/\/postgres:postgres@localhost:/);
  });

  it("prints a local sandbox repair path when the database is unavailable", () => {
    expect(dbPreflightRemediationMessage("connect ECONNREFUSED 127.0.0.1:5432")).toContain("pnpm run dev:bootstrap");
    expect(dbPreflightRemediationMessage("connect ECONNREFUSED 127.0.0.1:5432")).toContain("pnpm run sandbox:doctor");
  });

  it("configures a bounded pg connection timeout", async () => {
    const clientConfigs = [];

    class ClientCtor {
      constructor(config) {
        clientConfigs.push(config);
      }

      async connect() {}
      async query() {}
      async end() {}
    }

    await checkTestDatabase({
      databaseUrl: "postgresql://postgres:postgres@localhost:5432/postgres",
      ClientCtor,
    });

    expect(clientConfigs).toEqual([
      {
        connectionString: "postgresql://postgres:postgres@localhost:5432/postgres",
        connectionTimeoutMillis: TEST_DATABASE_CONNECTION_TIMEOUT_MS,
      },
    ]);
  });

  it("refuses non-local database hosts without the explicit override", async () => {
    const client = {
      connect: async () => {},
      query: async () => {},
      end: async () => {},
    };

    await expect(
      checkTestDatabase({
        databaseUrl: "postgresql://postgres:postgres@db.example.test:5432/postgres",
        ClientCtor: class {
          constructor() {
            return client;
          }
        },
      }),
    ).rejects.toThrow("host 'db.example.test' is not allowed");

    expect(TEST_DATABASE_ALLOWED_HOSTS).toEqual(new Set(["localhost", "127.0.0.1", "postgres"]));
  });

  it("allows a non-local database host with the explicit override", async () => {
    const clientConfigs = [];

    class ClientCtor {
      constructor(config) {
        clientConfigs.push(config);
      }

      async connect() {}
      async query() {}
      async end() {}
    }

    await checkTestDatabase({
      databaseUrl: "postgresql://postgres:postgres@db.example.test:5432/postgres",
      env: { CHASE_SETS_ALLOW_REMOTE_TEST_DB: "1" },
      ClientCtor,
    });

    expect(clientConfigs).toHaveLength(1);
  });
});
