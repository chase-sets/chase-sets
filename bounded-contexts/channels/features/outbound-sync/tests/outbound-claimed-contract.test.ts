import { describe, expectTypeOf, it } from "vitest";
import type {
  ChannelsServices,
  ClaimedOperationOutcome,
  ClaimedOperationReservation,
  ClaimedOutboundOperation,
} from "../../../server";

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
