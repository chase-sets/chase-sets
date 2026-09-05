type ChannelEnvironment = "sandbox" | "production";

export type LocallyRedeclaredResolver = Readonly<{
  resolve(input: Readonly<{ providerKey: string; environment: ChannelEnvironment }>): Promise<null>;
}>;
