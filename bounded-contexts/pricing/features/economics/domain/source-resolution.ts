import type { ChannelProviderIdentity } from "@chase-sets/channels";
import {
  assertProviderIdentity,
  parseResolveEconomicsRequest,
  type ChannelConnectionIdentityReader,
  type EconomicsProviderRegistry,
  type EconomicsScope,
  type NativeMarketplaceEconomicsProvider,
  type ResolveEconomicsRequest,
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
    nativeMarketplaceProvider: NativeMarketplaceEconomicsProvider;
    providerRegistry: EconomicsProviderRegistry;
  }>,
): Promise<
  Readonly<{
    channel: EconomicsScope;
    providerIdentity: ChannelProviderIdentity | null;
    source: SourceEconomics;
  }>
> {
  const request = parseResolveEconomicsRequest(input.request);
  if (request.scope.kind === "native-marketplace") {
    return {
      channel: request.scope,
      providerIdentity: null,
      source: await input.nativeMarketplaceProvider.resolve(request),
    };
  }
  const channel = await input.channelConnectionIdentityReader.resolve({
    accountId: request.accountId,
    connectionId: request.scope.connectionId,
  });
  if (channel === null || channel.connectionId !== request.scope.connectionId) {
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
  const { providerIdentity, ...sourceEconomics } = source;
  return {
    channel: request.scope,
    providerIdentity,
    source: sourceEconomics as SourceEconomics,
  };
}
