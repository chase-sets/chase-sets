import { describe, expect, it } from "vitest";
import { dbPreflightRemediationMessage, runDbTestPreflight } from "./db-test-preflight.mjs";

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
});
