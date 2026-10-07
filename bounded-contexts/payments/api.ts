import { Hono } from "hono";
import { createWalletFundingRoutes } from "./features/wallet-funding/api/route";
import type { PaymentServices } from "./features/payments/api/runtime";
import type { PaymentsServices } from "./support/runtime-support/services";
import {
  createAccountPaymentRoutes,
  createPaymentProviderModeRoutes,
  type PaymentsApiEnv,
} from "./features/payments/api/route";

export function buildPaymentsApi(services: PaymentServices | PaymentsServices) {
  const app = new Hono<PaymentsApiEnv>();
  const paymentServices = "payments" in services ? services.payments : services;
  if ("walletFunding" in services) app.route("/account", createWalletFundingRoutes(services.walletFunding));

  app.route(
    "/",
    createPaymentProviderModeRoutes(
      "providerModeObservation" in services ? services.providerModeObservation : undefined,
    ),
  );

  app.route(
    "/account",
    createAccountPaymentRoutes(paymentServices, "publicConfig" in services ? services.publicConfig : undefined),
  );

  return app;
}
