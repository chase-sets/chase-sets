import { createHash } from "node:crypto";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { reservationIdentity } from "@chase-sets/event-core/owner-stream-reservation";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import { toJsonValue } from "@chase-sets/primitives/json";
import { z } from "zod";
import type { ListingAuthorizationEvidence, ListingPreparation, ListingTargetPrincipal } from "./target-contracts";

export class ListingRequestConflictError extends Error {
  constructor() {
    super("Listing request key was already used for a different command or has corrupt history.");
  }
}
export class ListingRequestIndeterminateError extends Error {
  constructor() {
    super("Listing request result is temporarily unavailable. Retry the same command.");
  }
}
const evidenceSchema = z
  .array(
    z
      .strictObject({
        owner: z.string().min(1),
        key: z.string().min(1),
        storeIncarnation: z.string().min(1),
        sealVersion: z.number().int().positive(),
        epoch: z.number().int().nonnegative().optional(),
        promiseId: z.string().min(1).optional(),
      })
      .refine((value) => (value.epoch !== undefined) !== (value.promiseId !== undefined)),
  )
  .min(1)
  .max(32);
function parseEvidence(value: unknown) {
  const evidence = evidenceSchema.parse(value);
  if (new Set(evidence.map((e) => `${e.owner}/${e.key}`)).size !== evidence.length)
    throw new ListingRequestConflictError();
  return evidence;
}
export function createListingRequestExecutor(eventStore: EventStore) {
  return async function execute<Result extends Record<string, unknown>>(
    input: Readonly<{
      accountId: string;
      idempotencyKey: string;
      command: Record<string, unknown>;
      context: EventStoreContext;
      principal: ListingTargetPrincipal;
      parseResult: (value: unknown) => Result;
      prepare: (preparation: ListingPreparation) => Promise<
        Readonly<{
          result: Result;
          appends: readonly AppendToStreamInput[];
          evidence: readonly ListingAuthorizationEvidence[];
        }>
      >;
    }>,
  ): Promise<Result> {
    const hash = (value: unknown) => createHash("sha256").update(reservationIdentity(value)).digest("hex");
    const requestId = hash([input.context.tenantId, input.accountId, input.idempotencyKey]);
    const streamId = `marketplace.listing-request-${requestId}`;
    const fingerprint = hash({
      command: input.command,
      tenantId: input.context.tenantId,
      accountId: input.accountId,
      userId: input.principal.userId,
      membershipId: input.principal.membershipId,
      sessionId: input.principal.sessionId,
      tokenHash: input.principal.tokenHash,
      audit: input.context.audit,
    });
    const replay = async () => {
      try {
        const events = await readCompleteStream(
          {
            async readStream(input) {
              try {
                return await eventStore.readStream(input);
              } catch {
                throw new ListingRequestIndeterminateError();
              }
            },
          },
          { streamId, maxEvents: 1 },
        );
        if (!events.length) return null;
        const event = events[0];
        if (
          events.length !== 1 ||
          event.streamVersion !== 1 ||
          event.tenantId !== input.context.tenantId ||
          event.performedByUserId !== input.context.audit.performedByUserId ||
          event.forAccountId !== input.accountId ||
          event.eventType !== "marketplace.listing-request.completed" ||
          event.payload.schemaVersion !== 1 ||
          event.payload.fingerprint !== fingerprint ||
          event.payload.requestId !== requestId
        )
          throw new ListingRequestConflictError();
        if (event.payload.resultDigest !== hash(event.payload.result)) throw new ListingRequestConflictError();
        parseEvidence(event.payload.authorizationEvidence);
        return input.parseResult(event.payload.result);
      } catch (error) {
        if (error instanceof ListingRequestIndeterminateError) throw error;
        throw new ListingRequestConflictError();
      }
    };
    const prior = await replay();
    if (prior !== null) return prior;
    if (!eventStore.appendToStreams) throw new ListingRequestIndeterminateError();
    let appendStarted = false;
    try {
      const prepared = await input.prepare({ requestId, commandFingerprint: fingerprint, target: input.command });
      parseEvidence(prepared.evidence);
      if (
        !prepared.evidence.length ||
        !prepared.appends.length ||
        prepared.appends.some((a) => !a.configurationGrants?.length)
      )
        throw new Error("Listing authorization evidence is incomplete.");
      appendStarted = true;
      const results = await eventStore.appendToStreams([
        ...prepared.appends,
        {
          streamId,
          expectedVersion: "no_stream",
          context: input.context,
          events: [
            {
              eventType: "marketplace.listing-request.completed",
              payload: {
                schemaVersion: 1,
                fingerprint,
                requestId,
                authorizationEvidence: toJsonValue(prepared.evidence),
                result: toJsonValue(prepared.result),
                resultDigest: hash(prepared.result),
              },
            },
          ],
        },
      ]);
      recordCommittedEvents(results.flatMap((r) => r.storedEvents));
      return prepared.result;
    } catch (error) {
      const committed = await replay();
      if (committed !== null) return committed;
      if (
        appendStarted &&
        !(
          error instanceof Error &&
          "code" in error &&
          (error.code === "concurrency_conflict" || error.code === "payload_too_large")
        )
      )
        throw new ListingRequestIndeterminateError();
      throw error;
    }
  };
}
