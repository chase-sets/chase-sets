import { loadConfig } from "../config";
import { createPool } from "../infrastructure/postgres";
import { rebuildMarketplaceSearchIndex } from "../projections/search-item-projection";

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

  try {
    await rebuildMarketplaceSearchIndex(pool);
    console.log("Marketplace search index backfill complete.");
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

void main().catch((error) => {
  console.error("Marketplace search backfill failed.", error);
  process.exit(1);
});
