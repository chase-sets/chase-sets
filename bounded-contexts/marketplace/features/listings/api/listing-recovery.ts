import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { marketplaceAttemptBinding } from "../../mutation-recovery/api/attempt";
import {
  marketplaceAttemptIdSchema,
  marketplaceMutationRecoveryResultSchema,
  marketplaceRecoveryTargetKind,
} from "../../mutation-recovery/domain/contracts";
import {
  ambiguousListingRecovery,
  listingRecoveryIdentitySchema,
  type ListingRecovery,
  type ListingRecoveryPreparation,
  type ListingRecoveryPreparationResult,
  type ListingRecoveryReference,
  type MarketplaceListingBatchResult,
} from "../ui/contracts";
import { createListingMutationLookup } from "./listing-attempt";
import {
  listingRecoveryCommandForKey,
  listingRecoveryCommands,
  lookupListingBatch,
  prepareListingBatch,
} from "./listing-batch";

export function listingRecoveryForCommand(input: ListingRecoveryPreparation, accountId: string) {
  const { intent, fields } = input;
  if (!Object.hasOwn(listingRecoveryCommands, intent)) return null;
  const [mutationKind, command, bulk] = listingRecoveryCommands[intent as keyof typeof listingRecoveryCommands];
  const batchId = `${marketplaceAttemptIdSchema.parse(input.idempotencyKey)}_${command}`;
  const kind = marketplaceRecoveryTargetKind(mutationKind);
  const ids = bulk ? [...new Set(input.listingIds)] : [kind === "seller" ? accountId : (input.listingId ?? "")];
  const text = (key: keyof typeof fields) => fields[key] ?? "";
  const limit = (key: keyof typeof fields) => (text(key).trim() === "" ? null : Number(text(key)));
  const request = {
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
    ...(intent === "disable-listing-availability"
      ? {
          status: "unavailable",
          reasonCategory: text("reasonCategory"),
          availableAgainOn: text("availableAgainOn"),
          availableAgainAt: text("availableAgainAt"),
        }
      : { status: "available" }),
    ...(intent === "schedule-away-window"
      ? {
          action: "schedule",
          startsAt: text("awayWindowStartsAt"),
          endsAt: text("awayWindowEndsAt"),
          reasonCategory: text("awayWindowReasonCategory"),
        }
      : { action: "cancel" }),
    maxOpenOrders: intent === "set-order-capacity" ? Number(text("maxOpenOrders")) : null,
  };
  return listingRecoveryIdentitySchema.parse({
    batchId,
    mutationKind,
    bulk,
    targets: ids.map((id) => ({
      id,
      requestHash: marketplaceAttemptBinding({
        accountId,
        attemptId: batchId,
        mutationKind,
        target: { kind, id },
        request: { ...request, listingId: id },
      }).canonicalRequestHash,
    })),
  });
}

function reentryFor({ batchId, mutationKind, bulk }: ListingRecoveryReference) {
  const command = listingRecoveryCommandForKey(batchId);
  if (!command || command.family !== mutationKind || command.bulk !== bulk) return undefined;
  const { intent, idempotencyKey } = command;
  return { intent, idempotencyKey };
}

export function listingRecoveryResult(
  identity: ListingRecoveryReference | null,
  items: ListingRecovery["items"],
): ListingRecovery {
  const outcomes = new Set(items.map((item) => item.outcome));
  const phase =
    !identity || !outcomes.size || outcomes.has("ambiguous")
      ? "ambiguous"
      : outcomes.size > 1
        ? "partial"
        : outcomes.has("error")
          ? "failed-safe"
          : outcomes.has("unknown")
            ? "confirming"
            : outcomes.has("conflict")
              ? "conflict"
              : "succeeded";
  const retryTargetIds =
    identity?.bulk && phase !== "ambiguous"
      ? items.filter((item) => item.outcome === "unknown").map((item) => item.targetId)
      : [];
  const reentry = phase === "confirming" && identity ? reentryFor(identity) : undefined;
  return { identity, phase, items, retryTargetIds, ...(reentry ? { reentry } : {}) };
}

export async function recoverListingBatch(
  reference: ListingRecoveryReference,
  accountId: string,
  vector: MarketplaceListingBatchResult | null,
  lookup: ReturnType<typeof createListingMutationLookup>,
): Promise<ListingRecovery> {
  if (!vector || vector.batchId !== reference.batchId || vector.family !== reference.mutationKind)
    return listingRecoveryResult(null, []);
  const identity = listingRecoveryIdentitySchema.safeParse({
    ...reference,
    targets: vector.items.map((item) => ({ id: item.targetId, requestHash: item.requestHash })),
  });
  const reentry = reentryFor(reference);
  if (!identity.success || !reentry) return listingRecoveryResult(null, []);
  const kind = marketplaceRecoveryTargetKind(reference.mutationKind);
  const items = await Promise.all(
    identity.data.targets.map(async ({ id, requestHash }, index): Promise<ListingRecovery["items"][number]> => {
      const ambiguous = { targetId: id, outcome: "ambiguous" } as const;
      if (kind === "seller" && id !== accountId) return ambiguous;
      const target = { kind, id };
      const binding = {
        accountId,
        attemptId: reference.batchId,
        mutationKind: reference.mutationKind,
        target,
      };
      const fingerprint = marketplaceAttemptBinding({ ...binding, request: null }).attemptKeyFingerprint;
      try {
        const result = marketplaceMutationRecoveryResultSchema.parse(await lookup({ ...binding, requestHash }));
        const recorded = vector.items[index]!;
        if (
          recorded.attemptKeyFingerprint !== fingerprint ||
          result.actorBinding.accountId !== accountId ||
          result.target.id !== id ||
          result.target.kind !== kind ||
          result.mutationKind !== reference.mutationKind ||
          result.canonicalRequestHash !== requestHash ||
          result.attemptKeyFingerprint !== fingerprint ||
          (result.ownerStatus === "committed" ? result.ownerReceipt?.id !== id : result.ownerReceipt !== undefined)
        )
          return ambiguous;
        if (!recorded.noOp && !result.ownerReceipt && (recorded.outcome === "conflict" || recorded.outcome === "error"))
          return { targetId: id, outcome: recorded.outcome };
        if (result.reason === "history-incomplete") return ambiguous;
        const absent = result.ownerStatus === "not-observed" && !result.ownerReceipt;
        if (recorded.noOp)
          return absent && recorded.outcome === "succeeded" ? { targetId: id, outcome: "succeeded" } : ambiguous;
        if (recorded.outcome === "succeeded")
          return result.ownerStatus === "committed" && recorded.version === result.ownerReceipt?.version
            ? { targetId: id, outcome: "succeeded" }
            : ambiguous;
        if (recorded.outcome === "conflict" || recorded.outcome === "error") return ambiguous;
        if (result.ownerStatus === "committed" && result.ownerReceipt) return { targetId: id, outcome: "succeeded" };
        if (absent) return { targetId: id, outcome: "unknown" };
        if (result.ownerStatus === "conflict") return { targetId: id, outcome: "conflict" };
        if (result.ownerStatus === "failed-safe") return { targetId: id, outcome: "error" };
      } catch {
        // An incomplete owner lookup never grants permission to retry.
      }
      return ambiguous;
    }),
  );
  return listingRecoveryResult(reference, items);
}

export function createListingRecovery(store: EventStore) {
  const lookup = createListingMutationLookup(store);
  const read = (accountId: string, reference: ListingRecoveryReference) =>
    lookupListingBatch(store, { accountId, batchId: reference.batchId, family: reference.mutationKind }).catch(
      () => null,
    );
  return {
    async recoverListingBatch(accountId: string, reference: ListingRecoveryReference) {
      return recoverListingBatch(reference, accountId, await read(accountId, reference), lookup);
    },
    async prepareListingRecovery(
      accountId: string,
      input: ListingRecoveryPreparation,
      context: EventStoreContext,
    ): Promise<ListingRecoveryPreparationResult> {
      const { retained } = input;
      const vector = retained ? await read(accountId, retained) : null;
      if (retained && !vector) return { recovery: ambiguousListingRecovery };
      let identity;
      try {
        identity = listingRecoveryForCommand(input, accountId);
      } catch (error) {
        if (!retained) throw error;
        const recovery = await recoverListingBatch(retained, accountId, vector, lookup);
        return { recovery: recovery.phase === "ambiguous" ? recovery : { ...recovery, phase: "failed-safe" } };
      }
      if (retained) {
        const sameCommand =
          identity &&
          retained.batchId === identity.batchId &&
          retained.mutationKind === identity.mutationKind &&
          retained.bulk === identity.bulk &&
          vector?.items.length === identity.targets.length &&
          identity.targets.every(({ id, requestHash }, index) => {
            const item = vector?.items[index];
            return item?.targetId === id && item.requestHash === requestHash;
          });
        // The bulk retry endpoint checks owner history again and chooses its own targets.
        if (sameCommand && retained.bulk) {
          await prepareListingBatch(store, accountId, identity, context);
          return { reference: retained };
        }
        const recovery = await recoverListingBatch(retained, accountId, vector, lookup);
        if (recovery.phase === "ambiguous") return { recovery };
        if (!sameCommand) return { recovery: { ...recovery, phase: "failed-safe" } };
        if (!recovery.reentry) return { recovery };
        await prepareListingBatch(store, accountId, identity, context);
        return { reference: retained };
      }
      if (!identity) return { reference: null };
      await prepareListingBatch(store, accountId, identity, context);
      const { batchId, mutationKind, bulk } = identity;
      return { reference: { batchId, mutationKind, bulk } };
    },
  };
}
