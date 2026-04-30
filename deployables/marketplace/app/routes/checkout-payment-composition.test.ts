import { describe, expect, it } from "vitest";
import { webContextRegistry } from "../generated/web-context-registry";

type RouteContribution = Readonly<{
  routeId: string;
  routePath: string;
  fileExport: string;
  sourceContext: string;
}>;

function marketplaceRoutes() {
  return webContextRegistry.flatMap((entry) =>
    (entry.manifest.deployableContributions ?? [])
      .filter((contribution) => contribution.deployable === "marketplace-web")
      .flatMap((contribution) =>
        (contribution.routes ?? []).map((route) => ({
          routeId: route.routeId,
          routePath: route.routePath,
          fileExport: route.fileExport,
          sourceContext: route.sourceContext,
        })),
      ),
  ) as RouteContribution[];
}

describe("marketplace checkout and payment composition", () => {
  it("composes checkout-owned cart and checkout routes with payment detail", () => {
    expect(marketplaceRoutes()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeId: "account-cart",
          routePath: "account/cart",
          fileExport: "./routes/account-cart",
          sourceContext: "checkout",
        }),
        expect.objectContaining({
          routeId: "checkout-start",
          routePath: "checkout/start",
          fileExport: "./routes/checkout-start",
          sourceContext: "checkout",
        }),
        expect.objectContaining({
          routeId: "checkout-session",
          routePath: "checkout/:sessionId",
          fileExport: "./routes/checkout-session",
          sourceContext: "checkout",
        }),
        expect.objectContaining({
          routeId: "account-payment",
          routePath: "account/payments/:paymentId",
          fileExport: "./routes/marketplace/account-payment",
          sourceContext: "payments",
        }),
      ]),
    );
  });
});
