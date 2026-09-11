type ChannelEnvironment = "sandbox" | "production";
type ChannelProviderIdentity = Readonly<{ providerKey: string; environment: ChannelEnvironment }>;

export type EconomicsChannel = Readonly<{
  environment: ChannelEnvironment;
  providerIdentity: ChannelProviderIdentity;
}>;
