import { Client } from "pg";
import process from "node:process";
import { loadTestEnvironment } from "./run-workspaces.mjs";

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

export async function checkTestDatabase({ databaseUrl = process.env.TEST_DATABASE_URL, ClientCtor = Client } = {}) {
  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is not set.");
  }

  const client = new ClientCtor({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query("select 1");
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function runDbTestPreflight({ env = process.env, checkDatabase = checkTestDatabase } = {}) {
  loadTestEnvironment({ env, includeTestDatabaseUrl: true });
  await checkDatabase({ databaseUrl: env.TEST_DATABASE_URL });
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
