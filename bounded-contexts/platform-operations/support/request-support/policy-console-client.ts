import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type {
  CreatePolicyConsoleRevisionRequest,
  PolicyConsoleOverview,
  PolicyConsoleRegistryItem,
} from "../../features/policy-console/api/contracts";

export type { CreatePolicyConsoleRevisionRequest, PolicyConsoleOverview, PolicyConsoleRegistryItem };

export type PolicyConsoleRegistryResponse = Readonly<{
  items: readonly PolicyConsoleRegistryItem[];
  commercialTermsSchedulesHref: string;
}>;

export type PolicyConsoleDocumentHistoryRow = Readonly<{
  history_id: string;
  event_type: string;
  actor_user_id: string;
  status: string;
  effective_from: string;
  effective_until: string | null;
  recorded_at: string;
}>;

export type PolicyConsoleDocumentResponse = Readonly<{
  document_id: string;
  policy_key: string;
  context_name: string;
  status: string;
  history: readonly PolicyConsoleDocumentHistoryRow[];
}>;

function resolvePolicyConsoleApiUrl(request: Request, ...segments: readonly string[]) {
  const url = new URL(resolveRequestApiBaseUrl(request, "/api/platform/policy-console"));
  for (const segment of segments) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(segment)}`;
  }
  return url;
}

export async function loadPolicyConsoleRegistry(request: Request): Promise<PolicyConsoleRegistryResponse> {
  const response = await fetch(resolvePolicyConsoleApiUrl(request), {
    headers: createForwardedAuthHeaders(request),
  });

  if (!response.ok) {
    throw new Response(await response.text(), { status: response.status });
  }

  return (await response.json()) as PolicyConsoleRegistryResponse;
}

export async function loadPolicyConsoleOverview(request: Request, policyKey: string): Promise<PolicyConsoleOverview> {
  const response = await fetch(resolvePolicyConsoleApiUrl(request, policyKey), {
    headers: createForwardedAuthHeaders(request),
  });

  if (!response.ok) {
    throw new Response(await response.text(), { status: response.status });
  }

  return (await response.json()) as PolicyConsoleOverview;
}

export async function loadPolicyConsoleDocument(
  request: Request,
  policyKey: string,
  documentId: string,
): Promise<PolicyConsoleDocumentResponse> {
  const response = await fetch(resolvePolicyConsoleApiUrl(request, policyKey, "documents", documentId), {
    headers: createForwardedAuthHeaders(request),
  });

  if (!response.ok) {
    throw new Response(await response.text(), { status: response.status });
  }

  return (await response.json()) as PolicyConsoleDocumentResponse;
}

export class PolicyConsoleValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PolicyConsoleValidationError";
  }
}

export async function createPolicyConsoleRevision(
  request: Request,
  policyKey: string,
  body: CreatePolicyConsoleRevisionRequest,
): Promise<Readonly<{ id: string; version: number; scheduled: boolean }>> {
  const response = await fetch(resolvePolicyConsoleApiUrl(request, policyKey, "revisions"), {
    method: "POST",
    headers: createForwardedAuthHeaders(request, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });

  if (response.status === 400) {
    const errorBody = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new PolicyConsoleValidationError(errorBody?.error?.message ?? "Policy revision was rejected.");
  }

  if (!response.ok) {
    throw new Response(await response.text(), { status: response.status });
  }

  return (await response.json()) as Readonly<{ id: string; version: number; scheduled: boolean }>;
}
