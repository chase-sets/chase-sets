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
    commercialTermsResolver: CommercialTermsResolver;
    channelConnectionIdentityReader: ChannelConnectionIdentityReader;
  }>,
): EconomicsServices {
  if (!deps.commercialTermsResolver || !deps.channelConnectionIdentityReader) {
    throw new Error("Pricing Economics requires Commercial Terms and Channel Connection host ports.");
  }
  const resolvePolicy = async (effectiveAt: string) =>
    toResolvedEconomicsPolicy(await deps.policies.resolvePolicy(economicsPolicy, { at: effectiveAt }));
  const providers = createEconomicsProviderRegistry();
  const registerNativeCommercialTermsProvider = (identity: ChannelProviderIdentity) => {
    providers.registerExact(
      createNativeCommercialTermsEconomicsProvider({
        identity,
        commercialTermsResolver: deps.commercialTermsResolver,
        resolvePolicy,
      }),
    );
  };
  const overrides = createEconomicsOverrideRuntime({ eventStore: deps.eventStore, db: deps.db });
  const resolver = createEconomicsRuntime({
    channelConnectionIdentityReader: deps.channelConnectionIdentityReader,
    providerRegistry: providers,
    evidenceReader: createPostgresEconomicsEvidenceReader(deps.db),
    overrides,
    resolvePolicy,
  });

  return { resolve: resolver.resolve, overrides, providers, registerNativeCommercialTermsProvider };
}
