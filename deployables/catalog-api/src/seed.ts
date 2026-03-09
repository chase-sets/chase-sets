import { fileURLToPath } from "node:url";
import { loadConfig } from "./config";
import { createPool } from "./infrastructure/postgres";
import { seedCatalogDatabase } from "../../../bounded-contexts/catalog/authoring/seed";

export async function seedDatabase() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await seedCatalogDatabase(pool);
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  seedDatabase().catch((error) => {
    console.error("Seed failed:", error);
    process.exit(1);
  });
}
