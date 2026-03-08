import { loadConfig } from "../config";
import { createPool } from "../infrastructure/postgres";
import { seedDatabase } from "../seed";
import { catalogApiInitSql } from "../database-schema";

async function resetDatabase() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  try {
    console.log("Resetting database schema...");
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query(catalogApiInitSql);
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
