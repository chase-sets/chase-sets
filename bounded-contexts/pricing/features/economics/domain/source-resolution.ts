import {
  assertProviderIdentity,
  parseResolveEconomicsRequest,
  type ChannelConnectionIdentityReader,
  type EconomicsProviderRegistry,
  type ResolveEconomicsRequest,
  type ResolvedChannelConnection,
  type SourceEconomics,
} from "./contracts";

export class ChannelConnectionNotFoundError extends Error {
  public readonly code = "channel-connection-not-found";

  public constructor() {
    super("channel-connection-not-found");
    this.name = "ChannelConnectionNotFoundError";
  }
}

export async function resolveSourceEconomics(
  input: Readonly<{
    request: ResolveEconomicsRequest;
    channelConnectionIdentityReader: ChannelConnectionIdentityReader;
    providerRegistry: EconomicsProviderRegistry;
  }>,
): Promise<Readonly<{ channel: ResolvedChannelConnection; source: SourceEconomics }>> {
  const request = parseResolveEconomicsRequest(input.request);
  const channel = await input.channelConnectionIdentityReader.resolve({
    accountId: request.accountId,
    connectionId: request.connectionId,
  });
  if (channel === null || channel.connectionId !== request.connectionId) {
    throw new ChannelConnectionNotFoundError();
  }
  assertProviderIdentity({ providerKey: channel.providerKey, environment: channel.environment });
  const provider = input.providerRegistry.resolve({
    providerKey: channel.providerKey,
    environment: channel.environment,
  });
  const source = await provider.resolve(request);
  if (
    source.providerIdentity.providerKey !== channel.providerKey ||
    source.providerIdentity.environment !== channel.environment
  ) {
    throw new Error("Resolved Economics provider does not match the Channel connection.");
  }
  return { channel, source };
}
