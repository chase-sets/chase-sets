import { createHash } from "node:crypto";
import { z } from "zod";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { t } from "@chase-sets/localization";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import { MarketplaceAttemptError } from "../../mutation-recovery/api/attempt";
import { marketplaceAttemptIdSchema, recoveryHashSchema } from "../../mutation-recovery/domain/contracts";
import type {
  MarketplaceListingBatchFamily,
  MarketplaceListingBatchItem,
  MarketplaceListingBatchOutcome,
  MarketplaceListingBatchResult,
} from "../ui/contracts";
import type { ListingAttempt } from "./listing-attempt";

/**
 * The persisted terminal vector of one bulk Listing batch: one batch id per family, one C1 target attempt per
 * target. Each run records the outcomes it decided; a later fact may only settle a target the vector still holds
 * as `unknown`, so a retry re-drives `unknown` targets and returns every terminal target without sending it again.
 */
const LISTING_BATCH_FACT = "marketplace.listing-batch.recorded";
/** A vector with more facts than this is refused as incomplete instead of being read partially. */
const MAX_LISTING_BATCH_FACTS = 1_000;
/** Entries per recorded fact, so one fact stays far below the event payload bound. */
const MAX_LISTING_BATCH_FACT_ENTRIES = 200;

const listingBatchFamilies = [
  "listing.update-price",
  "listing.pause",
  "listing.withdraw",
  "seller.availability",
  "seller.away",
  "seller.order-capacity",
] as const satisfies readonly MarketplaceListingBatchFamily[];

const entrySchema = z.strictObject({
  targetId: z.string().min(1).max(512),
  attemptKeyFingerprint: recoveryHashSchema,
  requestHash: recoveryHashSchema,
  outcome: z.enum(["succeeded", "conflict", "error", "unknown"]),
  version: z.number().int().nonnegative().safe(),
  noOp: z.literal(true).optional(),
});
const factSchema = z.strictObject({
  schemaVersion: z.literal(1),
  family: z.enum(listingBatchFamilies),
  batchKeyFingerprint: recoveryHashSchema,
  entries: z.array(entrySchema).min(1).max(MAX_LISTING_BATCH_FACT_ENTRIES),
});

export type ListingBatchEntry = z.infer<typeof entrySchema>;
export type ListingBatchIdentity = Readonly<{
  accountId: string;
  family: MarketplaceListingBatchFamily;
  batchId: string;
}>;
export type ListingBatchVector = Readonly<{ version: number; entries: ReadonlyMap<string, ListingBatchEntry> }>;
export type ListingBatchTarget = Readonly<{ targetId: string; attempt: ListingAttempt }>;
export type ListingBatchDecision = Readonly<{
  outcome: MarketplaceListingBatchOutcome;
  version: number;
  noOp?: true;
  message?: string;
}>;

function batchKeyFingerprint(batch: ListingBatchIdentity): string {
  return createHash("sha256")
    .update(JSON.stringify(["listing-batch", batch.accountId, batch.family, batch.batchId]))
    .digest("hex");
}

export function listingBatchStreamId(batch: ListingBatchIdentity): string {
  return `marketplace.listing-batch-v1-${batchKeyFingerprint(batch)}`;
}

export function assertListingBatchId(batchId: unknown): asserts batchId is string {
  if (!marketplaceAttemptIdSchema.safeParse(batchId).success)
    throw new MarketplaceAttemptError("invalid_attempt", "A valid bulk batch id is required.");
}

function poisoned(reason: string): never {
  throw new MarketplaceAttemptError("history_incomplete", `Bulk Listing batch history is unusable: ${reason}.`);
}

function sameEntry(left: ListingBatchEntry, right: ListingBatchEntry): boolean {
  return (
    left.attemptKeyFingerprint === right.attemptKeyFingerprint &&
    left.requestHash === right.requestHash &&
    left.outcome === right.outcome &&
    left.version === right.version &&
    left.noOp === right.noOp
  );
}

function foldFact(
  batch: ListingBatchIdentity,
  streamId: string,
  entries: Map<string, ListingBatchEntry>,
  event: StoredEvent,
) {
  if (event.streamId !== streamId || event.eventType !== LISTING_BATCH_FACT) poisoned("unexpected fact");
  if (event.forAccountId !== batch.accountId) poisoned("wrong actor");
  const fact = factSchema.safeParse(event.payload);
  if (!fact.success) poisoned("malformed fact");
  if (fact.data.family !== batch.family || fact.data.batchKeyFingerprint !== batchKeyFingerprint(batch))
    poisoned("wrong batch");
  for (const entry of fact.data.entries) {
    const prior = entries.get(entry.targetId);
    if (prior && prior.attemptKeyFingerprint !== entry.attemptKeyFingerprint) poisoned("wrong target attempt");
    // A terminal target is settled once; a different later terminal is a conflicting history.
    if (prior && prior.outcome !== "unknown" && !sameEntry(prior, entry)) poisoned("conflicting terminal outcome");
    entries.set(entry.targetId, entry);
  }
}

/** The complete persisted vector, or null when the batch never recorded one. Poisoned histories throw. */
export async function readListingBatchVector(
  store: EventStore,
  batch: ListingBatchIdentity,
): Promise<ListingBatchVector | null> {
  const streamId = listingBatchStreamId(batch);
  let history: readonly StoredEvent[];
  try {
    history = await readCompleteStream(store, { streamId, maxEvents: MAX_LISTING_BATCH_FACTS });
  } catch {
    return poisoned("history incomplete");
  }
  if (history.length === 0) return null;
  const entries = new Map<string, ListingBatchEntry>();
  for (const event of history) foldFact(batch, streamId, entries, event);
  return { version: history.at(-1)!.streamVersion, entries };
}

function entryFor(target: ListingBatchTarget, decision: ListingBatchDecision): ListingBatchEntry {
  return {
    targetId: target.targetId,
    attemptKeyFingerprint: target.attempt.binding.attemptKeyFingerprint,
    requestHash: target.attempt.binding.canonicalRequestHash,
    outcome: decision.outcome,
    version: decision.version,
    ...(decision.outcome === "succeeded" && decision.noOp ? { noOp: true as const } : {}),
  };
}

function recordedDecision(entry: ListingBatchEntry): ListingBatchDecision {
  return {
    outcome: entry.outcome,
    version: entry.version,
    ...(entry.noOp ? { noOp: true as const } : {}),
    ...(entry.outcome === "succeeded"
      ? {}
      : { message: t("marketplace.features.listings.api.listingBatch.target.recorded", { outcome: entry.outcome }) }),
  };
}

function matchesTarget(entry: ListingBatchEntry, target: ListingBatchTarget): boolean {
  return (
    entry.attemptKeyFingerprint === target.attempt.binding.attemptKeyFingerprint &&
    entry.requestHash === target.attempt.binding.canonicalRequestHash
  );
}

const unknownDecision: ListingBatchDecision = {
  outcome: "unknown",
  version: 0,
  message: t("marketplace.features.listings.api.listingBatch.target.unknown"),
};
const changedTargetDecision: ListingBatchDecision = {
  outcome: "conflict",
  version: 0,
  message: t("marketplace.features.listings.api.listingBatch.target.changed"),
};

async function persistVector(
  store: EventStore,
  batch: ListingBatchIdentity,
  context: EventStoreContext,
  prior: ListingBatchVector | null,
  entries: readonly ListingBatchEntry[],
) {
  const facts = [];
  for (let index = 0; index < entries.length; index += MAX_LISTING_BATCH_FACT_ENTRIES) {
    facts.push({
      eventType: LISTING_BATCH_FACT,
      payload: {
        schemaVersion: 1,
        family: batch.family,
        batchKeyFingerprint: batchKeyFingerprint(batch),
        entries: entries.slice(index, index + MAX_LISTING_BATCH_FACT_ENTRIES).map((entry) => ({ ...entry })),
      } as JsonObject,
    });
  }
  await store.appendToStream({
    streamId: listingBatchStreamId(batch),
    // The vector's read version is the write predicate: a concurrent retry can never overwrite a settled target.
    expectedVersion: prior?.version ?? "no_stream",
    context,
    events: facts,
  });
}

/**
 * Runs one bulk batch against its persisted vector. Terminal targets return their recorded outcome with no owner
 * read or append; `unknown` and unrecorded targets go to `drive` (which consults each C1 target receipt first), and
 * the newly decided outcomes are appended under the vector's read version. An unreadable vector refuses every write
 * and reports each target `unknown`.
 */
export async function runListingBatch<Target extends ListingBatchTarget>(input: {
  store: EventStore;
  batch: ListingBatchIdentity;
  context: EventStoreContext;
  targets: readonly Target[];
  drive: (targets: readonly Target[]) => Promise<ReadonlyMap<string, ListingBatchDecision>>;
}): Promise<readonly ListingBatchDecision[]> {
  assertListingBatchId(input.batch.batchId);
  let prior: ListingBatchVector | null;
  try {
    prior = await readListingBatchVector(input.store, input.batch);
  } catch {
    return input.targets.map(() => unknownDecision);
  }

  const firstByTarget = new Map<string, Target>();
  const decided = new Map<string, ListingBatchDecision>();
  const toDrive: Target[] = [];
  for (const target of input.targets) {
    if (firstByTarget.has(target.targetId)) continue;
    firstByTarget.set(target.targetId, target);
    const recorded = prior?.entries.get(target.targetId);
    if (recorded && !matchesTarget(recorded, target)) decided.set(target.targetId, changedTargetDecision);
    else if (recorded && recorded.outcome !== "unknown") decided.set(target.targetId, recordedDecision(recorded));
    else toDrive.push(target);
  }

  if (toDrive.length > 0) {
    let driven: ReadonlyMap<string, ListingBatchDecision>;
    try {
      driven = await input.drive(toDrive);
    } catch {
      // A failure that escapes the drive may have committed any of its targets.
      driven = new Map();
    }
    const fresh = toDrive.map((target) => entryFor(target, driven.get(target.targetId) ?? unknownDecision));
    for (const target of toDrive) decided.set(target.targetId, driven.get(target.targetId) ?? unknownDecision);
    const changed = fresh.filter((entry) => {
      const recorded = prior?.entries.get(entry.targetId);
      return !recorded || !sameEntry(recorded, entry);
    });
    if (changed.length > 0) {
      try {
        await persistVector(input.store, input.batch, input.context, prior, changed);
      } catch {
        // Any append failure may have committed or lost to a concurrent retry. Only the durable vector settles it.
        const winner = await readListingBatchVector(input.store, input.batch).catch(() => null);
        for (const target of toDrive) {
          const recorded = winner?.entries.get(target.targetId);
          decided.set(
            target.targetId,
            recorded && !matchesTarget(recorded, target)
              ? changedTargetDecision
              : recorded && recorded.outcome !== "unknown"
                ? recordedDecision(recorded)
                : unknownDecision,
          );
        }
      }
    }
  }

  return input.targets.map((target) => {
    const first = firstByTarget.get(target.targetId)!;
    if (first !== target && !matchesTarget(entryFor(first, unknownDecision), target)) return changedTargetDecision;
    return decided.get(target.targetId) ?? unknownDecision;
  });
}

/** Read-only vector lookup for recovery: it never appends and reports a poisoned history as incomplete. */
export async function lookupListingBatch(
  store: EventStore,
  batch: ListingBatchIdentity,
): Promise<MarketplaceListingBatchResult | null> {
  assertListingBatchId(batch.batchId);
  const vector = await readListingBatchVector(store, batch);
  if (!vector) return null;
  const items: MarketplaceListingBatchItem[] = [...vector.entries.values()].map((entry) => ({
    targetId: entry.targetId,
    outcome: entry.outcome,
    version: entry.version,
  }));
  return { batchId: batch.batchId, family: batch.family, items };
}
