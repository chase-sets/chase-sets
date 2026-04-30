import { Hono } from "hono";
import type { PaymentServices } from "./features/payments/api/runtime";
import {
  createAccountPaymentRoutes,
  type PaymentsApiEnv,
} from "./features/payments/api/route";

export function buildPaymentsApi(services: PaymentServices) {
  const app = new Hono<PaymentsApiEnv>();

  app.route("/account", createAccountPaymentRoutes(services));

  return app;
}
