import type { ChannelProviderIdentity } from "@chase-sets/channels";
import type { CommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { ChannelConnectionIdentityReader, EconomicsProviderRegistry } from "../domain/contracts";
import { economicsPolicy, toResolvedEconomicsPolicy } from "../domain/policy";
import { createEconomicsProviderRegistry } from "../domain/provider-registry";
import type { EconomicsResolver } from "../domain/resolution";
import { createNativeCommercialTermsEconomicsProvider } from "../integrations/native-commercial-terms/provider";
import { createPostgresEconomicsEvidenceReader } from "../read-model/evidence-queries";
import { createEconomicsOverrideRuntime, type EconomicsOverrideRuntime } from "./override-runtime";
import { createEconomicsRuntime } from "./runtime";

export type EconomicsServices = EconomicsResolver &
  Readonly<{
    overrides: EconomicsOverrideRuntime;
    providers: EconomicsProviderRegistry;
    registerNativeCommercialTermsProvider(identity: ChannelProviderIdentity): void;
  }>;

export function createEconomicsServices(
  deps: Readonly<{
    eventStore: EventStore;
    db: PgQueryable;
    policies: PolicyRuntime;
    commercialTermsResolver?: Pick<CommercialTermsResolver, "resolveListingTerms"> | null;
    channelConnectionIdentityReader?: ChannelConnectionIdentityReader | null;
  }>,
): EconomicsServices {
  const resolvePolicy = async (effectiveAt: string) =>
    toResolvedEconomicsPolicy(await deps.policies.resolvePolicy(economicsPolicy, { at: effectiveAt }));
  const commercialTermsResolver = deps.commercialTermsResolver ?? unavailableCommercialTermsResolver;
  const providers = createEconomicsProviderRegistry();
  const registerNativeCommercialTermsProvider = (identity: ChannelProviderIdentity) => {
    providers.registerExact(
      createNativeCommercialTermsEconomicsProvider({ identity, commercialTermsResolver, resolvePolicy }),
    );
  };
  const overrides = createEconomicsOverrideRuntime({ eventStore: deps.eventStore, db: deps.db });
  const resolver = createEconomicsRuntime({
    channelConnectionIdentityReader: deps.channelConnectionIdentityReader ?? absentChannelConnectionIdentityReader,
    providerRegistry: providers,
    evidenceReader: createPostgresEconomicsEvidenceReader(deps.db),
    overrides,
    resolvePolicy,
  });

  return { resolve: resolver.resolve, overrides, providers, registerNativeCommercialTermsProvider };
}

const absentChannelConnectionIdentityReader: ChannelConnectionIdentityReader = {
  resolve: async () => null,
};

const unavailableCommercialTermsResolver: Pick<CommercialTermsResolver, "resolveListingTerms"> = {
  resolveListingTerms: async () => {
    throw new Error("Commercial Terms is not mounted for Pricing Economics.");
  },
};
