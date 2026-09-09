import { describe, expect, it, vi } from "vitest";
import {
  createCommercialTermsResolver,
  createNoopCommercialTermsResolver,
  type CommercialTermsResolver,
} from "@chase-sets/commercial-terms/server";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { MoneyAmount } from "@chase-sets/primitives/money";
import { contextManifest, module as pricingModule } from "../../../index";
import type { EconomicsServices } from "./services";
import { createEconomicsServices } from "./services";
import { economicsFactNames, type ChannelConnectionIdentityReader } from "../domain/contracts";
import { economicsPolicy, ECONOMICS_LAUNCH_POLICY_VALUE } from "../domain/policy";
import { toEconomicsForPricingGoal, type EconomicsResolution } from "../domain/resolution";
import { createPricingServices } from "../../../support/runtime-support/services";

const identity = { providerKey: "synthetic-provider-a", environment: "sandbox" } as const;
const request = {
  accountId: "acc_synthetic_owner",
  scope: { kind: "native-marketplace" },
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
    eventStore: createInMemoryEventStore().eventStore,
    db: { query: vi.fn(async () => ({ rows: [] })) },
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

  it.each([undefined, {}, { kind: "not-mounted" }] as const)(
    "rejects malformed Commercial Terms authority %# before constructing services",
    (commercialTermsResolver) => {
      expect(() =>
        createEconomicsServices({
          eventStore: createInMemoryEventStore().eventStore,
          db: { query: vi.fn(async () => ({ rows: [] })) },
          policies: {} as never,
          commercialTermsResolver: commercialTermsResolver as never,
          channelConnectionIdentityReader: syntheticChannelConnectionIdentityReader,
        }),
      ).toThrow("Pricing Economics requires Commercial Terms and Channel Connection host ports.");
      expect(() =>
        createPricingServices({} as never, {
          tcgplayerMarketTransport: { kind: "not-mounted" },
          tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
          commercialTermsResolver: commercialTermsResolver as never,
          channelConnectionIdentityReader: syntheticChannelConnectionIdentityReader,
        }),
      ).toThrow("Pricing requires Commercial Terms and Channel Connection Economics host ports.");
    },
  );

  it.each([undefined, {}, { kind: "not-mounted" }] as const)(
    "rejects malformed Channel Connection authority %# before constructing services",
    (channelConnectionIdentityReader) => {
      expect(() =>
        createEconomicsServices({
          eventStore: createInMemoryEventStore().eventStore,
          db: { query: vi.fn(async () => ({ rows: [] })) },
          policies: {} as never,
          commercialTermsResolver: failingCommercialTermsResolver,
          channelConnectionIdentityReader: channelConnectionIdentityReader as never,
        }),
      ).toThrow("Pricing Economics requires Commercial Terms and Channel Connection host ports.");
      expect(() =>
        createPricingServices({} as never, {
          tcgplayerMarketTransport: { kind: "not-mounted" },
          tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
          commercialTermsResolver: failingCommercialTermsResolver,
          channelConnectionIdentityReader: channelConnectionIdentityReader as never,
        }),
      ).toThrow("Pricing requires Commercial Terms and Channel Connection Economics host ports.");
    },
  );

  it("publishes the canonical Economics contract without a goal-specific provider fork", () => {
    const compileOnlyPublicSurface: readonly [
      typeof economicsPolicy,
      typeof toEconomicsForPricingGoal,
      readonly string[],
      ChannelConnectionIdentityReader | null,
      EconomicsResolution | null,
    ] = [economicsPolicy, toEconomicsForPricingGoal, economicsFactNames, null, null];

    expect(compileOnlyPublicSurface[2]).toHaveLength(12);
    const compileOnlyProviderRegistry: EconomicsServices["providers"] | null = null;
    expect(compileOnlyProviderRegistry).toBeNull();
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

  it("constructs the root service and resolves native marketplace without a registry identity", async () => {
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
    await expect(services.resolve(request)).resolves.toMatchObject({
      kind: "resolved",
      economics: {
        channel: { kind: "native-marketplace" },
        facts: {
          platformFeeRelativeBps: { sourceValue: 500, source: { kind: "commercial-terms" } },
          sellerHandlingFixedPerUnitAmount: { source: { kind: "policy-owned" } },
        },
      },
    });
    await expect(services.providers.resolve(identity).resolve(request)).resolves.toMatchObject({
      kind: "unavailable",
      reason: "provider-unavailable",
    });
  });

  it("keeps an explicit native Commercial Terms failure bounded", async () => {
    const services = createServices(failingCommercialTermsResolver);
    await expect(services.resolve(request)).resolves.toMatchObject({
      kind: "unavailable",
      reason: "terms-unavailable",
      channel: { kind: "native-marketplace" },
    });
  });

  it("proves native and unregistered channel scopes through production Pricing composition", async () => {
    const commercialTermsDb: PgQueryable = {
      query: async <Row>(text: string) => {
        const rows: readonly Record<string, unknown>[] = text.includes("FROM commercial_terms_account_pages")
          ? [
              {
                account_id: request.accountId,
                account_type: "business",
                status: "active",
                founders_window_started_at: null,
                founders_window_ends_at: null,
              },
            ]
          : text.includes("AS schedule_id")
            ? [
                {
                  schedule_id: "synthetic-local-schedule",
                  label: "Synthetic local marketplace terms",
                  marketplace_sales_fee_percentage_bps: 500,
                  marketplace_sales_fee_fixed_amount: "0.00",
                  marketplace_sales_fee_cap_amount: "25.00",
                  shipping_allowance_percentage_bps: 1_000,
                  updated_at: "2026-09-01T00:00:00Z",
                },
              ]
            : [];
        return { rows: rows.map((row) => row as Row) };
      },
    };
    const pricingPool = {
      query: async <Row>() => ({ rows: [] as Row[] }),
    } as unknown as PgTransactionalPool;
    const channelConnectionIdentityReader = {
      resolve: vi.fn(async ({ accountId, connectionId }) =>
        accountId === request.accountId && connectionId === "synthetic-connection-1"
          ? { connectionId, ...identity }
          : null,
      ),
    };
    const commercialTermsResolver = createCommercialTermsResolver({ db: commercialTermsDb });
    await expect(
      commercialTermsResolver.resolveListingTerms({
        accountId: request.accountId,
        amount: request.marketUnitPrice.amount,
        effectiveAt: request.effectiveAt,
      }),
    ).resolves.toMatchObject({
      accountId: request.accountId,
      scheduleId: "synthetic-local-schedule",
      marketplaceSalesFeePercentageBps: 500,
      shippingAllowancePercentageBps: 1_000,
    });
    const services = createPricingServices(pricingPool, {
      tcgplayerMarketTransport: { kind: "not-mounted" },
      tcgplayerMarketCaptureReceiptSink: { kind: "not-mounted" },
      commercialTermsResolver,
      channelConnectionIdentityReader,
    });

    const native = await services.economics.resolve(request);
    expect(native.kind).toBe("resolved");
    if (native.kind !== "resolved") throw new Error("Expected native marketplace Economics.");
    expect(native.economics.channel).toEqual({ kind: "native-marketplace" });
    expect(channelConnectionIdentityReader.resolve).not.toHaveBeenCalled();
    const overheadFacts = Object.entries(native.economics.facts).filter(([name]) =>
      [
        "platformFeeRelativeBps",
        "platformFeeFixedPerUnitAmount",
        "platformFeeCapPerUnitAmount",
        "sellerHandlingRelativeBps",
        "sellerHandlingFixedPerUnitAmount",
        "sellerHandlingCapPerUnitAmount",
        "shippingAllowanceBps",
      ].includes(name),
    );
    expect(overheadFacts).toHaveLength(7);
    expect(
      overheadFacts
        .filter(([, fact]) => fact.source.kind === "commercial-terms")
        .map(([name]) => name)
        .sort(),
    ).toEqual([
      "platformFeeCapPerUnitAmount",
      "platformFeeFixedPerUnitAmount",
      "platformFeeRelativeBps",
      "shippingAllowanceBps",
    ]);
    expect(
      overheadFacts
        .filter(([, fact]) => fact.source.kind === "policy-owned")
        .map(([name]) => name)
        .sort(),
    ).toEqual(["sellerHandlingCapPerUnitAmount", "sellerHandlingFixedPerUnitAmount", "sellerHandlingRelativeBps"]);

    const channel = await services.economics.resolve({
      ...request,
      scope: { kind: "channel-connection", connectionId: "synthetic-connection-1" },
    });
    expect(channel).toMatchObject({
      kind: "unavailable",
      reason: "provider-unavailable",
      channel: { kind: "channel-connection", connectionId: "synthetic-connection-1" },
      facts: { dailyReturnHurdle: { effectiveValue: 0.005 } },
    });
    expect(channelConnectionIdentityReader.resolve).toHaveBeenCalledWith({
      accountId: request.accountId,
      connectionId: "synthetic-connection-1",
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
