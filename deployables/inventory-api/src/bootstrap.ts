import { createPgPool } from "@chase-sets/event-core-postgres";
import type { Projector } from "@chase-sets/event-core/projector";
import {
  createInventoryServices,
  inventorySchemaSql,
  seedInventoryDatabase,
} from "@chase-sets/inventory";
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
    await waitForDatabase(pool, "Inventory");
    await pool.query(inventorySchemaSql);

    const eventCount = await countEvents(pool, "inventory.");

    if (eventCount === 0) {
      console.log("Seeding inventory data...");
      await seedInventoryDatabase(pool);
    } else {
      console.log("Inventory events already exist. Skipping seed.");
    }

    const services = createInventoryServices(pool);
    await drainProjectors("Inventory", services.projectors);
    console.log("Inventory bootstrap complete.");
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

void bootstrap().catch((error) => {
  console.error("Inventory bootstrap failed.", error);
  process.exit(1);
});
