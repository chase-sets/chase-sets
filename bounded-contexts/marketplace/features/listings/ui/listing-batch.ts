import type { createMarketplaceApiClient } from "../../../client";
import {
  ambiguousListingRecovery,
  listingRecoveryFields,
  listingRecoveryReferenceSchema,
  type ListingRecovery,
  type ListingRecoveryReference,
} from "./contracts";

export { ambiguousListingRecovery, type ListingRecoveryReference, type ListingRecoveryOutcome } from "./contracts";
export type ListingRecoveryView = Omit<ListingRecovery, "phase"> & { phase: ListingRecovery["phase"] | "loading" };

export const LISTING_RECOVERY_PARAM = "listingRecovery";
export const failedListingPreparation: ListingRecovery = { ...ambiguousListingRecovery, phase: "failed-safe" };

export function listingRecoveryUrl(path: string, reference: ListingRecoveryReference) {
  const url = new URL(path, "https://recovery.invalid");
  const publicationEvent = url.searchParams.get("evidenceEvent") === "publication_succeeded";
  url.search = "";
  if (publicationEvent) url.searchParams.set("evidenceEvent", "publication_succeeded");
  const { batchId, mutationKind, bulk } = reference;
  url.searchParams.set(LISTING_RECOVERY_PARAM, JSON.stringify({ batchId, mutationKind, bulk }));
  return `${url.pathname}${url.search}`;
}

export function readListingRecoveryReference(request: Request) {
  const value = new URL(request.url).searchParams.get(LISTING_RECOVERY_PARAM);
  return value === null ? null : listingRecoveryReferenceSchema.parse(JSON.parse(value));
}

export async function loadListingRecovery(
  api: Pick<ReturnType<typeof createMarketplaceApiClient>, "recoverListingBatch">,
  request: Request,
): Promise<ListingRecovery | null> {
  try {
    const reference = readListingRecoveryReference(request);
    return reference ? await api.recoverListingBatch(reference) : null;
  } catch {
    return ambiguousListingRecovery;
  }
}

export function prepareListingForm(
  api: Pick<ReturnType<typeof createMarketplaceApiClient>, "prepareListingBatch">,
  form: FormData,
  listingId: string | null,
  retained?: ListingRecoveryReference,
) {
  return api.prepareListingBatch({
    intent: String(form.get("intent") ?? ""),
    idempotencyKey: form.has("idempotencyKey") ? String(form.get("idempotencyKey")) : null,
    listingId,
    listingIds: form.getAll("listingIds").map(String),
    fields: Object.fromEntries(
      listingRecoveryFields.filter((key) => form.has(key)).map((key) => [key, String(form.get(key))]),
    ),
    ...(retained ? { retained } : {}),
  });
}

export async function prepareListingAction(
  api: Parameters<typeof prepareListingForm>[0],
  request: Request,
  form: FormData,
  listingId: string | null,
  required = false,
) {
  let retained;
  try {
    retained = readListingRecoveryReference(request);
  } catch {
    return { recovery: ambiguousListingRecovery };
  }
  if (!retained && !required) return { reference: null };
  if (!retained && !form.has("idempotencyKey")) return { recovery: failedListingPreparation };
  try {
    const result = await prepareListingForm(api, form, listingId, retained ?? undefined);
    if (required && !("recovery" in result) && !result.reference) return { recovery: failedListingPreparation };
    return result;
  } catch {
    return { recovery: retained ? ambiguousListingRecovery : failedListingPreparation };
  }
}
