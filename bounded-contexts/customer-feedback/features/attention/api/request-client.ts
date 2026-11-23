import type { FeedbackAttentionResponse } from "./attention-contract";

type FeedbackAttentionRouteData = FeedbackAttentionResponse &
  Readonly<{
    /** The case a deep link selected; the queue then holds only that case's items. */
    caseId: string | null;
  }>;

export async function loadFeedbackAttentionRouteData(request: Request): Promise<FeedbackAttentionRouteData> {
  const caseId = new URL(request.url).searchParams.get("caseId") || null;
  const url = new URL("/api/customer-feedback/attention", request.url);
  if (caseId) url.searchParams.set("caseId", caseId);
  const response = await fetch(url, { headers: { cookie: request.headers.get("cookie") ?? "" } });
  if (!response.ok) throw new Response("Unable to load customer feedback attention.", { status: response.status });
  const data: FeedbackAttentionResponse = await response.json();
  return { ...data, caseId };
}
