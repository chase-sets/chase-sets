import type { ChannelProviderIdentity } from "@chase-sets/channels";
import {
  assertProviderIdentity,
  type EconomicsProvider,
  type EconomicsProviderRegistry,
  type ResolveEconomicsRequest,
  type SourceEconomics,
} from "./contracts";

export function createEconomicsProviderRegistry(): EconomicsProviderRegistry {
  const exact = new Map<string, EconomicsProvider>();
  let externalFallback: EconomicsProvider | null = null;

  return {
    registerExact(provider) {
      assertProviderIdentity(provider.identity);
      const key = identityKey(provider.identity);
      if (exact.has(key)) throw new Error(`An exact Economics provider is already registered for ${key}.`);
      if (externalFallback && identityKey(externalFallback.identity) === key) {
        throw new Error(`The exact provider ${key} must be structurally distinct from the external fallback.`);
      }
      exact.set(key, guardProvider(provider));
    },
    registerExternalFallback(provider) {
      assertProviderIdentity(provider.identity);
      if (externalFallback) throw new Error("Only one external Economics fallback may be registered.");
      const key = identityKey(provider.identity);
      if (exact.has(key)) throw new Error(`The external fallback ${key} must be structurally distinct from exact providers.`);
      externalFallback = guardProvider(provider);
    },
    resolve(identity) {
      assertProviderIdentity(identity);
      return exact.get(identityKey(identity)) ?? externalFallback ?? unavailableProvider(identity);
    },
  };
}

function guardProvider(provider: EconomicsProvider): EconomicsProvider {
  return {
    identity: provider.identity,
    async resolve(request: ResolveEconomicsRequest): Promise<SourceEconomics> {
      const result = await provider.resolve(request);
      assertProviderIdentity(result.providerIdentity);
      if (identityKey(result.providerIdentity) !== identityKey(provider.identity)) {
        throw new Error("Economics provider returned an identity different from its registration.");
      }
      return result;
    },
  };
}

function unavailableProvider(identity: ChannelProviderIdentity): EconomicsProvider {
  return {
    identity,
    async resolve() {
      return { kind: "unavailable", providerIdentity: identity, reason: "provider-unavailable" };
    },
  };
}

function identityKey(identity: ChannelProviderIdentity): string {
  return `${identity.providerKey}\u0000${identity.environment}`;
}

