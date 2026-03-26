import { fileURLToPath } from "node:url";
import { seedCatalogDatabase } from "@chase-sets/catalog-authoring";
import { createPgPool } from "@chase-sets/event-core/postgres";
import { loadConfig } from "./config";

export async function seedDatabase() {
  const config = loadConfig();
  const pool = createPgPool(config.databaseUrl);
  await seedCatalogDatabase(pool);
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  seedDatabase().catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
}
