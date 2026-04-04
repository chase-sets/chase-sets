import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createFakePaymentProcessorGateway } from "@chase-sets/payments";
import {
  drainProjectors,
  seedApiModuleIfEmpty,
} from "@chase-sets/bounded-context-runtime";
import { createContextRuntime } from "./context-runtime.generated";

const marketplaceSeedOrder = [
  "identity",
  "catalog",
  "inventory",
  "marketplace",
  "ordering",
  "payments",
  "fulfillment",
  "reputation",
  "settlement",
] as const;

export async function seedMarketplaceRuntime(
  pool: PgTransactionalPool,
  runtime: ReturnType<typeof createContextRuntime>,
) {
  const modulesByContext = new Map(
    runtime.mountedModules.map((entry) => [entry.module.contextName, entry.module]),
  );

  for (const contextName of marketplaceSeedOrder) {
    const module = modulesByContext.get(contextName);
    if (!module) {
      continue;
    }

    await seedApiModuleIfEmpty(module, pool);
  }

  await drainProjectors(runtime.projectors);
}

export async function seedMarketplaceStack(pool: PgTransactionalPool) {
  const runtime = createContextRuntime(pool, {
    processorGateway: createFakePaymentProcessorGateway(),
  });

  await seedMarketplaceRuntime(pool, runtime);
}
