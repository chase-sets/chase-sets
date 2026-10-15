import { expect } from "vitest";
import type { ChannelProviderIdentity } from "@chase-sets/channels";
import type { CommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { MoneyAmount } from "@chase-sets/primitives/money";
import { createEconomicsServices } from "../../features/economics/api/services";
import {
  assertChannelSourceEconomics,
  assertSourceEconomics,
  type ChannelSourceEconomics,
  type ResolveEconomicsRequest,
  type SourceEconomics,
} from "../../features/economics/domain/contracts";
import { ECONOMICS_LAUNCH_POLICY_VALUE, toResolvedEconomicsPolicy } from "../../features/economics/domain/policy";
import { createEconomicsProviderRegistry } from "../../features/economics/domain/provider-registry";
import { createNativeMarketplaceEconomicsProvider } from "../../features/economics/integrations/native-commercial-terms/provider";
import { deepFreeze, describeConformance, type ConformanceProperty } from "./kit";

type EconomicsProviderEntry = Readonly<{
  key: string;
  request: ResolveEconomicsRequest;
  /** Null for the native marketplace provider, which answers without a channel identity. */
  identity: ChannelProviderIdentity | null;
  /** Whether the composed provider has a source that prices this request. */
  prices: boolean;
  resolve: (request: ResolveEconomicsRequest) => Promise<SourceEconomics | ChannelSourceEconomics>;
  /** The same provider when its source cannot price the request. */
  resolveWithoutSource: (request: ResolveEconomicsRequest) => Promise<SourceEconomics | ChannelSourceEconomics>;
}>;

const effectiveAt = "2026-10-13T12:00:00Z";
const nativeRequest: ResolveEconomicsRequest = {
  accountId: "acc_conformance",
  scope: { kind: "native-marketplace" },
  catalogItemId: "cat_conformance",
  inventoryItemId: "inv_conformance",
  marketUnitPrice: { amount: "100.00" as MoneyAmount, currency: "usd" },
  quantity: 1,
  effectiveAt,
};
const channelIdentity: ChannelProviderIdentity = { providerKey: "tcgplayer", environment: "sandbox" };
const channelRequest: ResolveEconomicsRequest = {
  ...nativeRequest,
  scope: { kind: "channel-connection", connectionId: "conn_conformance" },
};
const resolvePolicy = async (at: string) =>
  toResolvedEconomicsPolicy({
    policyKey: "pricing.economics",
    value: ECONOMICS_LAUNCH_POLICY_VALUE,
    source: "fallback",
    documentId: null,
    effectiveFrom: null,
    effectiveUntil: null,
    resolvedAt: at,
  });
const listingTerms: Pick<CommercialTermsResolver, "resolveListingTerms"> = {
  resolveListingTerms: async (input) => ({
    accountId: input.accountId,
    accountType: "business",
    basisAmount: input.amount,
    marketplaceSalesFeeUnitAmount: "5.00",
    sellerNetUnitAmount: "95.00",
    marketplaceSalesFeePercentageBps: 500,
    marketplaceSalesFeeFixedAmount: "0.00",
    marketplaceSalesFeeCapAmount: "25.00",
    shippingAllowancePercentageBps: 1_000,
    scheduleId: "schedule_conformance",
    agreementId: "agreement_conformance",
    resolvedAt: input.effectiveAt,
  }),
};
const termsOutage: Pick<CommercialTermsResolver, "resolveListingTerms"> = {
  resolveListingTerms: async () => {
    throw new Error("Synthetic Commercial Terms outage.");
  },
};

/**
 * The production composition wires the native marketplace provider and an
 * Economics provider registry. No channel provider is registered there today,
 * so the registry answers its channel identity with its unregistered result;
 * a provider registered in `createEconomicsServices` is resolved here instead.
 */
function productionEconomicsProviders(): readonly EconomicsProviderEntry[] {
  const services = createEconomicsServices({
    eventStore: {} as EventStore,
    db: { query: async () => ({ rows: [] }) } as unknown as PgQueryable,
    policies: {} as PolicyRuntime,
    commercialTermsResolver: listingTerms as CommercialTermsResolver,
    channelConnectionIdentityReader: { resolve: async () => null },
  });
  const native = (commercialTermsResolver: Pick<CommercialTermsResolver, "resolveListingTerms">) =>
    createNativeMarketplaceEconomicsProvider({ commercialTermsResolver, resolvePolicy });
  const channel = services.providers.resolve(channelIdentity);
  return [
    {
      key: "native-marketplace",
      request: nativeRequest,
      identity: null,
      prices: true,
      resolve: (request) => native(listingTerms).resolve(request),
      resolveWithoutSource: (request) => native(termsOutage).resolve(request),
    },
    {
      key: `channel:${channelIdentity.providerKey}/${channelIdentity.environment}`,
      request: channelRequest,
      identity: channelIdentity,
      prices: false,
      resolve: (request) => channel.resolve(request),
      resolveWithoutSource: (request) => channel.resolve(request),
    },
  ];
}

/** The Economics provider contract: source facts in the request currency, never a decision. */
const economicsProviderProperties: readonly ConformanceProperty<EconomicsProviderEntry>[] = [
  {
    name: "resolves deterministically",
    check: async (entry) => {
      expect(await entry.resolve(entry.request)).toEqual(await entry.resolve(entry.request));
    },
  },
  {
    name: "answers source Economics in the request currency under its own identity",
    check: async (entry) => {
      const result = await entry.resolve(entry.request);
      const currency = entry.request.marketUnitPrice.currency;
      expect(result.kind).toBe(entry.prices ? "resolved" : "unavailable");
      if (entry.identity === null) assertSourceEconomics(result, currency);
      else {
        assertChannelSourceEconomics(result as ChannelSourceEconomics, currency);
        expect((result as ChannelSourceEconomics).providerIdentity).toEqual(entry.identity);
      }
    },
  },
  {
    name: "leaves the request unmodified",
    check: async (entry) => {
      const frozen = deepFreeze(structuredClone(entry.request));
      expect(await entry.resolve(frozen)).toEqual(await entry.resolve(entry.request));
    },
  },
  {
    name: "answers unavailable with a stable reason when its source cannot price",
    check: async (entry) => {
      const result = await entry.resolveWithoutSource(entry.request);
      expect(result.kind).toBe("unavailable");
      expect(["provider-unavailable", "terms-unavailable"]).toContain(
        result.kind === "unavailable" ? result.reason : null,
      );
      expect(await entry.resolveWithoutSource(entry.request)).toEqual(result);
    },
  },
];

describeConformance({
  registry: createEconomicsProviderRegistry,
  entries: productionEconomicsProviders,
  key: (entry) => entry.key,
  properties: economicsProviderProperties,
});
