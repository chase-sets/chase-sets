import { module as discoveryModule } from "@chase-sets/discovery";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { loadBootstrapConfig } from "../config";

async function main() {
  const config = loadBootstrapConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    const services = discoveryModule.createServices(pool, undefined);
    await services.items.search.rebuildSearchIndex();
    console.log("Marketplace search index backfill complete.");
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

void main().catch((error) => {
  console.error("Marketplace search backfill failed.", error);
  process.exit(1);
});
