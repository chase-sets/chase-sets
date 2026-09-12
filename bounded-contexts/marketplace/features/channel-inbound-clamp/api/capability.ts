import type { MarketplaceChannelInboundClampCapability, MarketplaceChannelInboundClampPort } from "../domain/contracts";

export type MarketplaceChannelInboundClampServiceSource = Readonly<{
  channelInboundClamp: MarketplaceChannelInboundClampPort;
}>;

export function createMarketplaceChannelInboundClampCapability(
  mounted: boolean,
  getServices: () => MarketplaceChannelInboundClampServiceSource | undefined,
): MarketplaceChannelInboundClampCapability {
  if (!mounted) return { kind: "not-mounted" };
  const service = () => {
    const services = getServices();
    if (!services) throw new Error("Marketplace Channel Inbound Clamp service is unavailable.");
    return services.channelInboundClamp;
  };
  return {
    kind: "available",
    port: {
      engage: async (input, context) => service().engage(input, context),
      recover: async (input, context) => service().recover(input, context),
    },
  };
}
