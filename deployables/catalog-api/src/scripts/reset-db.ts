import { loadConfig } from "../config";
import { module as catalogModule } from "@chase-sets/catalog";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { seedDatabase } from "../seed";

async function resetDatabase() {
  const config = loadConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    console.log("Resetting database schema...");
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await pool.query(catalogModule.schemaSql);
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

