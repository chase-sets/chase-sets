import type { ChannelEnvironment, ChannelProviderIdentity } from "@chase-sets/channels";

export type EconomicsChannel = Readonly<{
  environment: ChannelEnvironment;
  providerIdentity: ChannelProviderIdentity;
}>;
