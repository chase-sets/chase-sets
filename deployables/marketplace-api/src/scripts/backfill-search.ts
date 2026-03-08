import { rebuildDiscoverySearchIndex } from "../../../../bounded-contexts/discovery/api";
import { loadConfig } from "../config";
import { createPool } from "../infrastructure/postgres";

async function main() {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);

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
