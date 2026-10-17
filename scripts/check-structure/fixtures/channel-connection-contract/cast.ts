import type { ChannelConnectionSetupResolver } from "../../../../bounded-contexts/channels/features/connections/domain/contracts";

export function hideResolverDrift(value: unknown): ChannelConnectionSetupResolver {
  return value as { resolve(input: { providerKey: string; environment: "sandbox" | "production" }): Promise<null> };
}
