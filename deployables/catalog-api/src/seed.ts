import { fileURLToPath } from "node:url";
import { module as catalogModule } from "@chase-sets/catalog";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { loadConfig } from "./config";

export async function seedDatabase() {
  const config = loadConfig();
  const pool = createPgPool(config.databaseUrls.catalog);

  try {
    await catalogModule.seed?.(pool);
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

