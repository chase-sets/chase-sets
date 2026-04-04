import { module as catalogModule } from "@chase-sets/catalog";
import {
  bootstrapApiModule,
} from "@chase-sets/bounded-context-runtime";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { loadConfig } from "./config";

async function bootstrap() {
  const config = loadConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    await bootstrapApiModule(catalogModule, pool, undefined, {
      databaseLabel: "Catalog",
      completionLabel: "Catalog",
    });
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

void bootstrap().catch((error) => {
  console.error("Catalog bootstrap failed.", error);
  process.exit(1);
});

