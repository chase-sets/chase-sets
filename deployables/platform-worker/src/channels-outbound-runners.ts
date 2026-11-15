import {
  createMarketplaceChannelInboundClampCapability,
  type MarketplaceChannelInboundClampCapability,
  type MarketplaceChannelInboundClampPort,
} from "@chase-sets/marketplace/server";

export function createPlatformWorkerMarketplaceChannelInboundClampBinding(
  mounted: boolean,
  getServices: () => Readonly<{ channelInboundClamp: MarketplaceChannelInboundClampPort }> | undefined,
): MarketplaceChannelInboundClampCapability {
  return createMarketplaceChannelInboundClampCapability(mounted, getServices);
}
