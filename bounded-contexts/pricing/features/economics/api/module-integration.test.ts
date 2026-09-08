import { describe, expect, it, vi } from "vitest";
import type { MoneyAmount } from "@chase-sets/primitives/money";
import { contextManifest } from "../../../index";
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

function createServices(
  commercialTermsResolver?: Parameters<typeof createEconomicsServices>[0]["commercialTermsResolver"],
) {
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
  });
}

describe("Pricing Economics bounded-context integration", () => {
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

  it("keeps an explicitly unmounted Terms host bounded after exact registration", async () => {
    const services = createServices(null);
    services.registerNativeCommercialTermsProvider(identity);
    await expect(services.providers.resolve(identity).resolve(request)).resolves.toMatchObject({
      kind: "unavailable",
      providerIdentity: identity,
      reason: "terms-unavailable",
    });
  });

  it("increments only the two source subscriptions whose persisted facts changed", () => {
    const versions = new Map(
      contextManifest.eventSubscriptions.map((subscription) => [
        `${subscription.sourceContextName}.${subscription.projectionName}`,
        subscription.subscriptionVersion,
      ]),
    );
    expect(versions.get("inventory.pricing-inventory-input-projection")).toBe(3);
    expect(versions.get("ordering.pricing-market-trades-projection")).toBe(2);
    expect(versions.get("marketplace.pricing-market-input-projection")).toBe(1);
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
