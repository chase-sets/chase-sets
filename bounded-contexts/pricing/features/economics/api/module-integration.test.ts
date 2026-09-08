import { describe, expect, it, vi } from "vitest";
import { createNoopCommercialTermsResolver, type CommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import type { MoneyAmount } from "@chase-sets/primitives/money";
import { contextManifest, module as pricingModule } from "../../../index";
import type { EconomicsServices } from "./services";
import { createEconomicsServices } from "./services";
import { economicsFactNames, type ChannelConnectionIdentityReader } from "../domain/contracts";
import { economicsPolicy, ECONOMICS_LAUNCH_POLICY_VALUE } from "../domain/policy";
import { toEconomicsForPricingGoal, type EconomicsResolution } from "../domain/resolution";

const identity = { providerKey: "synthetic-provider-a", environment: "sandbox" } as const;
const request = {
  accountId: "synthetic-owner-account",
  connectionId: "synthetic-connection-1",
  catalogItemId: "synthetic-catalog-item",
  inventoryItemId: "synthetic-inventory-item",
  marketUnitPrice: { amount: "100.00" as MoneyAmount, currency: "usd" },
  quantity: 1,
  effectiveAt: "2026-09-07T06:00:00Z",
} as const;

const syntheticChannelConnectionIdentityReader: ChannelConnectionIdentityReader = {
  resolve: async () => null,
};

const failingCommercialTermsResolver: CommercialTermsResolver = {
  ...createNoopCommercialTermsResolver(),
  resolveListingTerms: async () => {
    throw new Error("Synthetic Commercial Terms failure.");
  },
};

function createServices(commercialTermsResolver: CommercialTermsResolver) {
  return createEconomicsServices({
    eventStore: {} as never,
    db: { query: vi.fn() } as never,
    policies: {
      resolvePolicy: vi.fn(async () => ({
        policyKey: "pricing.economics",
        value: ECONOMICS_LAUNCH_POLICY_VALUE,
        source: "fallback",
        documentId: null,
        effectiveFrom: null,
        effectiveUntil: null,
        resolvedAt: request.effectiveAt,
      })),
    } as never,
    commercialTermsResolver,
    channelConnectionIdentityReader: syntheticChannelConnectionIdentityReader,
  });
}

function compilePricingHostPortBoundary(pool: Parameters<typeof pricingModule.createServices>[0]) {
  // @ts-expect-error Both Economics authorities are required at the Pricing composition boundary.
  pricingModule.createServices(pool);
  // @ts-expect-error Commercial Terms cannot be omitted while the Channel reader is mounted.
  pricingModule.createServices(pool, {
    tcgplayerMarketTransport: { kind: "not-mounted" },
    tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
    channelConnectionIdentityReader: syntheticChannelConnectionIdentityReader,
  });
  // @ts-expect-error The Channel reader cannot be omitted while Commercial Terms is mounted.
  pricingModule.createServices(pool, {
    tcgplayerMarketTransport: { kind: "not-mounted" },
    tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
    commercialTermsResolver: failingCommercialTermsResolver,
  });
  const completePorts: Parameters<typeof pricingModule.createServices>[1] = {
    tcgplayerMarketTransport: { kind: "not-mounted" },
    tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
    commercialTermsResolver: failingCommercialTermsResolver,
    channelConnectionIdentityReader: syntheticChannelConnectionIdentityReader,
  };
  pricingModule.createServices(pool, completePorts);
}

void compilePricingHostPortBoundary;

describe("Pricing Economics bounded-context integration", () => {
  it("rejects a missing Economics authority at the runtime composition boundary", () => {
    expect(() => pricingModule.createServices({} as never, undefined as never)).toThrow(
      "Pricing requires Commercial Terms and Channel Connection Economics host ports.",
    );
  });

  it("publishes the canonical Economics contract without a goal-specific provider fork", () => {
    const compileOnlyPublicSurface: readonly [
      typeof economicsPolicy,
      typeof toEconomicsForPricingGoal,
      readonly string[],
      ChannelConnectionIdentityReader | null,
      EconomicsResolution | null,
    ] = [economicsPolicy, toEconomicsForPricingGoal, economicsFactNames, null, null];

    expect(compileOnlyPublicSurface[2]).toHaveLength(12);
    const compileOnlyRegistration: EconomicsServices["registerNativeCommercialTermsProvider"] | null = null;
    expect(compileOnlyRegistration).toBeNull();
    expect(contextManifest.allowedContextDependencies).toEqual(
      expect.arrayContaining(["@chase-sets/channels", "@chase-sets/commercial-terms"]),
    );
    expect(contextManifest.ownedNouns).toEqual(
      expect.arrayContaining([
        "economics",
        "economics-fact",
        "fact-source",
        "policy-owned",
        "observed-hold",
        "observed-turnaround",
        "daily-return-hurdle",
      ]),
    );
    expect(contextManifest.hostPorts.map(({ portName }) => portName)).toEqual(
      expect.arrayContaining(["commercialTermsResolver", "channelConnectionIdentityReader"]),
    );
  });

  it("constructs the root service and registers an exact native adapter without consumer branching", async () => {
    const services = createServices({
      ...createNoopCommercialTermsResolver(),
      resolveListingTerms: async () => ({
        accountId: request.accountId,
        accountType: "business",
        basisAmount: request.marketUnitPrice.amount,
        marketplaceSalesFeeUnitAmount: "5.00",
        sellerNetUnitAmount: "95.00",
        marketplaceSalesFeePercentageBps: 500,
        marketplaceSalesFeeFixedAmount: "0.00",
        marketplaceSalesFeeCapAmount: "25.00",
        shippingAllowancePercentageBps: 1_000,
        scheduleId: "synthetic-schedule",
        agreementId: "synthetic-agreement",
        resolvedAt: request.effectiveAt,
      }),
    });
    services.registerNativeCommercialTermsProvider(identity);

    await expect(services.providers.resolve(identity).resolve(request)).resolves.toMatchObject({
      kind: "resolved",
      providerIdentity: identity,
    });
    expect(() => services.registerNativeCommercialTermsProvider(identity)).toThrow(/already registered/);
  });

  it("keeps an explicit Commercial Terms failure bounded after exact registration", async () => {
    const services = createServices(failingCommercialTermsResolver);
    services.registerNativeCommercialTermsProvider(identity);
    await expect(services.providers.resolve(identity).resolve(request)).resolves.toMatchObject({
      kind: "unavailable",
      providerIdentity: identity,
      reason: "terms-unavailable",
    });
  });

  it("increments only the two Economics source subscriptions and preserves Marketplace v2", () => {
    const versions = new Map(
      contextManifest.eventSubscriptions.map((subscription) => [
        `${subscription.sourceContextName}.${subscription.projectionName}`,
        subscription.subscriptionVersion,
      ]),
    );
    expect(versions.get("inventory.pricing-inventory-input-projection")).toBe(3);
    expect(versions.get("ordering.pricing-market-trades-projection")).toBe(2);
    expect(versions.get("marketplace.pricing-market-input-projection")).toBe(2);
    expect(versions.get("ordering.pricing-order-input-projection")).toBe(1);
    expect(versions.get("fulfillment.pricing-fulfillment-input-projection")).toBe(1);
    expect(versions.get("fulfillment.pricing-market-trades-projection")).toBe(1);
    expect(versions.get("identity.pricing-market-trades-projection")).toBe(1);
    expect(versions.get("payments.pricing-market-trades-projection")).toBe(1);
    expect(versions.get("authenticity.pricing-market-trades-projection")).toBe(1);
    expect(versions.get("settlement.pricing-market-trades-projection")).toBe(1);
  });

  it("assigns replay/reset ownership to Pricing without duplicating source projections", () => {
    expect(
      contextManifest.projectionGroups.find((group) => group.projectionName === "pricing-inventory-input-projection"),
    ).toMatchObject({
      sourceContextNames: ["inventory"],
      ownedTables: expect.arrayContaining(["pricing_inventory_acquisition_lots"]),
      requiredDuringBootstrap: true,
      resetStrategy: "replay-only",
    });
    expect(
      contextManifest.projectionGroups.find(
        (group) => group.projectionName === "pricing-economics-overrides-projection",
      ),
    ).toMatchObject({
      sourceContextNames: ["pricing"],
      ownedTables: ["pricing_economics_overrides"],
      requiredDuringBootstrap: true,
      resetStrategy: "replay-only",
    });
  });
});
