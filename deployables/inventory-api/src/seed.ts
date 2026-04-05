import { fileURLToPath } from "node:url";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { module as inventoryModule } from "@chase-sets/inventory";
import { loadConfig } from "./config";

export async function seedDatabase() {
  const config = loadConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    await inventoryModule.seed?.(pool);
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

const isDirectExecution = process.argv[1] === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  seedDatabase()
    .then(() => console.log("Inventory seeded."))
    .catch((error) => {
      console.error("Seed failed:", error);
      process.exitCode = 1;
    });
}
