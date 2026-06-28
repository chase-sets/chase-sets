import { describe, expect, it } from "vitest";
import {
  checkTestDatabase,
  dbPreflightRemediationMessage,
  TEST_DATABASE_CONNECTION_TIMEOUT_MS,
  runDbTestPreflight,
} from "./db-test-preflight.mjs";

describe("db test preflight", () => {
  it("loads generated TEST_DATABASE_URL before checking reachability", async () => {
    const env = {};
    const checkedUrls = [];

    await runDbTestPreflight({
      env,
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
      databaseUrl: "postgresql://postgres:postgres@192.0.2.10:5432/postgres",
      ClientCtor,
    });

    expect(clientConfigs).toEqual([
      {
        connectionString: "postgresql://postgres:postgres@192.0.2.10:5432/postgres",
        connectionTimeoutMillis: TEST_DATABASE_CONNECTION_TIMEOUT_MS,
      },
    ]);
  });
});
