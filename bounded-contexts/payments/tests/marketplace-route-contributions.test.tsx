import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as accountPaymentRoute from "../routes/marketplace/account-payment";
import * as checkoutPaymentRoute from "../routes/marketplace/checkout-payment";
import * as accountPaymentMethodsRoute from "../routes/marketplace/account-payment-methods";
import * as accountPaymentNewRoute from "../routes/marketplace/account-payment-new";
import * as featureAccountPaymentMethodsRoute from "../features/payments/ui/routes/account-payment-methods";
import * as featureAccountPaymentNewRoute from "../features/payments/ui/routes/account-payment-new";

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

  it.each([
    { adapter: accountPaymentNewRoute, feature: featureAccountPaymentNewRoute, routeId: "account-payment-new" },
    {
      adapter: accountPaymentMethodsRoute,
      feature: featureAccountPaymentMethodsRoute,
      routeId: "account-payment-methods",
    },
  ])("re-exports the exact $routeId bindings from the feature", ({ adapter, feature }) => {
    expect(Object.keys(adapter).sort()).toEqual(["action", "default", "loader", "meta"]);
    expect(Object.keys(feature).sort()).toEqual(Object.keys(adapter).sort());
    expect(adapter.action).toBe(feature.action);
    expect(adapter.default).toBe(feature.default);
    expect(adapter.loader).toBe(feature.loader);
    expect(adapter.meta).toBe(feature.meta);
  });
});
