import { describe, expect, it } from "vitest";
import {
  decideChannelListingComposition,
  decideChannelListingPublicationOutcome,
  evolveChannelListing,
  initialChannelListingAggregateState,
  type ChannelListingAggregateState,
} from "../domain/link";
import type { ChannelListingEvent } from "../domain/contracts";
import { listingInput } from "./test-support";
import { composeChannelListingPublication } from "../domain/compose";

describe("channel-listing-link-transition-matrix", () => {
  it("uses desiredStateSequence independently from equal listing revisions", () => {
    const firstResult = composeChannelListingPublication(listingInput());
    if (firstResult.kind !== "publishable" || firstResult.intent === "delist")
      throw new Error("Expected publish desire.");
    const first = decideChannelListingComposition(initialChannelListingAggregateState, {
      connectionId: "connection-synthetic",
      channelListingId: firstResult.draft.channelListingId,
      listingId: "listing-synthetic",
      listingRevision: 7,
      nextStreamVersion: 1,
      result: firstResult,
    });
    if (first.kind !== "append") throw new Error("Expected append.");
    let state = evolveChannelListing(initialChannelListingAggregateState, first.event);
    const changedResult = {
      ...firstResult,
      desiredStateHash: "b".repeat(64),
      draft: { ...firstResult.draft, quantity: 2 },
    };
    const second = decideChannelListingComposition(state, {
      connectionId: "connection-synthetic",
      channelListingId: firstResult.draft.channelListingId,
      listingId: "listing-synthetic",
      listingRevision: 7,
      nextStreamVersion: 2,
      result: changedResult,
    });
    if (second.kind !== "append") throw new Error("Expected second desire.");
    state = evolveChannelListing(state, second.event);
    expect(state.lastDesiredStateSequence).toBe(2);
    expect(state.lastDesiredListingRevision).toBe(7);
    const stale = decideChannelListingPublicationOutcome(state, {
      connectionId: "connection-synthetic",
      channelListingId: state.channelListingId,
      operationId: "operation-r1",
      reportedDesiredStateSequence: 1,
      reportedListingRevision: 7,
      reportedDesiredStateHash: firstResult.desiredStateHash,
      outcome: { kind: "succeeded", externalListingId: "external-listing", externalOfferId: "external-offer" },
    });
    expect(stale).toMatchObject({ kind: "append", recompose: true, event: { data: { adoption: "identity-adopted" } } });
    if (stale.kind !== "append") throw new Error("Expected stale success adoption.");
    state = evolveChannelListing(state, stale.event);
    expect(state).toMatchObject({
      publishState: "pending",
      externalListingId: "external-listing",
      lastPushedQuantity: null,
    });
  });

  it("admits a current success after a blocked transition and applies state through L4", () => {
    let state = desiredState();
    const blocked: ChannelListingEvent = {
      type: "channels.channel-listing.publication-blocked",
      data: {
        connectionId: state.connectionId,
        channelListingId: state.channelListingId,
        listingId: state.listingId,
        listingRevision: 7,
        reasons: ["seller-unavailable"],
      },
    };
    state = evolveChannelListing(state, blocked);
    expect(state.publishState).toBe("blocked");
    const outcome = decideChannelListingPublicationOutcome(
      state,
      report(state, {
        kind: "succeeded",
        externalListingId: "external-listing",
        externalOfferId: "external-offer",
        providerRevision: "r1",
      }),
    );
    expect(outcome).toMatchObject({ kind: "append", event: { data: { adoption: "identity-and-state-applied" } } });
    if (outcome.kind !== "append") throw new Error("Expected admitted report.");
    state = evolveChannelListing(state, outcome.event);
    expect(state).toMatchObject({ publishState: "published", lastPushedQuantity: 3, blockingReasonCodes: [] });
  });

  it("refuses operation rebound, tuple mismatch and conflicting identity without mutation", () => {
    let state = desiredState();
    const success = decideChannelListingPublicationOutcome(
      state,
      report(state, { kind: "succeeded", externalListingId: "external-a" }),
    );
    if (success.kind !== "append") throw new Error("Expected success.");
    state = evolveChannelListing(state, success.event);
    const snapshot = structuredClone(state);
    expect(
      decideChannelListingPublicationOutcome(state, {
        ...report(state, { kind: "succeeded", externalListingId: "external-a" }),
        reportedDesiredStateHash: "c".repeat(64),
      }),
    ).toEqual({ kind: "refused", code: "desired-state-mismatch" });
    expect(
      decideChannelListingPublicationOutcome(state, {
        ...report(state, { kind: "succeeded", externalListingId: "external-a" }),
        operationId: "operation-other",
        reportedDesiredStateSequence: state.lastDesiredStateSequence!,
        reportedListingRevision: 7,
      }),
    ).toMatchObject({ kind: "append" });
    expect(
      decideChannelListingPublicationOutcome(state, {
        ...report(state, { kind: "succeeded", externalListingId: "external-b" }),
        operationId: "operation-conflict",
      }),
    ).toEqual({ kind: "refused", code: "external-identity-conflict" });
    expect(state).toEqual(snapshot);
  });

  it("keeps published, delisted and blocked day-after compositions inert", () => {
    const state = desiredState();
    const result = composeChannelListingPublication(listingInput({ link: { kind: "existing", state } }));
    const decision = decideChannelListingComposition(state, {
      connectionId: state.connectionId,
      channelListingId: state.channelListingId,
      listingId: state.listingId,
      listingRevision: 7,
      nextStreamVersion: 2,
      result,
    });
    expect(decision.kind).toBe("unchanged");
  });
});

function desiredState(): ChannelListingAggregateState {
  const result = composeChannelListingPublication(listingInput());
  if (result.kind !== "publishable" || result.intent === "delist") throw new Error("Expected publish desire.");
  const event: ChannelListingEvent = {
    type: "channels.channel-listing.desired-state-changed",
    data: {
      intent: "publish",
      connectionId: "connection-synthetic",
      channelListingId: result.draft.channelListingId,
      listingId: "listing-synthetic",
      listingRevision: 7,
      desiredStateSequence: 1,
      desiredStateHash: result.desiredStateHash,
      draft: result.draft,
    },
  };
  return evolveChannelListing(initialChannelListingAggregateState, event);
}

function report(
  state: ChannelListingAggregateState,
  outcome: Parameters<typeof decideChannelListingPublicationOutcome>[1]["outcome"],
) {
  return {
    connectionId: state.connectionId,
    channelListingId: state.channelListingId,
    operationId: "operation-r1",
    reportedDesiredStateSequence: state.lastDesiredStateSequence!,
    reportedListingRevision: state.lastDesiredListingRevision!,
    reportedDesiredStateHash: state.lastDesiredStateHash!,
    outcome,
  };
}
