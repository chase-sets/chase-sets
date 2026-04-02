import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "@chase-sets/identity/server";
import type { SettlementServices } from "./services";
import { createWalletRoutes } from "./wallets/route";
import { createPayoutRoutes } from "./payouts/route";

export type SettlementApiEnv = {
  Variables: {
    actor: ResolvedActor | null;
    context: EventStoreContext | null;
  };
};

async function drainProjectors(services: SettlementServices) {
  let processed = 0;

  do {
    processed = 0;
    for (const projector of services.projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export function buildSettlementApi(services: SettlementServices) {
  const app = new Hono<SettlementApiEnv>();

  app.use("*", async (c, next) => {
    await next();

    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await drainProjectors(services);
    }
  });

  app.route("/", createWalletRoutes(services.wallets));
  app.route("/", createPayoutRoutes(services.payouts));

  return app;
}
