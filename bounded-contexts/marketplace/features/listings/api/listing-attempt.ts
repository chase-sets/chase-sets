import { createHash } from "node:crypto";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventRecordToStore, StoredEvent } from "@chase-sets/event-core/storage";
import type { EventId, ListingId } from "@chase-sets/primitives/typed-ids";
import { MarketplaceAttemptError, marketplaceAttemptBinding } from "../../mutation-recovery/api/attempt";
import { withMarketplaceAttemptReceipt } from "../../mutation-recovery/api/receipt";
import {
  canonicalMarketplaceMoneyAmount,
  marketplaceMutationRecoveryResultSchema,
  marketplaceRecoveryTargetKind,
  type MarketplaceListingMutationKind,
  type MarketplaceMutationRecoveryResult,
} from "../../mutation-recovery/domain/contracts";

/**
 * The Listing attempt carrier: the shipped `idempotencyKey` becomes deterministic event ids
 * (`<prefix>:<index>`) on the command's owner stream, and every stamped event records the canonical
 * request hash. The owner stream itself is the replay authority; there is no parallel attempt stream.
 */
export type ListingAttempt = Readonly<{
  binding: MarketplaceMutationRecoveryResult;
  streamId: string;
  receiptId: string;
  eventIdPrefix: string;
  /** Legacy `repricing:` histories predate the recorded hash; their price facts are the whole request. */
  legacyPrice: Readonly<{ priceAmount: unknown; priceCurrencyCode: unknown }> | null;
  terminalEventTypes: readonly string[];
}>;

type ListingAttemptInput = Readonly<{
  idempotencyKey: string;
  mutationKind: MarketplaceListingMutationKind;
  accountId: string;
  /** Listing id for Listing commands, inventory item id for create; seller kinds target the account. */
  targetId?: string;
  listingIdOverride?: string | null;
}> &
  ({ request: Record<string, unknown>; requestHash?: string } | { request?: undefined; requestHash: string });

/** Exempt repricing-engine keys are deterministic, engine-owned, and kept on the shipped event ids. */
export function isRepricingEngineKey(key: string | undefined): key is `repricing:${string}` {
  return typeof key === "string" && key.startsWith("repricing:");
}

const ulidAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A create attempt owns exactly one Listing id, so a retry never mints a second Listing. */
export function attemptListingId(accountId: string, idempotencyKey: string): ListingId {
  const digest = createHash("sha256")
    .update(JSON.stringify(["listing.create", accountId, idempotencyKey]))
    .digest();
  const body = Array.from(digest.subarray(0, 26), (byte, index) => ulidAlphabet[index === 0 ? byte & 7 : byte & 31]);
  return `lst_${body.join("")}` as ListingId;
}

function ownerStream(kind: MarketplaceListingMutationKind, accountId: string, listingId: string | null): string {
  if (kind === "seller.order-capacity") return `marketplace.seller-order-capacity-${accountId}`;
  if (kind === "seller.availability" || kind === "seller.away")
    return `marketplace.seller-listing-availability-${accountId}`;
  return `marketplace.listing-${listingId}`;
}

function terminalEventTypes(kind: MarketplaceListingMutationKind): readonly string[] {
  switch (kind) {
    case "listing.create":
      return ["marketplace.listing.created"];
    case "listing.publish":
      return ["marketplace.listing.published"];
    case "listing.update-price":
      return ["marketplace.listing.price-updated"];
    case "listing.update-quantity":
      return ["marketplace.listing.quantity-cap-updated"];
    case "listing.update-purchase-limits":
      return ["marketplace.listing.purchase-limits-updated"];
    case "listing.pause":
      return ["marketplace.listing.paused"];
    case "listing.withdraw":
      return ["marketplace.listing.withdrawn"];
    case "seller.availability":
      return ["marketplace.seller-listing-availability.disabled", "marketplace.seller-listing-availability.enabled"];
    case "seller.away":
      return [
        "marketplace.seller-listing-availability.away-window-scheduled",
        "marketplace.seller-listing-availability.away-window-cancelled",
      ];
    case "seller.order-capacity":
      return ["marketplace.seller-order-capacity.set", "marketplace.seller-order-capacity.cleared"];
  }
}

export function listingAttempt(input: ListingAttemptInput): ListingAttempt {
  const repricing = isRepricingEngineKey(input.idempotencyKey);
  if (repricing && (input.mutationKind !== "listing.update-price" || input.idempotencyKey.length > 512))
    throw new MarketplaceAttemptError("invalid_attempt", "Repricing keys apply only to engine price updates.");
  const targetKind = marketplaceRecoveryTargetKind(input.mutationKind);
  const targetId = targetKind === "seller" ? input.accountId : input.targetId;
  if (!targetId) throw new MarketplaceAttemptError("invalid_attempt", "A Listing attempt target is required.");
  const binding = marketplaceAttemptBinding({
    attemptId: repricing
      ? `repricing_${createHash("sha256").update(input.idempotencyKey).digest("hex")}`
      : input.idempotencyKey,
    mutationKind: input.mutationKind,
    accountId: input.accountId,
    target: { kind: targetKind, id: targetId },
    request: input.request ?? null,
    ...(input.request ? { requestHash: input.requestHash } : {}),
  });
  const listingId =
    input.mutationKind === "listing.create"
      ? (input.listingIdOverride ?? attemptListingId(input.accountId, input.idempotencyKey))
      : targetKind === "listing"
        ? targetId
        : null;
  return {
    binding: input.request ? binding : { ...binding, canonicalRequestHash: input.requestHash },
    streamId: ownerStream(input.mutationKind, input.accountId, listingId),
    receiptId: listingId ?? input.accountId,
    eventIdPrefix: repricing ? input.idempotencyKey : `mla_${binding.attemptKeyFingerprint}`,
    legacyPrice:
      repricing && input.request
        ? { priceAmount: input.request.priceAmount, priceCurrencyCode: input.request.priceCurrencyCode }
        : null,
    terminalEventTypes: terminalEventTypes(input.mutationKind),
  };
}

export function listingAttemptMetadata(attempt: ListingAttempt) {
  return {
    marketplaceAttempt: {
      schemaVersion: 1,
      mutationKind: attempt.binding.mutationKind,
      attemptKeyFingerprint: attempt.binding.attemptKeyFingerprint,
      requestHash: attempt.binding.canonicalRequestHash,
    },
  };
}

export function stampListingAttemptEvents(
  attempt: ListingAttempt | null | undefined,
  events: readonly EventRecordToStore[],
): EventRecordToStore[] {
  if (!attempt) return [...events];
  return events.map((event, index) => ({
    ...event,
    eventId: `${attempt.eventIdPrefix}:${index}` as EventId,
    metadata: { ...(event.metadata ?? {}), ...listingAttemptMetadata(attempt) },
  }));
}

function recordedAttemptMatches(attempt: ListingAttempt, event: StoredEvent): boolean {
  if (event.forAccountId !== attempt.binding.actorBinding.accountId || event.streamId !== attempt.streamId)
    return false;
  const recorded = (event.metadata as Record<string, unknown> | undefined)?.marketplaceAttempt as
    | Record<string, unknown>
    | undefined;
  if (recorded)
    return (
      recorded.mutationKind === attempt.binding.mutationKind &&
      recorded.attemptKeyFingerprint === attempt.binding.attemptKeyFingerprint &&
      recorded.requestHash === attempt.binding.canonicalRequestHash
    );
  if (!attempt.legacyPrice) return false;
  if (event.eventId !== `${attempt.eventIdPrefix}:0`) return true;
  const payload = event.payload as Record<string, unknown>;
  return (
    event.eventType === "marketplace.listing.price-updated" &&
    canonicalMarketplaceMoneyAmount(payload.priceAmount) ===
      canonicalMarketplaceMoneyAmount(attempt.legacyPrice.priceAmount) &&
    payload.priceCurrencyCode === attempt.legacyPrice.priceCurrencyCode
  );
}

type RecordedAttempt = Readonly<{ version: number; matches: boolean; terminal: boolean; last: StoredEvent }>;

async function readRecordedAttempt(store: Pick<EventStore, "readStream">, attempt: ListingAttempt) {
  const prefix = `${attempt.eventIdPrefix}:`;
  let history: readonly StoredEvent[];
  try {
    // Listing attempts live on ordinary owner streams, so they must retain the
    // complete-stream contiguity checks without the bounded S1 attempt-stream cap.
    history = await readCompleteStream(store, { streamId: attempt.streamId });
  } catch {
    return { complete: false as const, reason: "history-incomplete" as const };
  }
  return {
    complete: true as const,
    state: history.reduce<RecordedAttempt | null>((state, event) => {
      if (!event.eventId.startsWith(prefix)) return state;
      return {
        version: event.streamVersion,
        matches: state?.matches !== false && recordedAttemptMatches(attempt, event),
        terminal: state?.terminal === true || attempt.terminalEventTypes.includes(event.eventType),
        last: event,
      };
    }, null),
  };
}

/**
 * The first receipt of a completed attempt, or null when the owner stream holds none of its events.
 * The stamped append is the command's one decisive atomic write, so presence means completion.
 */
export async function readListingAttemptReceipt(
  store: Pick<EventStore, "readStream">,
  attempt: ListingAttempt | null | undefined,
): Promise<Readonly<{ id: string; version: number; last: StoredEvent }> | null> {
  if (!attempt) return null;
  const history = await readRecordedAttempt(store, attempt);
  if (!history.complete)
    throw new MarketplaceAttemptError("history_incomplete", "Marketplace recovery history is incomplete.");
  if (!history.state) return null;
  if (!history.state.matches)
    throw new MarketplaceAttemptError(
      "attempt_conflict",
      "Marketplace attempt identity was already used for a different command.",
    );
  if (!history.state.terminal)
    throw new MarketplaceAttemptError(
      "history_incomplete",
      "Marketplace recovery history is missing its terminal fact.",
    );
  return { id: attempt.receiptId, version: history.state.version, last: history.state.last };
}

/**
 * Runs a Listing command at most once per attempt: a recorded attempt returns its first receipt with zero
 * appends, a changed request conflicts, and an identical retry that lost the append race adopts the winner.
 */
export async function runListingAttempt<T extends object>(
  store: Pick<EventStore, "readStream">,
  attempt: ListingAttempt | null,
  replay: (receipt: Readonly<{ id: string; version: number }>) => T | Promise<T>,
  run: () => Promise<T>,
): Promise<T> {
  const first = await readListingAttemptReceipt(store, attempt);
  if (first) return withMarketplaceAttemptReceipt(await replay(first), first.last);
  try {
    return await run();
  } catch (error) {
    const raced = attempt ? await readListingAttemptReceipt(store, attempt).catch(() => null) : null;
    if (raced) return withMarketplaceAttemptReceipt(await replay(raced), raced.last);
    throw error;
  }
}

/** Read-only owner lookup for Listing kinds; it never appends and never trusts a rail identity. */
export function createListingMutationLookup(eventStore: Pick<EventStore, "readStream">) {
  return async (input: {
    attemptId: string;
    accountId: string;
    mutationKind: MarketplaceListingMutationKind;
    target: MarketplaceMutationRecoveryResult["target"];
    requestHash: string;
  }): Promise<MarketplaceMutationRecoveryResult> => {
    const attempt = listingAttempt({
      idempotencyKey: input.attemptId,
      mutationKind: input.mutationKind,
      accountId: input.accountId,
      targetId: input.target.id,
      requestHash: input.requestHash,
    });
    const notObserved = marketplaceMutationRecoveryResultSchema.parse({
      ...attempt.binding,
      ownerStatus: "not-observed",
    });
    if (attempt.binding.target.kind !== input.target.kind) return notObserved;
    let wrongOwner = false;
    const reader = {
      readStream: async (request: Parameters<EventStore["readStream"]>[0]) => {
        const events = await eventStore.readStream(request);
        if (
          events.some(
            (event) => event.eventId.startsWith(`${attempt.eventIdPrefix}:`) && event.forAccountId !== input.accountId,
          )
        )
          wrongOwner = true;
        return events;
      },
    };
    const history = await readRecordedAttempt(reader, attempt);
    if (wrongOwner) return notObserved;
    if (!history.complete) return { ...notObserved, ownerStatus: "ambiguous", reason: "history-incomplete" };
    if (!history.state?.matches) return notObserved;
    if (!history.state.terminal) return { ...notObserved, ownerStatus: "ambiguous", reason: "history-incomplete" };
    return withMarketplaceAttemptReceipt(
      marketplaceMutationRecoveryResultSchema.parse({
        ...attempt.binding,
        ownerStatus: "committed",
        ownerReceipt: { id: attempt.receiptId, version: history.state.version },
      }),
      history.state.last,
    );
  };
}
