import type { ChannelProviderIdentity } from "@chase-sets/channels";
import {
  assertProviderIdentity,
  assertChannelSourceEconomics,
  type ChannelSourceEconomics,
  type EconomicsProvider,
  type EconomicsProviderRegistry,
  type ResolveEconomicsRequest,
} from "./contracts";

export function createEconomicsProviderRegistry(): EconomicsProviderRegistry {
  const exact = new Map<string, EconomicsProvider>();
  let externalFallback: EconomicsProvider | null = null;

  return {
    registerExact(provider) {
      assertProviderIdentity(provider.identity);
      const key = identityKey(provider.identity);
      if (exact.has(key)) throw new Error(`An exact Economics provider is already registered for ${key}.`);
      exact.set(key, guardProvider(provider));
    },
    registerExternalFallback(provider) {
      assertProviderIdentity(provider.identity);
      if (externalFallback) throw new Error("Only one external Economics fallback may be registered.");
      externalFallback = guardProvider(provider);
    },
    resolve(identity) {
      assertProviderIdentity(identity);
      const key = identityKey(identity);
      return (
        exact.get(key) ??
        (externalFallback && identityKey(externalFallback.identity) === key
          ? externalFallback
          : unavailableProvider(identity))
      );
    },
  };
}

function guardProvider(provider: EconomicsProvider): EconomicsProvider {
  const registeredIdentity = Object.freeze({ ...provider.identity });
  return {
    identity: registeredIdentity,
    async resolve(request: ResolveEconomicsRequest): Promise<ChannelSourceEconomics> {
      const result = await provider.resolve(request);
      assertChannelSourceEconomics(result, request.marketUnitPrice.currency);
      if (identityKey(result.providerIdentity) !== identityKey(registeredIdentity)) {
        throw new Error("Economics provider returned an identity different from its registration.");
      }
      return result;
    },
  };
}

function unavailableProvider(identity: ChannelProviderIdentity): EconomicsProvider {
  const unavailableIdentity = Object.freeze({ ...identity });
  return {
    identity: unavailableIdentity,
    async resolve() {
      return { kind: "unavailable", providerIdentity: unavailableIdentity, reason: "provider-unavailable" };
    },
  };
}

function identityKey(identity: ChannelProviderIdentity): string {
  return `${identity.providerKey}\u0000${identity.environment}`;
}
