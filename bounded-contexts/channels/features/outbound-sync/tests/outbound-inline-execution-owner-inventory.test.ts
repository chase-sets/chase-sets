import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { parseGlobalPosition } from "@chase-sets/event-core/storage";
import type { ChannelPublicationResult } from "../../publication-port/domain/contracts";
import type { OutboundOperationRecord, OutboundSyncRuntimeDependencies } from "../domain/contracts";

// Contract-shaped fixture pinned to #4379 PR #7755 at de07506c. It is test
// evidence only; production imports the canonical command after #4379 lands.
type ProducerPublicationOutcomeCommandFixture = Readonly<{
  connectionId: string;
  channelListingId: string;
  operationId: string;
  reportedDesiredStateSequence: number;
  reportedListingRevision: number;
  reportedDesiredStateHash: string;
  outcome: ChannelPublicationResult | Readonly<{ kind: "outcome-unknown" }>;
  expectedStreamVersion: number;
}>;

describe("outbound-inline-execution-owner-inventory", () => {
  it("keeps the producer command member set exact and supplies every identity from persisted operation state", () => {
    expectTypeOf<keyof ProducerPublicationOutcomeCommandFixture>().toEqualTypeOf<
      | "connectionId"
      | "channelListingId"
      | "operationId"
      | "reportedDesiredStateSequence"
      | "reportedListingRevision"
      | "reportedDesiredStateHash"
      | "outcome"
      | "expectedStreamVersion"
    >();
    const operation = persistedOperationFixture();
    const outcome = { kind: "succeeded" as const, externalListingId: "synthetic-external-listing" };
    expect(toProducerCommandFixture(operation, outcome)).toEqual({
      connectionId: "connection-a",
      channelListingId: "channel-listing-a",
      operationId: "operation-a",
      reportedDesiredStateSequence: 11,
      reportedListingRevision: 7,
      reportedDesiredStateHash: "2".repeat(64),
      outcome,
      expectedStreamVersion: 11,
    });
    expect(operation.payloadDigest).toBe("1".repeat(64));
    expect(operation.sourceDesiredStateHash).not.toBe(operation.payloadDigest);
  });

  it("keeps the landed producer path behind the explicit post-landing binding hold", () => {
    const runtime = readFileSync(new URL("../api/runtime.ts", import.meta.url), "utf8");
    const composition = readFileSync(new URL("../../../index.ts", import.meta.url), "utf8");
    expect(runtime).not.toContain("features/listing-composition");
    expect(runtime).not.toContain("productionChannelProviderDescriptors");
    expect(composition).toContain("The canonical Channel Listing delist directive is not bound.");
    expect(composition).not.toContain("recordChannelListingPublicationOutcome");
  });

  it("exposes one outcome dependency whose caller receives persisted state rather than caller-minted identity", () => {
    expectTypeOf<NonNullable<OutboundSyncRuntimeDependencies["recordOutcome"]>>().toEqualTypeOf<
      (
        db: PgQueryable,
        operation: OutboundOperationRecord,
        outcome: ChannelPublicationResult | Readonly<{ kind: "outcome-unknown" }>,
      ) => Promise<"applied" | "link-write-refused">
    >();
  });
});

function toProducerCommandFixture(
  operation: OutboundOperationRecord,
  outcome: ProducerPublicationOutcomeCommandFixture["outcome"],
): ProducerPublicationOutcomeCommandFixture {
  return {
    connectionId: operation.connectionId,
    channelListingId: operation.channelListingId,
    operationId: operation.operationId,
    reportedDesiredStateSequence: operation.sourceDesiredStateSequence,
    reportedListingRevision: operation.listingRevision,
    reportedDesiredStateHash: operation.sourceDesiredStateHash,
    outcome,
    expectedStreamVersion: operation.sourceStreamVersion,
  };
}

function persistedOperationFixture(): OutboundOperationRecord {
  return {
    operationId: "operation-a",
    connectionId: "connection-a",
    channelListingId: "channel-listing-a",
    listingId: "listing-a",
    operationKind: "publish",
    listingRevision: 7,
    sourceDesiredStateSequence: 11,
    payload: {
      kind: "draft",
      draft: {
        channelListingId: "channel-listing-a",
        listingRevision: 7,
        title: "Synthetic listing",
        description: "Synthetic fixture",
        categoryKey: "synthetic-category",
        conditionKey: "synthetic-condition",
        price: { amountMinor: 1_000, currency: "USD" },
        quantity: 1,
        attributes: [],
      },
    },
    payloadDigest: "1".repeat(64),
    status: "in-flight",
    revision: 2,
    attemptId: "attempt-a",
    claimGeneration: 1,
    claimantKind: "inline",
    claimOwnerId: "worker-a",
    reservationId: null,
    claimedUntil: "2026-09-07T19:05:00.000Z",
    attemptCount: 1,
    nextAttemptAt: "2026-09-07T19:00:00.000Z",
    lastRejectionCode: null,
    terminalReason: null,
    linkWriteState: "pending",
    sourceEventId: "event-a",
    sourceStreamId: "channels.channel-listing-channel-listing-a",
    sourceStreamVersion: 11,
    sourceGlobalPosition: parseGlobalPosition("11"),
    sourceDesiredStateHash: "2".repeat(64),
    sourceOccurredAt: "2026-09-07T18:59:00.000Z",
    enqueuedAt: "2026-09-07T19:00:00.000Z",
    firstClaimedAt: "2026-09-07T19:00:00.000Z",
    terminalAt: null,
  };
}
