import {
  aggregateSellerAttentionQueue,
  type SellerAttentionContext,
  type SellerAttentionQueue,
  type SellerAttentionSource,
} from "@chase-sets/seller-attention-queue";

export type SellerAttentionQueuePort = Readonly<{
  loadQueue: (context: SellerAttentionContext) => Promise<SellerAttentionQueue>;
}>;

export function createSellerAttentionQueueRuntime(sources: readonly SellerAttentionSource[]): SellerAttentionQueuePort {
  return {
    loadQueue: (context) => aggregateSellerAttentionQueue(sources, context),
  };
}
