import { catalogAuthoringSchemaSql, createCatalogServices, seedCatalogDatabase } from "@chase-sets/catalog-authoring";
import { createPgPool } from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import { loadConfig } from "./config";

const RETRY_DELAY_MS = 1_000;
const MAX_RETRIES = 30;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDatabase(
  pool: ReturnType<typeof createPgPool>,
  description: string,
) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `${description} database did not become ready after ${MAX_RETRIES} attempts.`,
          { cause: error },
        );
      }

      await sleep(RETRY_DELAY_MS);
    }
  }
}

async function countEvents(pool: ReturnType<typeof createPgPool>, prefix: string) {
  const result = await pool.query(
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE $1",
    [`${prefix}%`],
  );

  return Number(result.rows[0]?.count ?? 0);
}

async function drainProjectors(label: string, projectors: readonly Projector[]) {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);

  console.log(`${label} projections are up to date.`);
}

async function bootstrap() {
  const config = loadConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    await waitForDatabase(pool, "Catalog");
    await pool.query(catalogAuthoringSchemaSql);

    const eventCount = await countEvents(pool, "catalog.");

    if (eventCount === 0) {
      console.log("Seeding catalog data...");
      await seedCatalogDatabase(pool);
    } else {
      console.log("Catalog events already exist. Skipping seed.");
    }

    const services = createCatalogServices(pool);
    await drainProjectors("Catalog", services.projectors);
    console.log("Catalog bootstrap complete.");
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

void bootstrap().catch((error) => {
  console.error("Catalog bootstrap failed.", error);
  process.exit(1);
});
