import type { BcProjector } from "@chase-sets/bounded-context-module";

const RETRY_DELAY_MS = 1_000;
const MAX_RETRIES = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForDatabase(
  pool: { query: (sql: string) => Promise<unknown> },
  label = "Database",
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `${label} did not become ready after ${MAX_RETRIES} attempts.`,
          { cause: error },
        );
      }

      await sleep(RETRY_DELAY_MS);
    }
  }
}

export async function drainProjectors(
  projectors: readonly BcProjector[],
): Promise<void> {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export function collectProjectors<TServices extends {
  projectors: readonly BcProjector[];
}>(servicesList: readonly TServices[]): readonly BcProjector[] {
  return servicesList.flatMap((services) => services.projectors);
}
