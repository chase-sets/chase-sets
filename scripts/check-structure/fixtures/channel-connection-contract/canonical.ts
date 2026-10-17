import type {
  ChannelConnectionSetupResolver,
  ChannelEnvironment,
} from "../../../../bounded-contexts/channels/features/connections/domain/contracts";

export function resolveCanonical(resolver: ChannelConnectionSetupResolver, environment: ChannelEnvironment) {
  return resolver.resolve({ providerKey: "fixture-provider", environment });
}
