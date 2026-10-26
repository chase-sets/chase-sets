import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type { OperationsAttentionQueue } from "../../features/operations-attention-queue/read-model/attention-queue";

export async function loadOperationsAttentionQueue(request: Request): Promise<OperationsAttentionQueue> {
  const response = await fetch(resolveRequestApiBaseUrl(request, "/api/platform/operations-attention"), {
    headers: createForwardedAuthHeaders(request),
  });

  if (!response.ok) {
    throw new Response(await response.text(), { status: response.status });
  }

  return (await response.json()) as OperationsAttentionQueue;
}
