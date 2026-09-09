import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { parseGlobalPosition } from "@chase-sets/event-core/storage";
import type { ChannelListingCompositionServices } from "../../listing-composition/api/runtime";
import type { ChannelPublicationResult } from "../../publication-port/domain/contracts";
import type { OutboundOperationRecord, OutboundSyncRuntimeDependencies } from "../domain/contracts";

type ProducerPublicationOutcomeCommand = Parameters<
  ChannelListingCompositionServices["recordChannelListingPublicationOutcome"]
>[0];

describe("outbound-inline-execution-owner-inventory", () => {
  it("keeps the producer command member set exact and supplies every identity from persisted operation state", () => {
    expectTypeOf<keyof ProducerPublicationOutcomeCommand>().toEqualTypeOf<
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
    expect(toProducerCommand(operation, outcome)).toEqual({
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

  it("binds the landed producer through the slice integration without redeclaring its command", () => {
    const runtime = readFileSync(new URL("../api/runtime.ts", import.meta.url), "utf8");
    const composition = readFileSync(new URL("../../../index.ts", import.meta.url), "utf8");
    const integration = readFileSync(new URL("../integrations/listing-composition.ts", import.meta.url), "utf8");
    expect(runtime).not.toContain("features/listing-composition");
    expect(runtime).not.toContain("productionChannelProviderDescriptors");
    expect(composition).toContain("createChannelListingPublicationOutcomeRecorder(listingComposition)");
    expect(composition).toContain("assertDelistDirective: assertChannelListingDelistDirective");
    expect(integration).toContain('Pick<ChannelListingCompositionServices, "recordChannelListingPublicationOutcome">');
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

function toProducerCommand(
  operation: OutboundOperationRecord,
  outcome: ProducerPublicationOutcomeCommand["outcome"],
): ProducerPublicationOutcomeCommand {
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
