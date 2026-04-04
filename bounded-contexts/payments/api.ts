import { Hono } from "hono";
import type { PaymentServices } from "./payments/runtime";
import {
  createBuyerPaymentRoutes,
  type PaymentsApiEnv,
} from "./payments/route";

export function buildPaymentsApi(services: PaymentServices) {
  const app = new Hono<PaymentsApiEnv>();

  app.route("/buyer", createBuyerPaymentRoutes(services));

  return app;
}
