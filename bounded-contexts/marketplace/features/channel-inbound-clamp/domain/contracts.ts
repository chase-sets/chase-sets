import type { EventStoreContext } from "@chase-sets/event-core/storage";

export const MARKETPLACE_CHANNEL_INBOUND_CLAMP_PAGE_SIZE = 250;
export const MARKETPLACE_CHANNEL_INBOUND_CLAMP_MAX_LISTINGS = 1_000_000;

export type MarketplaceChannelInboundClampInput = Readonly<{
  accountId: string;
  connectionId: string;
  runId: string;
  listingIds: readonly string[];
}>;

export type MarketplaceChannelInboundClampResult = Readonly<{
  kind: "engaged" | "recovery";
  requestedListingCount: number;
  affectedListingCount: number;
  clampedListingCount: number;
  recoveryListingCount: number;
}>;

export type MarketplaceChannelInboundClampRecoveryResult = Readonly<{
  kind: "released" | "recovery";
  examinedListingCount: number;
  releasedListingCount: number;
  retainedListingCount: number;
  recoveryListingCount: number;
}>;

export interface MarketplaceChannelInboundClampPort {
  engage(
    input: MarketplaceChannelInboundClampInput,
    context: EventStoreContext,
  ): Promise<MarketplaceChannelInboundClampResult>;
  recover(
    input: MarketplaceChannelInboundClampInput,
    context: EventStoreContext,
  ): Promise<MarketplaceChannelInboundClampRecoveryResult>;
}

export type MarketplaceChannelInboundClampCapability =
  | Readonly<{ kind: "available"; port: MarketplaceChannelInboundClampPort }>
  | Readonly<{ kind: "not-mounted" }>;

export class MarketplaceChannelInboundClampError extends Error {
  public constructor(
    public readonly code:
      | "invalid-input"
      | "listing-membership-incomplete"
      | "listing-membership-unsafe"
      | "listing-cap-exceeded",
    message: string = code,
  ) {
    super(message);
    this.name = "MarketplaceChannelInboundClampError";
  }
}
