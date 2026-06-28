import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as accountPaymentRoute from "../routes/marketplace/account-payment";
import * as checkoutPaymentRoute from "../routes/marketplace/checkout-payment";

const paymentsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type RouteContribution = Readonly<{
  routeId?: string;
  routePath?: string;
  fileExport?: string;
  sourceContext?: string;
}>;

function marketplaceRoutes() {
  const manifest = JSON.parse(readFileSync(join(paymentsRoot, "context.json"), "utf8")) as {
    deployableContributions?: Array<{
      deployable?: string;
      routes?: RouteContribution[];
    }>;
  };

  return (
    manifest.deployableContributions
      ?.filter((contribution) => contribution.deployable === "marketplace-web")
      .flatMap((contribution) => contribution.routes ?? []) ?? []
  );
}

describe("Payments marketplace route contributions", () => {
  it("declares Payments-owned account and checkout payment routes", () => {
    expect(marketplaceRoutes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeId: "account-payment",
          routePath: "account/payments/:paymentId",
          fileExport: "./routes/marketplace/account-payment",
          sourceContext: "payments",
        }),
        expect.objectContaining({
          routeId: "account-payment-new",
          routePath: "account/payments/new",
          fileExport: "./routes/marketplace/account-payment-new",
          sourceContext: "payments",
        }),
        expect.objectContaining({
          routeId: "account-payment-methods",
          routePath: "account/payment-methods",
          fileExport: "./routes/marketplace/account-payment-methods",
          sourceContext: "payments",
        }),
        expect.objectContaining({
          routeId: "checkout-payment",
          routePath: "checkout/payments/:paymentId",
          fileExport: "./routes/marketplace/checkout-payment",
          sourceContext: "payments",
        }),
      ]),
    );
  });

  it("carries account payment behavior on the guest checkout payment wrapper", () => {
    expect(checkoutPaymentRoute.action).toBe(accountPaymentRoute.action);
    expect(checkoutPaymentRoute.loader).toBe(accountPaymentRoute.loader);
    expect(checkoutPaymentRoute.meta).toBe(accountPaymentRoute.meta);
    expect(checkoutPaymentRoute.ErrorBoundary).toBe(accountPaymentRoute.ErrorBoundary);
  });
});
