import type { FeedbackAttentionQueueItem } from "../read-model/queries";

export type FeedbackAttentionMetrics = Readonly<{
  activeCount: number;
  overdueCount: number;
  medianTimeToTriageMs: number | null;
  medianTimeToCloseMs: number | null;
  oldestOverdueMs: number | null;
  deliverySuccesses: number;
  deliveryFailures: number;
  digestPending: number;
  digestFailures: number;
  latestDigestAt: string | null;
}>;

export type FeedbackAttentionResponse = Readonly<{
  items: readonly FeedbackAttentionQueueItem[];
  metrics: FeedbackAttentionMetrics;
}>;
