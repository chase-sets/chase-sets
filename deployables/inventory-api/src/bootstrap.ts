import { createPgPool } from "@chase-sets/event-core-postgres";
import {
  module as inventoryModule,
} from "@chase-sets/inventory";
import { bootstrapApiModule } from "@chase-sets/bounded-context-runtime";
import { loadConfig } from "./config";

async function bootstrap() {
  const config = loadConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    await bootstrapApiModule(inventoryModule, pool, undefined, {
      databaseLabel: "Inventory",
      completionLabel: "Inventory",
    });
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

void bootstrap().catch((error) => {
  console.error("Inventory bootstrap failed.", error);
  process.exit(1);
});
