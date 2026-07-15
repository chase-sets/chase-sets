import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const checkoutRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

type RouteContribution = Readonly<{
  routeId?: string;
  routePath?: string;
  fileExport?: string;
  sourceContext?: string;
}>;

function marketplaceRoutes() {
  const manifest = JSON.parse(readFileSync(join(checkoutRoot, "context.json"), "utf8")) as {
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

describe("Checkout marketplace route contributions", () => {
  it("declares the Checkout-owned cart, sell list, and checkout route map", () => {
    expect(marketplaceRoutes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeId: "account-cart",
          routePath: "account/cart",
          fileExport: "./routes/account-cart",
          sourceContext: "checkout",
        }),
        expect.objectContaining({
          routeId: "account-sell-list",
          routePath: "account/sell-list",
          fileExport: "./routes/account-sell-list",
          sourceContext: "checkout",
        }),
        expect.objectContaining({
          routeId: "account-desk-offers",
          routePath: "account/desk/offers",
          fileExport: "./routes/account-desk-offers",
          sourceContext: "checkout",
        }),
        expect.objectContaining({
          routeId: "sell-checkout-session",
          routePath: "checkout/sell/session/:sessionId",
          fileExport: "./routes/sell-checkout-session",
          sourceContext: "checkout",
        }),
        expect.objectContaining({
          routeId: "sell-checkout-confirmation",
          routePath: "checkout/sell/session/:sessionId/confirmation",
          fileExport: "./routes/sell-checkout-confirmation",
          sourceContext: "checkout",
        }),
        expect.objectContaining({
          routeId: "buy-checkout-readiness",
          routePath: "checkout/buy/readiness",
          fileExport: "./routes/checkout-start",
          sourceContext: "checkout",
        }),
        expect.objectContaining({
          routeId: "buy-checkout-session",
          routePath: "checkout/buy/session/:sessionId",
          fileExport: "./routes/checkout-session",
          sourceContext: "checkout",
        }),
        expect.objectContaining({
          routeId: "buy-checkout-confirmation",
          routePath: "checkout/buy/session/:sessionId/confirmation",
          fileExport: "./routes/buy-checkout-confirmation",
          sourceContext: "checkout",
        }),
      ]),
    );
  });
});
