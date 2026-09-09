import { describe, expect, it, vi } from "vitest";
import type { ChannelProviderIdentity } from "@chase-sets/channels";
import type { MoneyAmount } from "@chase-sets/primitives/money";
import { createEconomicsProviderRegistry } from "./provider-registry";
import { quoteSellerOverhead } from "./overhead";
import { ChannelConnectionNotFoundError, resolveSourceEconomics } from "./source-resolution";
import type { EconomicsProvider, ResolveEconomicsRequest } from "./contracts";

const ownedConnectionId = "synthetic-connection-1";
const request: ResolveEconomicsRequest = {
  accountId: "synthetic-owner-account",
  scope: { kind: "channel-connection", connectionId: ownedConnectionId },
  catalogItemId: "synthetic-catalog-item",
  inventoryItemId: "synthetic-inventory-item",
  marketUnitPrice: { amount: "100.00" as MoneyAmount, currency: "usd" },
  quantity: 1,
  effectiveAt: "2026-09-07T06:00:00Z",
};
const nativeIdentity = { providerKey: "synthetic-provider-a", environment: "sandbox" } as const;
const unreachableNativeMarketplaceProvider = {
  resolve: async () => {
    throw new Error("synthetic native provider must not be called");
  },
};

function unavailableProvider(
  identity: ChannelProviderIdentity,
  reason: "provider-unavailable" | "terms-unavailable" = "provider-unavailable",
): EconomicsProvider {
  return { identity, resolve: async () => ({ kind: "unavailable", providerIdentity: identity, reason }) };
}

describe("Economics provider selection", () => {
  it("prefers exact registration, permits a single fallback, and needs no consumer branch for a second exact provider", async () => {
    const registry = createEconomicsProviderRegistry();
    const fallback = unavailableProvider(nativeIdentity, "provider-unavailable");
    const second = unavailableProvider(
      { providerKey: "synthetic-provider-b", environment: "production" },
      "terms-unavailable",
    );
    registry.registerExternalFallback(fallback);
    registry.registerExact(unavailableProvider(nativeIdentity, "terms-unavailable"));
    registry.registerExact(second);

    await expect(registry.resolve(nativeIdentity).resolve(request)).resolves.toMatchObject({
      reason: "terms-unavailable",
    });
    await expect(registry.resolve(second.identity).resolve(request)).resolves.toMatchObject({
      reason: "terms-unavailable",
    });
    expect(registry.resolve({ providerKey: "synthetic-provider-c", environment: "sandbox" }).identity).toEqual({
      providerKey: "synthetic-provider-c",
      environment: "sandbox",
    });
  });

  it("uses the structurally separate fallback slot only for its exact identity", async () => {
    const registry = createEconomicsProviderRegistry();
    const fallbackIdentity = { providerKey: "synthetic-external-fallback", environment: "sandbox" } as const;
    registry.registerExternalFallback(unavailableProvider(fallbackIdentity, "terms-unavailable"));

    await expect(registry.resolve(fallbackIdentity).resolve(request)).resolves.toMatchObject({
      providerIdentity: fallbackIdentity,
      reason: "terms-unavailable",
    });
    await expect(
      registry.resolve({ providerKey: "synthetic-provider-c", environment: "sandbox" }).resolve(request),
    ).resolves.toMatchObject({ reason: "provider-unavailable" });
  });

  it("rejects duplicate slots, invalid identities, and a provider result identity mismatch", async () => {
    const registry = createEconomicsProviderRegistry();
    registry.registerExact(unavailableProvider(nativeIdentity));
    expect(() => registry.registerExact(unavailableProvider(nativeIdentity))).toThrow(/already registered/);
    expect(() => registry.registerExact(unavailableProvider({ providerKey: "*", environment: "sandbox" }))).toThrow();
    registry.registerExternalFallback(
      unavailableProvider({ providerKey: "synthetic-fallback", environment: "production" }),
    );
    expect(() =>
      registry.registerExternalFallback(unavailableProvider({ providerKey: "another", environment: "sandbox" })),
    ).toThrow();

    const badRegistry = createEconomicsProviderRegistry();
    badRegistry.registerExact({
      identity: nativeIdentity,
      resolve: async () => ({
        kind: "unavailable",
        providerIdentity: { providerKey: "synthetic-other", environment: "sandbox" },
        reason: "provider-unavailable",
      }),
    });
    await expect(badRegistry.resolve(nativeIdentity).resolve(request)).rejects.toThrow(/different/);
  });

  it("returns a numeric-policy unavailable reason when neither slot exists", async () => {
    const registry = createEconomicsProviderRegistry();
    await expect(registry.resolve(nativeIdentity).resolve(request)).resolves.toEqual({
      kind: "unavailable",
      providerIdentity: nativeIdentity,
      reason: "provider-unavailable",
    });
  });
});

describe("account-scoped Channel identity", () => {
  it("resolves the account-qualified connection before consulting the registry and never reads status", async () => {
    const calls: string[] = [];
    const registry = createEconomicsProviderRegistry();
    registry.registerExact({
      ...unavailableProvider(nativeIdentity),
      resolve: async () => {
        calls.push("provider");
        return { kind: "unavailable", providerIdentity: nativeIdentity, reason: "provider-unavailable" };
      },
    });
    const reader = {
      resolve: vi.fn(async ({ accountId, connectionId }) => {
        calls.push("reader");
        return accountId === request.accountId && connectionId === ownedConnectionId
          ? { connectionId, ...nativeIdentity }
          : null;
      }),
    };
    const result = await resolveSourceEconomics({
      request,
      channelConnectionIdentityReader: reader,
      nativeMarketplaceProvider: unreachableNativeMarketplaceProvider,
      providerRegistry: registry,
    });
    expect(calls).toEqual(["reader", "provider"]);
    expect(result.channel).toEqual(request.scope);
    expect(result.providerIdentity).toEqual(nativeIdentity);
    expect(reader.resolve).toHaveBeenCalledWith({
      accountId: request.accountId,
      connectionId: ownedConnectionId,
    });
  });

  it("routes native marketplace directly without consulting Channels or the registry", async () => {
    const channelConnectionIdentityReader = { resolve: vi.fn() };
    const providerRegistry = { registerExact: vi.fn(), registerExternalFallback: vi.fn(), resolve: vi.fn() };
    const source = { kind: "unavailable", reason: "terms-unavailable" } as const;
    const nativeMarketplaceProvider = { resolve: vi.fn(async () => source) };
    const nativeRequest = { ...request, scope: { kind: "native-marketplace" } as const };

    await expect(
      resolveSourceEconomics({
        request: nativeRequest,
        channelConnectionIdentityReader,
        nativeMarketplaceProvider,
        providerRegistry,
      }),
    ).resolves.toEqual({
      channel: { kind: "native-marketplace" },
      providerIdentity: null,
      source,
    });
    expect(channelConnectionIdentityReader.resolve).not.toHaveBeenCalled();
    expect(providerRegistry.resolve).not.toHaveBeenCalled();
  });

  it("fails the mutant that routes native marketplace through the channel registry", async () => {
    const nativeRequest = { ...request, scope: { kind: "native-marketplace" } as const };
    const registryMutant = vi.fn(() => {
      throw new Error("native marketplace reached the registry");
    });

    await expect(
      resolveSourceEconomics({
        request: nativeRequest,
        channelConnectionIdentityReader: { resolve: vi.fn() },
        nativeMarketplaceProvider: { resolve: async () => ({ kind: "unavailable", reason: "terms-unavailable" }) },
        providerRegistry: { registerExact: vi.fn(), registerExternalFallback: vi.fn(), resolve: registryMutant },
      }),
    ).resolves.toMatchObject({ channel: { kind: "native-marketplace" }, providerIdentity: null });
    expect(registryMutant).not.toHaveBeenCalled();
  });

  it.each(["synthetic-foreign-account", "synthetic-owner-account"])(
    "keeps foreign and absent connections indistinguishable for %s",
    async (accountId) => {
      const registry = { registerExact: vi.fn(), registerExternalFallback: vi.fn(), resolve: vi.fn() };
      await expect(
        resolveSourceEconomics({
          request: {
            ...request,
            accountId,
            scope: {
              kind: "channel-connection",
              connectionId: accountId === request.accountId ? "synthetic-absent-connection" : ownedConnectionId,
            },
          },
          channelConnectionIdentityReader: { resolve: async () => null },
          nativeMarketplaceProvider: unreachableNativeMarketplaceProvider,
          providerRegistry: registry,
        }),
      ).rejects.toEqual(new ChannelConnectionNotFoundError());
      expect(registry.resolve).not.toHaveBeenCalled();
    },
  );
});

describe("seller overhead", () => {
  const money = (amount: string) => ({ amount: amount as MoneyAmount, currency: "usd" });
  const terms = {
    platformFeeRelativeBps: 500,
    platformFeeFixedPerUnitAmount: money("0.00"),
    platformFeeCapPerUnitAmount: money("25.00"),
    sellerHandlingRelativeBps: 0,
    sellerHandlingFixedPerUnitAmount: money("0.30"),
    sellerHandlingCapPerUnitAmount: null,
  };

  it.each([
    ["0.01", 1, "0.31", "0.00"],
    ["19.99", 1, "1.30", "18.69"],
    ["100.00", 1, "5.30", "94.70"],
    ["499.80", 1, "25.29", "474.51"],
    ["500.00", 1, "25.30", "474.70"],
    ["1000.00", 1, "25.30", "974.70"],
    ["100.00", 3, "15.90", "284.10"],
  ])("quotes %s x %i with per-unit ceil/cap/fixed laws", (unitPrice, quantity, overhead, net) => {
    const quote = quoteSellerOverhead(money(unitPrice), quantity, terms);
    expect(quote.orderOverheadAmount.amount).toBe(overhead);
    expect(quote.netProceedsAmount.amount).toBe(net);
  });

  it("rejects an order total outside the shared Money magnitude", () => {
    expect(() => quoteSellerOverhead(money("9999999999.99"), 2, terms)).toThrow(/Money cents/);
  });
});
