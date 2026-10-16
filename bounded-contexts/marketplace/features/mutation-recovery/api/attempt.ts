import { createHash } from "node:crypto";
import { z } from "zod";
import { t } from "@chase-sets/localization";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import {
  canonicalMarketplaceRequest,
  marketplaceOfferCanonicalRequest,
  marketplaceAcceptanceKeySchema,
  marketplaceAttemptIdSchema,
  marketplaceMutationRecoveryResultSchema,
  marketplaceRecoveryTargetSchema,
  recoveryHashSchema,
  type MarketplaceMutationKind,
  type MarketplaceMutationRecoveryResult,
} from "../domain/contracts";
import { readMarketplaceRecoveryHistory } from "../domain/history";
import { offerAcceptanceResultSchema } from "../../offers/api/attempt-result";
import { withMarketplaceAttemptReceipt } from "./receipt";

const acceptanceBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sellerAccountId: z.string().min(1).max(128),
  offerId: z.string().min(1).max(128),
  listingId: z.string().min(1).max(128),
  batchId: z.string().min(1).max(512).nullable(),
  batchSize: z.number().int().positive().max(100).nullable(),
  requestHash: recoveryHashSchema,
  ownerStatus: z.literal("committed"),
  offerVersion: z.number().int().positive().safe(),
  inventoryItemId: z.string().min(1).max(128),
  evidenceSnapshotHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});

export function completedMarketplaceAttemptSchema<T>(resultSchema: z.ZodType<T>) {
  return z
    .strictObject({
      recovery: marketplaceMutationRecoveryResultSchema,
      result: resultSchema,
      acceptance: acceptanceBindingSchema.optional(),
    })
    .superRefine((completed, ctx) => {
      const result = completed.result as Record<string, unknown>;
      const receipt = completed.recovery.ownerReceipt;
      if (
        completed.recovery.ownerStatus !== "committed" ||
        !receipt ||
        receipt.id !== (result.offerId ?? result.policyId) ||
        receipt.version !== result.version
      )
        ctx.addIssue({ code: "custom", message: t("marketplace.recovery.receiptMismatch") });
      if (completed.recovery.mutationKind === "offer.accept") {
        const acceptance = completed.acceptance;
        const accepted = offerAcceptanceResultSchema.safeParse(completed.result);
        if (
          !acceptance ||
          !accepted.success ||
          acceptance.sellerAccountId !== completed.recovery.actorBinding.accountId ||
          acceptance.offerId !== accepted.data.offerId ||
          acceptance.listingId !== accepted.data.listingId ||
          acceptance.offerVersion !== accepted.data.version ||
          acceptance.inventoryItemId !== accepted.data.inventoryItemId ||
          acceptance.evidenceSnapshotHash !== accepted.data.listingEvidenceSnapshot.snapshotHash ||
          acceptance.requestHash !== completed.recovery.canonicalRequestHash
        )
          ctx.addIssue({ code: "custom", message: t("marketplace.recovery.acceptanceBindingInvalid") });
      } else if (completed.acceptance)
        ctx.addIssue({ code: "custom", message: t("marketplace.recovery.acceptanceBindingUnexpected") });
    });
}

export function hashMarketplaceRequest(value: unknown): string {
  return createHash("sha256").update(canonicalMarketplaceRequest(value)).digest("hex");
}

export class MarketplaceAttemptError extends Error {
  constructor(
    public readonly code: "attempt_conflict" | "history_incomplete" | "invalid_attempt",
    message: string,
  ) {
    super(message);
    this.name = "MarketplaceAttemptError";
  }
}

export type MarketplaceAttemptInput = Readonly<{
  attemptId: string;
  mutationKind: MarketplaceMutationKind;
  accountId: string;
  target: z.infer<typeof marketplaceRecoveryTargetSchema>;
  request: unknown;
  requestHash?: string;
}>;

export function marketplaceAttemptBinding(input: MarketplaceAttemptInput): MarketplaceMutationRecoveryResult {
  const parser = input.mutationKind === "offer.accept" ? marketplaceAcceptanceKeySchema : marketplaceAttemptIdSchema;
  if (!parser.safeParse(input.attemptId).success)
    throw new MarketplaceAttemptError("invalid_attempt", "A valid Marketplace attempt identity is required.");
  const canonicalRequestHash = hashMarketplaceRequest(
    input.mutationKind === "offer-policy.command" || input.request === null
      ? input.request
      : marketplaceOfferCanonicalRequest(input.mutationKind, input.request as Record<string, unknown>),
  );
  if (
    input.requestHash !== undefined &&
    (!recoveryHashSchema.safeParse(input.requestHash).success || input.requestHash !== canonicalRequestHash)
  )
    throw new MarketplaceAttemptError("attempt_conflict", "The Marketplace request hash does not match the command.");
  return marketplaceMutationRecoveryResultSchema.parse({
    schemaVersion: 1,
    mutationKind: input.mutationKind,
    attemptKeyFingerprint:
      input.mutationKind === "offer.accept"
        ? createHash("sha256").update(input.attemptId).digest("hex")
        : hashMarketplaceRequest([input.accountId, input.mutationKind, input.target, input.attemptId]),
    actorBinding: { accountId: input.accountId },
    target: input.target,
    canonicalRequestHash,
    ownerStatus: "not-observed",
  });
}

export function marketplaceAttemptStream(binding: MarketplaceMutationRecoveryResult): string {
  return `${binding.mutationKind === "offer.accept" ? "marketplace.offer-acceptance-attempt-v1-" : "marketplace.offer-attempt-v1-"}${binding.attemptKeyFingerprint}`;
}

export function createMarketplaceAttempt<T>(
  eventStore: EventStore,
  input: MarketplaceAttemptInput,
  resultSchema: z.ZodType<T>,
) {
  const binding = marketplaceAttemptBinding(input);
  const streamId = marketplaceAttemptStream(binding);
  const completedSchema = completedMarketplaceAttemptSchema(resultSchema);
  async function read(): Promise<T | null> {
    const history = await readMarketplaceRecoveryHistory<{
      recovery: MarketplaceMutationRecoveryResult;
      result: T;
    } | null>(eventStore, streamId, null, (state, event) => {
      if (state !== null || event.eventType !== "marketplace.mutation-attempt.completed")
        throw new Error("Invalid attempt facts.");
      const completed = completedSchema.parse(event.payload);
      if (completed.recovery.actorBinding.accountId !== event.forAccountId)
        throw new Error("Attempt actor audit mismatch.");
      if (completed.recovery.ownerStatus !== "committed" || !completed.recovery.ownerReceipt)
        throw new Error("Attempt is not completed.");
      return { ...completed, result: withMarketplaceAttemptReceipt(completed.result, event) };
    });
    if (!history.complete)
      throw new MarketplaceAttemptError("history_incomplete", "Marketplace recovery history is incomplete.");
    if (history.state === null) return null;
    const prior = history.state.recovery;
    if (
      prior.attemptKeyFingerprint !== binding.attemptKeyFingerprint ||
      prior.mutationKind !== binding.mutationKind ||
      prior.actorBinding.accountId !== binding.actorBinding.accountId ||
      canonicalMarketplaceRequest(prior.target) !== canonicalMarketplaceRequest(binding.target) ||
      prior.canonicalRequestHash !== binding.canonicalRequestHash
    )
      throw new MarketplaceAttemptError(
        "attempt_conflict",
        "Marketplace attempt identity was already used for a different command.",
      );
    return history.state.result;
  }
  function append(
    result: T,
    receipt: { id: string; version: number },
    context: EventStoreContext,
  ): AppendToStreamInput {
    const accepted = binding.mutationKind === "offer.accept" ? offerAcceptanceResultSchema.parse(result) : null;
    const request = input.request as Record<string, unknown>;
    const payload = completedSchema.parse({
      recovery: { ...binding, ownerStatus: "committed", ownerReceipt: receipt },
      result,
      ...(accepted
        ? {
            acceptance: {
              schemaVersion: 1,
              sellerAccountId: input.accountId,
              offerId: accepted.offerId,
              listingId: accepted.listingId,
              batchId: request.acceptanceBatchId ?? null,
              batchSize: request.acceptanceBatchSize ?? null,
              requestHash: binding.canonicalRequestHash,
              ownerStatus: "committed",
              offerVersion: accepted.version,
              inventoryItemId: accepted.inventoryItemId,
              evidenceSnapshotHash: accepted.listingEvidenceSnapshot.snapshotHash,
            },
          }
        : {}),
    });
    return {
      streamId,
      expectedVersion: "no_stream",
      context,
      events: [{ eventType: "marketplace.mutation-attempt.completed", payload: JSON.parse(JSON.stringify(payload)) }],
    };
  }
  async function commit(
    inputs: readonly AppendToStreamInput[],
    result: T,
    receipt: { id: string; version: number },
    context: EventStoreContext,
  ): Promise<T> {
    if (!eventStore.appendToStreams)
      throw new Error("Marketplace attempts require atomic multi-stream append support.");
    try {
      const results = await eventStore.appendToStreams([...inputs, append(result, receipt, context)]);
      recordCommittedEvents(results.flatMap((entry) => entry.storedEvents));
      const completedEvent = results.at(-1)?.storedEvents[0];
      if (!completedEvent) throw new Error("Marketplace attempt append returned no committed event.");
      return withMarketplaceAttemptReceipt(result, completedEvent);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict") {
        const first = await read();
        if (first !== null) return first;
      }
      throw error;
    }
  }
  return { binding, read, append, commit };
}
