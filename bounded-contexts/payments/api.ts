import { Hono } from "hono";
import type { PaymentServices } from "./payments/runtime";
import {
  createBuyerPaymentRoutes,
  type PaymentsApiEnv,
} from "./payments/route";

async function drainProjectors(services: PaymentServices) {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of services.projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export function buildPaymentsApi(services: PaymentServices) {
  const app = new Hono<PaymentsApiEnv>();

  app.use("*", async (c, next) => {
    await next();

    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      await drainProjectors(services);
    }
  });

  app.route("/buyer", createBuyerPaymentRoutes(services));

  return app;
}
