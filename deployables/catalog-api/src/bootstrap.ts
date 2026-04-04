import { module as catalogModule } from "@chase-sets/catalog-authoring";
import {
  drainProjectors,
  waitForDatabase,
} from "@chase-sets/bounded-context-runtime";
import { createPgPool } from "@chase-sets/event-core-postgres";
import { loadConfig } from "./config";

async function countEvents(pool: ReturnType<typeof createPgPool>, prefix: string) {
  const result = await pool.query(
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE $1",
    [`${prefix}%`],
  );

  return Number(result.rows[0]?.count ?? 0);
}

async function bootstrap() {
  const config = loadConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    await waitForDatabase(pool, "Catalog");
    await pool.query(catalogModule.schemaSql);

    const eventCount = await countEvents(pool, "catalog.");

    if (eventCount === 0) {
      console.log("Seeding catalog data...");
      await catalogModule.seed?.(pool);
    } else {
      console.log("Catalog events already exist. Skipping seed.");
    }

    const services = catalogModule.createServices(pool);
    await drainProjectors(catalogModule.projectors(services));
    console.log("Catalog projections are up to date.");
    console.log("Catalog bootstrap complete.");
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

void bootstrap().catch((error) => {
  console.error("Catalog bootstrap failed.", error);
  process.exit(1);
});
