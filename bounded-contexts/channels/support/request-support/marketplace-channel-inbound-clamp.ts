import type { MarketplaceChannelInboundClampCapability as MarketplaceCapability } from "@chase-sets/marketplace/server";

// Request-time adapter seam: Marketplace owns the clamp contract and behavior;
// Channels receives only the mounted capability from the deployable host.
export type MarketplaceChannelInboundClampCapability = MarketplaceCapability;
