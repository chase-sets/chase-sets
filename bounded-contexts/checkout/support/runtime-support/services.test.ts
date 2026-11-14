import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiHost } from "@chase-sets/platform-runtime/api";
import { createWorkerHost } from "@chase-sets/platform-runtime/worker";
import { contextManifest, module as checkoutModule } from "../../index";
import { createCheckoutCommercialTermsResolver } from "../../api";
import * as sellListRuntime from "../../features/sell-list/api/runtime";
import { createCheckoutServices } from "./services";

afterEach(() => vi.restoreAllMocks());

describe("checkout host ports", () => {
  it.each(["platform-api", "platform-worker"] as const)(
    "%s passes the Commercial Terms resolver through the Checkout manifest",
    (hostName) => {
      const query = vi.fn(async () => ({ rows: [] }));
      const pool = { query } as never;
      const commercialTermsQuery = vi.fn(async () => {
        throw new Error("Service construction must not query Commercial Terms.");
      });
      const commercialTermsResolver = createCheckoutCommercialTermsResolver({ query: commercialTermsQuery });
      const checkoutObservabilityTelemetry = { recordCheckoutEvent: vi.fn() };
      const createSellListRuntime = vi.spyOn(sellListRuntime, "createCheckoutSellListRuntime");
      const registry = [
        {
          contextName: "checkout",
          packageName: "@chase-sets/checkout",
          manifest: contextManifest,
          module: {
            ...checkoutModule,
            // Exercise service construction without mounting unrelated subscription sources.
            eventSubscriptions: [],
            eventReactions: [],
            buildSubscriptions: () => [],
            projectionGroups: [],
            buildProjectionGroups: () => [],
          },
        },
      ];
      const options = {
        pools: { checkout: pool },
        hostPorts: { commercialTermsResolver, checkoutObservabilityTelemetry },
      };

      const runtime =
        hostName === "platform-api"
          ? createApiHost(registry, hostName, options)
          : createWorkerHost(registry, hostName, options);

      expect(createSellListRuntime).toHaveBeenCalledTimes(1);
      expect(createSellListRuntime.mock.calls[0]?.[0].commercialTermsResolver).toBe(commercialTermsResolver);
      expect(runtime.services.checkout).toMatchObject({ checkoutObservabilityTelemetry });
      expect(contextManifest.hostPorts).toContainEqual(
        expect.objectContaining({ portName: "commercialTermsResolver", providedBy: "commercial-terms" }),
      );
      expect(query).not.toHaveBeenCalled();
      expect(commercialTermsQuery).not.toHaveBeenCalled();
    },
  );

  it("passes the Marketplace Offer acceptance terms source to the Sell List runtime on the API host", () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const offerAcceptanceTermsSource = {
      previewOfferAcceptanceTerms: vi.fn(async () => {
        throw new Error("Service construction must not read Marketplace acceptance terms.");
      }),
    };
    const createSellListRuntime = vi.spyOn(sellListRuntime, "createCheckoutSellListRuntime");

    createApiHost(
      [
        {
          contextName: "checkout",
          packageName: "@chase-sets/checkout",
          manifest: contextManifest,
          module: {
            ...checkoutModule,
            eventSubscriptions: [],
            eventReactions: [],
            buildSubscriptions: () => [],
            projectionGroups: [],
            buildProjectionGroups: () => [],
          },
        },
      ],
      "platform-api",
      {
        pools: { checkout: { query } as never },
        hostPorts: {
          commercialTermsResolver: createCheckoutCommercialTermsResolver({ query }),
          offerAcceptanceTermsSource,
        },
      },
    );

    expect(createSellListRuntime.mock.calls[0]?.[0].offerAcceptanceTermsSource).toBe(offerAcceptanceTermsSource);
    expect(contextManifest.hostPorts).toContainEqual(
      expect.objectContaining({ portName: "offerAcceptanceTermsSource", providedBy: "marketplace" }),
    );
    expect(offerAcceptanceTermsSource.previewOfferAcceptanceTerms).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

describe("checkout projection eligibility", () => {
  it("keeps Inline Apply adoption Cart-only", () => {
    const services = createCheckoutServices({
      query: vi.fn(async () => ({ rows: [] })),
    } as never);

    expect(
      services.projectors.filter((projector) => projector.inlineApply).map((projector) => projector.projectionName),
    ).toEqual(["checkout.cart-projection"]);
    expect(
      services.projectors.find((projector) => projector.projectionName === "checkout.session-projection"),
    ).toMatchObject({ inlineApply: false });
    expect(
      services.projectors.find((projector) => projector.projectionName === "checkout.sell-list-projection"),
    ).toMatchObject({ inlineApply: false });
  });
});
