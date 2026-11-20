import { FeedbackAttentionSurface, type FeedbackAttentionMetrics } from "./attention-surface";
import type { FeedbackAttentionQueueItem } from "../read-model/queries";

export { FeedbackAttentionSurface };

export type FeedbackAttentionRouteData = Readonly<{
  items: readonly FeedbackAttentionQueueItem[];
  metrics: FeedbackAttentionMetrics;
  /** The case a deep link selected; the queue then holds only that case's items. */
  caseId: string | null;
}>;

export async function loadFeedbackAttentionRouteData(request: Request): Promise<FeedbackAttentionRouteData> {
  const caseId = new URL(request.url).searchParams.get("caseId") || null;
  const url = new URL("/api/customer-feedback/attention", request.url);
  if (caseId) url.searchParams.set("caseId", caseId);
  const response = await fetch(url, { headers: { cookie: request.headers.get("cookie") ?? "" } });
  if (!response.ok) throw new Response("Unable to load customer feedback attention.", { status: response.status });
  const data = (await response.json()) as Omit<FeedbackAttentionRouteData, "caseId">;
  return { ...data, caseId };
}
