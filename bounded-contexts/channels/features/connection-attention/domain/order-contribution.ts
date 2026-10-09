export const channelOrderAttentionReasons = [
  "channel-order-unmapped",
  "channel-order-sale-absent",
  "tcgplayer-order-unmapped",
  "tcgplayer-order-identity-ambiguous",
  "tcgplayer-order-recording-refused",
  "tcgplayer-order-cancelled",
  "backdated-sale",
] as const;
export type ChannelOrderAttentionReason = (typeof channelOrderAttentionReasons)[number];
export type ChannelOrderAttention = Readonly<{
  externalOrderReference: string;
  reason: ChannelOrderAttentionReason;
  generation: number;
  openedAt: string;
  affectedLineCount: number;
}>;
export type ChannelOrderAttentionPage = Readonly<{
  items: readonly ChannelOrderAttention[];
  count: number;
  hasMore: boolean;
  nextCursor: string | null;
}>;
