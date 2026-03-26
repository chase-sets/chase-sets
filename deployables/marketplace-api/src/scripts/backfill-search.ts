import { rebuildDiscoverySearchIndex } from "@chase-sets/discovery";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { loadConfig } from "../config";

async function main() {
  const config = loadConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    await rebuildDiscoverySearchIndex(pool);
    console.log("Marketplace search index backfill complete.");
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

void main().catch((error) => {
  console.error("Marketplace search backfill failed.", error);
  process.exit(1);
});
