import { Client } from "pg";
import process from "node:process";
import { loadTestEnvironment } from "./run-workspaces.mjs";

export const TEST_DATABASE_CONNECTION_TIMEOUT_MS = 10_000;
export const TEST_DATABASE_ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "postgres"]);

export function dbPreflightRemediationMessage(errorMessage) {
  return [
    "DB test preflight failed: TEST_DATABASE_URL is not reachable.",
    `Cause: ${errorMessage}`,
    "",
    "Start this worktree's sandbox database with:",
    "  pnpm run dev:bootstrap",
    "",
    "Inspect the current sandbox with:",
    "  pnpm run sandbox:doctor",
  ].join("\n");
}

export async function checkTestDatabase({
  databaseUrl = process.env.TEST_DATABASE_URL,
  ClientCtor = Client,
  connectionTimeoutMillis = TEST_DATABASE_CONNECTION_TIMEOUT_MS,
  env = process.env,
} = {}) {
  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is not set.");
  }

  let parsedDatabaseUrl;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL connection URL.");
  }

  if (!TEST_DATABASE_ALLOWED_HOSTS.has(parsedDatabaseUrl.hostname) && env.CHASE_SETS_ALLOW_REMOTE_TEST_DB !== "1") {
    throw new Error(
      `TEST_DATABASE_URL host '${parsedDatabaseUrl.hostname}' is not allowed for destructive DB tests. ` +
        "Use localhost, 127.0.0.1, or postgres, or set CHASE_SETS_ALLOW_REMOTE_TEST_DB=1 to override.",
    );
  }

  const client = new ClientCtor({ connectionString: databaseUrl, connectionTimeoutMillis });
  try {
    await client.connect();
    await client.query("select 1");
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function runDbTestPreflight({
  env = process.env,
  loadEnvironment = loadTestEnvironment,
  checkDatabase = checkTestDatabase,
} = {}) {
  loadEnvironment({ env, includeTestDatabaseUrl: true });
  await checkDatabase({ databaseUrl: env.TEST_DATABASE_URL, env });
}

async function main() {
  await runDbTestPreflight();
  console.log("DB test preflight passed.");
}

if (process.argv[1]?.endsWith("db-test-preflight.mjs")) {
  void main().catch((error) => {
    console.error(dbPreflightRemediationMessage(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  });
}
