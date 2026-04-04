import { createPgPool } from "@chase-sets/event-core-postgres";
import {
  module as identityModule,
} from "@chase-sets/identity";
import { bootstrapApiModule } from "@chase-sets/bounded-context-runtime";
import { loadConfig } from "./config";

async function bootstrap() {
  const config = loadConfig();
  const pool = createPgPool(config.databaseUrl);

  try {
    await bootstrapApiModule(identityModule, pool, undefined, {
      databaseLabel: "Identity",
      completionLabel: "Identity",
    });
  } finally {
    await (pool as unknown as { end: () => Promise<void> }).end();
  }
}

void bootstrap().catch((error) => {
  console.error("Identity bootstrap failed.", error);
  process.exit(1);
});
