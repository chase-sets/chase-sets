import { FeedbackAttentionSurface, type FeedbackAttentionMetrics } from "./attention-surface";
import type { FeedbackAttentionItem } from "../domain";

export { FeedbackAttentionSurface };

export type FeedbackAttentionRouteData = Readonly<{
  items: readonly FeedbackAttentionItem[];
  metrics: FeedbackAttentionMetrics;
}>;

export async function loadFeedbackAttentionRouteData(request: Request): Promise<FeedbackAttentionRouteData> {
  const url = new URL("/api/customer-feedback/attention", request.url);
  const response = await fetch(url, { headers: { cookie: request.headers.get("cookie") ?? "" } });
  if (!response.ok) throw new Response("Unable to load customer feedback attention.", { status: response.status });
  return response.json() as Promise<FeedbackAttentionRouteData>;
}
