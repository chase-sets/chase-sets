import { describe, expectTypeOf, it } from "vitest";
import type { ChannelsServices } from "../../connections/domain/contracts";
import type {
  ClaimedOperationOutcome,
  ClaimedOperationReservation,
  ClaimedOutboundOperation,
} from "../domain/contracts";

describe("outbound claimed public contract", () => {
  it("exports the exact reservation and producer-sequence member sets for successor callers", () => {
    expectTypeOf<keyof ClaimedOutboundOperation>().toEqualTypeOf<
      | "operationId"
      | "attemptId"
      | "claimGeneration"
      | "connectionId"
      | "providerIdentity"
      | "channelListingId"
      | "listingId"
      | "operationKind"
      | "listingRevision"
      | "desiredStateSequence"
      | "payload"
      | "payloadDigest"
      | "sourceOccurredAt"
      | "enqueuedAt"
    >();
    expectTypeOf<keyof ClaimedOperationReservation>().toEqualTypeOf<
      | "reservationId"
      | "connectionId"
      | "providerIdentity"
      | "claimant"
      | "reservedAt"
      | "leaseExpiresAt"
      | "operations"
    >();
    expectTypeOf<keyof ClaimedOperationOutcome>().toEqualTypeOf<
      "operationId" | "attemptId" | "claimGeneration" | "desiredStateSequence" | "outcome"
    >();
    expectTypeOf<keyof ChannelsServices>().toEqualTypeOf<"connections" | "outboundSync" | "projectors">();
  });
});

function compileClaimedBoundaryMutants(outcome: ClaimedOperationOutcome): void {
  // @ts-expect-error desiredStateSequence is required on every report member
  const omittedSequence: ClaimedOperationOutcome = {
    operationId: outcome.operationId,
    attemptId: outcome.attemptId,
    claimGeneration: outcome.claimGeneration,
    outcome: outcome.outcome,
  };
  const extraListingRevision: ClaimedOperationOutcome = {
    ...outcome,
    // @ts-expect-error listingRevision cannot substitute for the producer-authored sequence
    listingRevision: outcome.desiredStateSequence,
  };
  void omittedSequence;
  void extraListingRevision;
}

void compileClaimedBoundaryMutants;
