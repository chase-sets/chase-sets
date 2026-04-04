import { fileURLToPath } from "node:url";
import { seedCatalogDatabase } from "@chase-sets/catalog";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { loadConfig } from "./config";

export async function seedDatabase() {
  const config = loadConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    await seedCatalogDatabase(pool);
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  seedDatabase()
    .then(() => console.log("Catalog seeded."))
    .catch((error) => {
      console.error("Seed failed:", error);
      process.exitCode = 1;
    });
}

