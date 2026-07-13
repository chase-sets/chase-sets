import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type {
  ListingEvidencePolicyOverview,
  ListingEvidencePolicySelectorCatalog,
  ListingEvidencePolicyValidation,
} from "./runtime";
import type { ListingEvidencePolicyRule } from "../domain/policy";

export type {
  ListingEvidencePolicyOverview,
  ListingEvidencePolicyRule,
  ListingEvidencePolicySelectorCatalog,
  ListingEvidencePolicyValidation,
};

function url(request: Request, ...segments: readonly string[]) {
  const value = new URL(resolveRequestApiBaseUrl(request, "/api/marketplace/listing-evidence-policy"));
  for (const segment of segments)
    value.pathname = `${value.pathname.replace(/\/$/, "")}/${encodeURIComponent(segment)}`;
  return value;
}

async function read<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new ListingEvidencePolicyRequestError(
      body?.error?.message ?? `Listing Evidence Policy request failed (${response.status}).`,
    );
  }
  return (await response.json()) as T;
}

export class ListingEvidencePolicyRequestError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ListingEvidencePolicyRequestError";
  }
}

export async function loadListingEvidencePolicyOverview(request: Request) {
  return read<ListingEvidencePolicyOverview>(
    await fetch(url(request), { headers: createForwardedAuthHeaders(request) }),
  );
}

export async function loadListingEvidencePolicySelectors(request: Request) {
  return read<ListingEvidencePolicySelectorCatalog>(
    await fetch(url(request, "selectors"), { headers: createForwardedAuthHeaders(request) }),
  );
}

async function post<T>(request: Request, segments: readonly string[], body?: unknown) {
  return read<T>(
    await fetch(url(request, ...segments), {
      method: "POST",
      headers: createForwardedAuthHeaders(request, { "content-type": "application/json" }),
      body: JSON.stringify(body ?? {}),
    }),
  );
}

export function createListingEvidencePolicyDraft(
  request: Request,
  body: Readonly<{ policyName: string; rules: readonly ListingEvidencePolicyRule[] }>,
) {
  return post<Readonly<{ policyId: string; version: number; lifecycle: "draft" }>>(request, ["drafts"], body);
}

export function validateListingEvidencePolicyDraft(request: Request, policyId: string) {
  return post<ListingEvidencePolicyValidation & Readonly<{ documentId: string; version: number }>>(request, [
    "drafts",
    policyId,
    "validate",
  ]);
}

export function rejectListingEvidencePolicyDraft(request: Request, policyId: string) {
  return post(request, ["drafts", policyId, "reject"]);
}

export function activateListingEvidencePolicyDraft(
  request: Request,
  policyId: string,
  body: Readonly<{ effectiveFrom: string; effectiveUntil: string | null; impactAcknowledgmentHash: string }>,
) {
  return post(request, ["drafts", policyId, "activate"], body);
}

export function createListingEvidencePolicyRollbackDraft(request: Request, policyId: string) {
  return post(request, ["documents", policyId, "rollback-draft"]);
}
