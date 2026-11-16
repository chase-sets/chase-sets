import { marketplaceRequestHash } from "../../mutation-recovery/api/client";
import {
  marketplaceAttemptIdSchema,
  marketplaceListingCanonicalRequest,
  marketplaceMutationRecoveryResultSchema,
  marketplaceRecoveryTargetKind,
} from "../../mutation-recovery/domain/contracts";
import type { createMarketplaceApiClient } from "../../../client";
import {
  listingRecoveryIdentitySchema,
  listingRecoveryReferenceSchema,
  type ListingRecoveryIdentity,
} from "./contracts";
export { listingRecoveryIdentitySchema, type ListingRecoveryIdentity } from "./contracts";

export const LISTING_RECOVERY_PARAM = "listingRecovery";
export type ListingRecoveryOutcome = "succeeded" | "conflict" | "error" | "unknown" | "ambiguous";
export type ListingRecovery = {
  identity: ListingRecoveryIdentity | null;
  phase: "loading" | "confirming" | "succeeded" | "partial" | "conflict" | "failed-safe" | "ambiguous";
  items: { targetId: string; outcome: ListingRecoveryOutcome }[];
};

export function listingRecoveryUrl(path: string, identity: ListingRecoveryIdentity) {
  const url = new URL(path, "https://recovery.invalid");
  const publicationEvent = url.searchParams.get("evidenceEvent") === "publication_succeeded";
  url.search = "";
  if (publicationEvent) url.searchParams.set("evidenceEvent", "publication_succeeded");
  const { batchId, mutationKind, bulk } = listingRecoveryIdentitySchema.parse(identity);
  url.searchParams.set(LISTING_RECOVERY_PARAM, JSON.stringify({ batchId, mutationKind, bulk }));
  return `${url.pathname}${url.search}`;
}

export function readListingRecoveryIdentity(request: Request) {
  const value = new URL(request.url).searchParams.get(LISTING_RECOVERY_PARAM);
  return value === null ? null : listingRecoveryReferenceSchema.parse(JSON.parse(value));
}

export function listingRecoveryResult(
  identity: ListingRecoveryIdentity | null,
  items: ListingRecovery["items"],
): ListingRecovery {
  const outcomes = items.map((item) => item.outcome);
  const phase =
    !identity || outcomes.includes("ambiguous")
      ? "ambiguous"
      : outcomes.every((outcome) => outcome === "succeeded")
        ? "succeeded"
        : outcomes.every((outcome) => outcome === "conflict")
          ? "conflict"
          : outcomes.every((outcome) => outcome === "error")
            ? "failed-safe"
            : outcomes.every((outcome) => outcome === "unknown")
              ? "confirming"
              : "partial";
  return { identity, phase, items };
}

/** A URL is a reference, never evidence of success or permission to send. */
export async function recoverListingBatch(
  api: Pick<ReturnType<typeof createMarketplaceApiClient>, "lookupListingAttempt" | "lookupListingBatch">,
  identity: ListingRecoveryIdentity,
  accountId: string,
): Promise<ListingRecovery> {
  let batch: Awaited<ReturnType<typeof api.lookupListingBatch>> = null;
  let batchUnavailable = false;
  try {
    batch = await api.lookupListingBatch(identity.batchId, identity.mutationKind);
    if (
      batch &&
      (batch.batchId !== identity.batchId ||
        batch.family !== identity.mutationKind ||
        new Set(batch.items.map((item) => item.targetId)).size !== batch.items.length)
    )
      batchUnavailable = true;
  } catch {
    batchUnavailable = true;
  }
  const items = await Promise.all(
    identity.targets.map(async (target): Promise<ListingRecovery["items"][number]> => {
      try {
        // Exactly one complete owner lookup per possible target, including recorded terminal targets.
        const result = marketplaceMutationRecoveryResultSchema.parse(
          await api.lookupListingAttempt(identity.batchId, identity.mutationKind, target.id, target.requestHash),
        );
        const ownerTarget = { kind: marketplaceRecoveryTargetKind(identity.mutationKind), id: target.id };
        const fingerprint = await marketplaceRequestHash([
          accountId,
          identity.mutationKind,
          ownerTarget,
          identity.batchId,
        ]);
        if (
          batchUnavailable ||
          result.actorBinding.accountId !== accountId ||
          result.target.id !== target.id ||
          result.target.kind !== ownerTarget.kind ||
          result.mutationKind !== identity.mutationKind ||
          result.canonicalRequestHash !== target.requestHash ||
          result.attemptKeyFingerprint !== fingerprint
        )
          throw new Error("Invalid owner binding");
        if (result.ownerStatus === "committed" && result.ownerReceipt?.id !== target.id)
          throw new Error("Invalid owner receipt");
        const recorded = batch?.items.find((item) => item.targetId === target.id);
        if (recorded && recorded.outcome !== "unknown") {
          const boundNoOp =
            recorded.noOp === true &&
            recorded.requestHash === target.requestHash &&
            recorded.attemptKeyFingerprint === fingerprint &&
            result.ownerStatus === "not-observed" &&
            !result.ownerReceipt;
          if (
            (recorded.noOp === true && (!boundNoOp || recorded.outcome !== "succeeded")) ||
            !["succeeded", "conflict", "error"].includes(recorded.outcome) ||
            (recorded.outcome === "succeeded"
              ? !boundNoOp &&
                (result.ownerStatus !== "committed" ||
                  !result.ownerReceipt ||
                  recorded.version !== result.ownerReceipt.version)
              : result.ownerStatus === "committed")
          )
            throw new Error("Invalid terminal vector");
          return { targetId: target.id, outcome: recorded.outcome };
        }
        if (result.ownerStatus === "committed" && result.ownerReceipt)
          return { targetId: target.id, outcome: "succeeded" };
        if (result.ownerStatus === "not-observed" && !result.ownerReceipt)
          return { targetId: target.id, outcome: "unknown" };
        if (result.ownerStatus === "conflict") return { targetId: target.id, outcome: "conflict" };
        if (result.ownerStatus === "failed-safe") return { targetId: target.id, outcome: "error" };
      } catch {
        /* Missing, malformed and incomplete authority are not unknown. */
      }
      return { targetId: target.id, outcome: "ambiguous" };
    }),
  );
  return listingRecoveryResult(identity, items);
}

export async function loadListingRecovery(
  api: Parameters<typeof recoverListingBatch>[0],
  request: Request,
  accountId: string,
): Promise<ListingRecovery | null> {
  try {
    const reference = readListingRecoveryIdentity(request);
    if (!reference) return null;
    const vector = await api.lookupListingBatch(reference.batchId, reference.mutationKind);
    if (!vector || vector.batchId !== reference.batchId || vector.family !== reference.mutationKind)
      return listingRecoveryResult(null, []);
    const identity = listingRecoveryIdentitySchema.parse({
      ...reference,
      targets: vector.items.map((item) => ({ id: item.targetId, requestHash: item.requestHash })),
    });
    return recoverListingBatch({ ...api, lookupListingBatch: async () => vector }, identity, accountId);
  } catch {
    return listingRecoveryResult(null, []);
  }
}

const commands = {
  "bulk-pause-listings": ["listing.pause", "bulk-pause-listings"],
  "bulk-withdraw-listings": ["listing.withdraw", "bulk-withdraw-listings"],
  publish: ["listing.publish", "publishListing"],
  pause: ["listing.pause", "pauseListing"],
  withdraw: ["listing.withdraw", "withdrawListing"],
  "update-price": ["listing.update-price", "updateListingPrice"],
  "update-quantity-cap": ["listing.update-quantity", "updateListingQuantityCap"],
  "update-purchase-limits": ["listing.update-purchase-limits", "updateListingPurchaseLimits"],
  "disable-listing-availability": ["seller.availability", "disableSellerListingAvailability"],
  "enable-listing-availability": ["seller.availability", "enableSellerListingAvailability"],
  "schedule-away-window": ["seller.away", "scheduleSellerAwayWindow"],
  "cancel-away-window": ["seller.away", "cancelScheduledAwayWindow"],
  "set-order-capacity": ["seller.order-capacity", "setSellerOrderCapacity"],
  "clear-order-capacity": ["seller.order-capacity", "clearSellerOrderCapacity"],
} as const;

export async function listingRecoveryForForm(
  form: FormData,
  listingId: string | null,
  accountId: string,
): Promise<ListingRecoveryIdentity | null> {
  const intent = String(form.get("intent") ?? "");
  if (!(intent in commands)) return null;
  const [mutationKind, command] = commands[intent as keyof typeof commands];
  const text = (key: string) => String(form.get(key) ?? "");
  const limit = (key: string) => (text(key).trim() === "" ? null : Number(text(key)));
  const bulk = intent === "bulk-pause-listings" || intent === "bulk-withdraw-listings";
  const ids = bulk
    ? [...new Set(form.getAll("listingIds").map(String))]
    : [mutationKind.startsWith("seller.") ? accountId : (listingId ?? "")];
  const targets = await Promise.all(
    ids.map(async (id) => ({
      id,
      requestHash: await marketplaceRequestHash(
        marketplaceListingCanonicalRequest(mutationKind, {
          listingId: id,
          priceAmount: text("priceAmount"),
          priceCurrencyCode: text("priceCurrencyCode"),
          quantityCap: Number(text("quantityCap")),
          purchaseLimits:
            mutationKind === "listing.update-purchase-limits"
              ? {
                  maxUnitsPerOrder: limit("maxUnitsPerOrder"),
                  maxUnitsPerDay: limit("maxUnitsPerDay"),
                  maxUnitsPerCustomerAccount: limit("maxUnitsPerCustomerAccount"),
                }
              : null,
          ...(mutationKind === "seller.availability"
            ? {
                status: intent === "enable-listing-availability" ? "available" : "unavailable",
                ...(intent === "disable-listing-availability"
                  ? {
                      reasonCategory: text("reasonCategory"),
                      availableAgainOn: text("availableAgainOn"),
                      availableAgainAt: text("availableAgainAt"),
                    }
                  : {}),
              }
            : {}),
          ...(mutationKind === "seller.away"
            ? {
                action: intent === "schedule-away-window" ? "schedule" : "cancel",
                ...(intent === "schedule-away-window"
                  ? {
                      startsAt: text("awayWindowStartsAt"),
                      endsAt: text("awayWindowEndsAt"),
                      reasonCategory: text("awayWindowReasonCategory"),
                    }
                  : {}),
              }
            : {}),
          ...(mutationKind === "seller.order-capacity"
            ? { maxOpenOrders: intent === "set-order-capacity" ? Number(text("maxOpenOrders")) : null }
            : {}),
        }),
      ),
    })),
  );
  return listingRecoveryIdentitySchema.parse({
    batchId: `${marketplaceAttemptIdSchema.parse(form.get("idempotencyKey"))}_${command}`,
    mutationKind,
    bulk,
    targets,
  });
}

export function sameListingRecovery(left: ListingRecoveryIdentity, right: ListingRecoveryIdentity) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function listingRecoveryFormKey(identity: ListingRecoveryIdentity, intent: string) {
  if (!(intent in commands)) return null;
  const [kind, command] = commands[intent as keyof typeof commands];
  return identity.mutationKind === kind && identity.batchId.endsWith(`_${command}`)
    ? identity.batchId.slice(0, -command.length - 1)
    : null;
}
