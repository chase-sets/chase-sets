/**
 * The Checkout Session entry attempt contract, shared by the session
 * route and every caller that resolves an entry by lookup.
 *
 * The owner and the caller derive the same canonical payload from the same
 * request body, so the request hash agrees without either side normalizing the
 * other's fields. Display-only fields (titles, summaries, prices shown on the
 * page) never enter it; quantity, the source identity and the presented
 * anonymous cart always do. Nothing here imports a server module.
 */
import { normalizePresentedAnonymousCartId } from "../../cart/api/contracts";
import { parseCartReadinessDecisionInput } from "../../cart/domain/readiness";
import {
  CHECKOUT_ENTRY_ATTEMPT_KIND,
  CHECKOUT_ENTRY_ATTEMPT_TARGET,
  isCheckoutCommandAttemptId,
  type CheckoutCommandAttemptResult,
} from "./contracts";

export type CheckoutEntryOptimizationGoal = "lowest-total" | "fewest-shipments";

type SelectedOption = Readonly<{ dimensionId: string; optionId: string }>;

/** The canonical source an entry opens a Session from; the session id derivation hashes it unchanged. */
export type CheckoutEntrySource =
  | Readonly<{
      type: "cart";
      readinessSnapshotId: string;
      readinessSourceRevision: string;
      readinessDecisions: ReturnType<typeof parseCartReadinessDecisionInput>;
      presentedAnonymousCartId?: string;
    }>
  | Readonly<{
      type: "buy-now";
      listingId: string;
      catalogItemId: string;
      productId: string;
      selectedOptions: readonly SelectedOption[];
      quantity: number;
      fulfillmentMode: "locked-listing";
      lockedListingId: string;
      sellerPreferenceId: string | null;
    }>
  | Readonly<{
      type: "offer-intent";
      catalogItemId: string;
      productId: string;
      selectedOptions: readonly SelectedOption[];
      offerPriceAmount: string;
      offerPriceCurrencyCode: string;
      quantity: number;
    }>;

export type CheckoutEntryPayload = Readonly<{
  source: CheckoutEntrySource;
  shippingOption: string;
  optimizationGoal: CheckoutEntryOptimizationGoal;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseSelectedOptions(value: unknown): SelectedOption[] {
  return Array.isArray(value)
    ? value
        .filter((selection): selection is { dimensionId: unknown; optionId: unknown } =>
          Boolean(selection && typeof selection === "object" && "dimensionId" in selection && "optionId" in selection),
        )
        .map((selection) => ({
          dimensionId: String(selection.dimensionId ?? ""),
          optionId: String(selection.optionId ?? ""),
        }))
    : [];
}

export function parseCheckoutEntryOptimizationGoal(value: unknown): CheckoutEntryOptimizationGoal {
  return value === "fewest-shipments" ? "fewest-shipments" : "lowest-total";
}

/**
 * The canonical entry payload of one `POST /checkout-sessions` body plus the
 * presented anonymous cart header. The session route builds its Session from
 * exactly this payload, so a caller hashing the body it sent hashes what the
 * owner decided on.
 */
export function checkoutEntryPayload(
  body: unknown,
  presentedAnonymousCartHeader: string | null | undefined,
): CheckoutEntryPayload {
  const request = record(body);
  const optimizationGoal = parseCheckoutEntryOptimizationGoal(request.optimizationGoal);
  const shippingOption = String(request.shippingOption ?? "standard");
  const requestSource = record(request.source);
  if (requestSource.type === "cart") {
    const presentedAnonymousCartId = normalizePresentedAnonymousCartId(presentedAnonymousCartHeader);
    return {
      source: {
        type: "cart",
        readinessSnapshotId: String(requestSource.readinessSnapshotId ?? ""),
        readinessSourceRevision: String(requestSource.readinessSourceRevision ?? ""),
        readinessDecisions: parseCartReadinessDecisionInput(requestSource.readinessDecisions),
        ...(presentedAnonymousCartId ? { presentedAnonymousCartId } : {}),
      },
      shippingOption,
      optimizationGoal,
    };
  }

  const source = request.source && typeof request.source === "object" ? requestSource : request;
  const selectedOptions = parseSelectedOptions(source.selectedOptions);
  if (source.type === "offer-intent") {
    return {
      source: {
        type: "offer-intent",
        catalogItemId: String(source.catalogItemId ?? ""),
        productId: String(source.productId ?? ""),
        selectedOptions,
        offerPriceAmount: String(source.offerPriceAmount ?? source.priceAmount ?? ""),
        offerPriceCurrencyCode: String(source.offerPriceCurrencyCode ?? source.priceCurrencyCode ?? ""),
        quantity: Number(source.quantity ?? source.quantityRequested ?? 0),
      },
      shippingOption,
      optimizationGoal,
    };
  }

  return {
    source: {
      type: "buy-now",
      listingId: String(source.listingId ?? ""),
      catalogItemId: String(source.catalogItemId ?? ""),
      productId: String(source.productId ?? ""),
      selectedOptions,
      quantity: Number(source.quantity ?? 0),
      fulfillmentMode: "locked-listing",
      lockedListingId: String(source.lockedListingId ?? source.listingId ?? "").trim(),
      sellerPreferenceId:
        source.sellerPreferenceId === null || source.sellerPreferenceId === undefined
          ? null
          : String(source.sellerPreferenceId || "") || null,
    },
    shippingOption: shippingOption === "expedited" || shippingOption === "priority" ? shippingOption : "standard",
    optimizationGoal,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/** SHA-256 hex over the canonical entry payload; the entry attempt's request hash. */
export async function computeCheckoutEntryRequestHash(payload: CheckoutEntryPayload): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`checkout-entry-attempt-request/v1\n${canonicalJson(payload)}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The caller-created key one deliberate entry submission carries, or null when it is missing or malformed. */
export function checkoutEntryAttemptKey(value: unknown): string | null {
  const key = typeof value === "string" ? value.trim() : "";
  return isCheckoutCommandAttemptId(key) ? key : null;
}

export type CheckoutEntryAttemptQuery = Readonly<{
  attemptId: string;
  kind: typeof CHECKOUT_ENTRY_ATTEMPT_KIND;
  target: typeof CHECKOUT_ENTRY_ATTEMPT_TARGET;
  requestHash: string;
}>;

/** The lookup query for one entry submission, hashed from the exact body and anonymous cart header it sent. */
export async function checkoutEntryAttemptQuery(
  attemptId: string,
  body: unknown,
  presentedAnonymousCartHeader: string | null | undefined,
): Promise<CheckoutEntryAttemptQuery> {
  return {
    attemptId,
    kind: CHECKOUT_ENTRY_ATTEMPT_KIND,
    target: CHECKOUT_ENTRY_ATTEMPT_TARGET,
    requestHash: await computeCheckoutEntryRequestHash(checkoutEntryPayload(body, presentedAnonymousCartHeader)),
  };
}

/** The Session a resolved entry lookup proves was opened, or null when the lookup proves nothing. */
export function checkoutEntryAttemptSessionId(result: CheckoutCommandAttemptResult | null): string | null {
  return result?.kind === CHECKOUT_ENTRY_ATTEMPT_KIND && result.ownerStatus === "committed"
    ? (result.sessionId ?? null)
    : null;
}
