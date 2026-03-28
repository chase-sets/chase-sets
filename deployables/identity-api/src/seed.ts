import { createPgPool } from "@chase-sets/event-core-postgres";
import { seedIdentityDatabase } from "@chase-sets/identity";
import { loadConfig } from "./config";

const config = loadConfig();
const pool = createPgPool(config.databaseUrl);

seedIdentityDatabase(pool)
  .then(() => {
    console.log("Identity seeded.");
    return (pool as unknown as { end: () => Promise<void> }).end();
  })
  .catch(async (error) => {
    console.error(error);
    await (pool as unknown as { end: () => Promise<void> }).end();
    process.exitCode = 1;
  });
