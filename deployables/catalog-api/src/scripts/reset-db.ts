import { readFileSync } from "node:fs";
import { loadConfig } from "../config";
import { createPool } from "../infrastructure/postgres";
import { seedDatabase } from "../seed";

const initSql = readFileSync(
  new URL("../../init-db.sql", import.meta.url),
  "utf8",
);

async function resetDatabase() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  try {
    console.log("Resetting database schema...");
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query(initSql);
    console.log("Database schema recreated.");
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

resetDatabase()
  .then(() => seedDatabase())
  .catch((error) => {
    console.error("Database reset failed:", error);
    process.exit(1);
  });
