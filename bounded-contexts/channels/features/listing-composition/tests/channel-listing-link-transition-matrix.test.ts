import { describe, expect, it } from "vitest";
import {
  decideChannelListingComposition,
  decideChannelListingPublicationOutcome,
  evolveChannelListing,
  initialChannelListingAggregateState,
  type ChannelListingAggregateState,
} from "../domain/link";
import type { ChannelListingCompositionResult, ChannelListingEvent } from "../domain/contracts";
import { channelListingPublishStates } from "../domain/contracts";
import { listingInput, publishedLink } from "./test-support";
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

  it("keeps successful publish and delist steady states inert while admitting a material change", () => {
    let published = desiredState();
    const publication = decideChannelListingPublicationOutcome(
      published,
      report(published, { kind: "succeeded", externalListingId: "external-listing" }),
    );
    if (publication.kind !== "append") throw new Error("Expected publication success.");
    published = evolveChannelListing(published, publication.event);
    const unchangedDraft = composeChannelListingPublication(
      listingInput({ link: { kind: "existing", state: published } }),
    );
    expect(
      decideChannelListingComposition(published, {
        connectionId: published.connectionId,
        channelListingId: published.channelListingId,
        listingId: published.listingId,
        listingRevision: 7,
        nextStreamVersion: 3,
        result: unchangedDraft,
      }),
    ).toEqual({ kind: "unchanged" });

    const base = listingInput({ link: { kind: "existing", state: published } });
    if (base.listing.kind !== "present") throw new Error("Expected listing facts.");
    const changedDraft = composeChannelListingPublication(
      listingInput({
        link: { kind: "existing", state: published },
        listing: {
          ...base.listing,
          offer: { ...base.listing.offer, publishableQuantity: { kind: "resolved", value: 2 } },
        },
      }),
    );
    expect(
      decideChannelListingComposition(published, {
        connectionId: published.connectionId,
        channelListingId: published.channelListingId,
        listingId: published.listingId,
        listingRevision: 7,
        nextStreamVersion: 3,
        result: changedDraft,
      }),
    ).toMatchObject({ kind: "append", event: { data: { desiredStateSequence: 3 } } });

    const delistDesired: ChannelListingEvent = {
      type: "channels.channel-listing.desired-state-changed",
      data: {
        connectionId: published.connectionId,
        channelListingId: published.channelListingId,
        listingId: published.listingId,
        listingRevision: 7,
        desiredStateSequence: 3,
        desiredStateHash: "d".repeat(64),
        intent: "delist",
        delist: {
          channelListingId: published.channelListingId,
          listingRevision: 7,
          lastPublishedPrice: { amountMinor: 2_000, currency: "USD" },
          lastPublishedQuantity: 3,
          delistReasons: ["seller-unavailable"],
        },
      },
    };
    let delisted = evolveChannelListing(published, delistDesired);
    const delistSuccess = decideChannelListingPublicationOutcome(delisted, {
      ...report(delisted, { kind: "succeeded", externalListingId: "external-listing" }),
      operationId: "operation-delist",
    });
    if (delistSuccess.kind !== "append") throw new Error("Expected delist success.");
    delisted = evolveChannelListing(delisted, delistSuccess.event);
    const failing = listingInput({ link: { kind: "existing", state: delisted } });
    if (failing.listing.kind !== "present") throw new Error("Expected listing facts.");
    const blocked = composeChannelListingPublication(
      listingInput({
        link: { kind: "existing", state: delisted },
        listing: { ...failing.listing, sellerAvailabilityStatus: "unavailable" },
      }),
    );
    expect(blocked).toEqual({ kind: "blocked", reasons: ["seller-unavailable"] });
    expect(
      decideChannelListingComposition(delisted, {
        connectionId: delisted.connectionId,
        channelListingId: delisted.channelListingId,
        listingId: delisted.listingId,
        listingRevision: 7,
        nextStreamVersion: 5,
        result: blocked,
      }),
    ).toEqual({ kind: "unchanged" });
  });

  it("never emits a delist when any required last-pushed value is null", () => {
    for (const field of [
      "lastPushedPriceAmountMinor",
      "lastPushedPriceCurrency",
      "lastPushedQuantity",
    ] as const) {
      const input = listingInput({
        link: { kind: "existing", state: publishedLink({ [field]: null }) },
      });
      if (input.listing.kind !== "present") throw new Error("Expected listing facts.");
      expect(
        composeChannelListingPublication({
          ...input,
          listing: { ...input.listing, sellerAvailabilityStatus: "unavailable" },
        }),
        field,
      ).toEqual({ kind: "blocked", reasons: ["seller-unavailable"] });
    }
  });

  it("uses L4 as the sole outcome gate from every retained state", () => {
    const desired = desiredState();
    for (const publishState of channelListingPublishStates) {
      const state = { ...desired, publishState };
      for (const outcome of [
        { kind: "succeeded" as const, externalListingId: "external-listing" },
        { kind: "rejected" as const, code: "validation" as const },
        { kind: "outcome-unknown" as const },
      ]) {
        expect(
          decideChannelListingPublicationOutcome(state, report(state, outcome)),
          `${publishState}/${outcome.kind}`,
        ).toMatchObject({ kind: "append" });
      }
    }
    expect(
      decideChannelListingPublicationOutcome(initialChannelListingAggregateState, {
        connectionId: "connection-synthetic",
        channelListingId: "cl_missing",
        operationId: "operation-missing",
        reportedDesiredStateSequence: 1,
        reportedListingRevision: 7,
        reportedDesiredStateHash: "a".repeat(64),
        outcome: { kind: "outcome-unknown" },
      }),
    ).toEqual({ kind: "refused", code: "unknown-link" });
  });

  it("exhausts every reachable L2 state-by-outcome cell", () => {
    const base = desiredState();
    const draft = base.desiredStates[0]!.payload;
    if (draft.intent === "delist") throw new Error("Expected a publish desire.");
    const publishable: ChannelListingCompositionResult = {
      kind: "publishable",
      intent: "update",
      draft: { ...draft.draft, quantity: 2 },
      desiredStateHash: "b".repeat(64),
    };
    const delist: ChannelListingCompositionResult = {
      kind: "publishable",
      intent: "delist",
      delist: {
        channelListingId: base.channelListingId,
        listingRevision: 7,
        lastPublishedPrice: { amountMinor: 2_000, currency: "USD" },
        lastPublishedQuantity: 3,
        delistReasons: ["seller-unavailable"],
      },
      desiredStateHash: "c".repeat(64),
    };
    const retainedStates = channelListingPublishStates.map((publishState) => ({ ...base, publishState }));
    for (const state of retainedStates) {
      for (const [name, result, expected] of [
        ["publishable", publishable, "pending"],
        ["configuration-blocked", { kind: "blocked", reasons: ["publication-settings-missing"] }, "blocked"],
      ] as const) {
        const decision = decideChannelListingComposition(state, compositionInputFor(state, result));
        expect(decision.kind, `${state.publishState}/${name}`).toBe("append");
        if (decision.kind !== "append") continue;
        expect(evolveChannelListing(state, decision.event).publishState, `${state.publishState}/${name}`).toBe(
          expected,
        );
      }

      if (state.publishState !== "delisted") {
        const decision = decideChannelListingComposition(state, compositionInputFor(state, delist));
        expect(decision.kind, `${state.publishState}/delist`).toBe("append");
        if (decision.kind === "append")
          expect(evolveChannelListing(state, decision.event).publishState).toBe("pending");
      }

      const listingBlocked = { kind: "blocked" as const, reasons: ["seller-unavailable"] as const };
      if (state.publishState === "published") {
        const published = {
          ...state,
          externalListingId: "external-listing",
          lastPushedListingRevision: 7,
          lastPushedPriceAmountMinor: 2_000,
          lastPushedPriceCurrency: "USD",
          lastPushedQuantity: 3,
        };
        const input = listingInput({ link: { kind: "existing", state: published } });
        if (input.listing.kind !== "present") throw new Error("Expected listing facts.");
        expect(
          composeChannelListingPublication({
            ...input,
            listing: { ...input.listing, sellerAvailabilityStatus: "unavailable" },
          }),
          "published/listing-blocked is the L1 delist arm",
        ).toMatchObject({ kind: "publishable", intent: "delist" });
      } else {
        const decision = decideChannelListingComposition(state, compositionInputFor(state, listingBlocked));
        const expectedDecision = state.publishState === "delisted" ? "unchanged" : "append";
        expect(decision.kind, `${state.publishState}/listing-blocked`).toBe(expectedDecision);
        if (decision.kind === "append")
          expect(evolveChannelListing(state, decision.event).publishState).toBe("blocked");
      }

      for (const [name, outcome, expected] of [
        ["succeeded-publish", { kind: "succeeded", externalListingId: "external-listing" }, "published"],
        ["rejected", { kind: "rejected", code: "validation" }, "failed"],
        ["unknown", { kind: "outcome-unknown" }, "failed"],
      ] as const) {
        const decision = decideChannelListingPublicationOutcome(state, report(state, outcome));
        expect(decision.kind, `${state.publishState}/${name}`).toBe("append");
        if (decision.kind === "append") expect(evolveChannelListing(state, decision.event).publishState).toBe(expected);
      }

      const desiredDelist = evolveChannelListing(initialChannelListingAggregateState, {
        type: "channels.channel-listing.desired-state-changed",
        data: {
          connectionId: base.connectionId,
          channelListingId: base.channelListingId,
          listingId: base.listingId,
          listingRevision: 7,
          desiredStateSequence: 1,
          desiredStateHash: delist.desiredStateHash,
          intent: "delist",
          delist: delist.delist,
        },
      });
      const delistState = { ...desiredDelist, publishState: state.publishState };
      const delistOutcome = decideChannelListingPublicationOutcome(
        delistState,
        report(delistState, { kind: "succeeded", externalListingId: "external-listing" }),
      );
      expect(delistOutcome.kind, `${state.publishState}/succeeded-delist`).toBe("append");
      if (delistOutcome.kind === "append")
        expect(evolveChannelListing(delistState, delistOutcome.event).publishState).toBe("delisted");
    }

    const noRowPublish = decideChannelListingComposition(
      initialChannelListingAggregateState,
      compositionInputFor(initialChannelListingAggregateState, { ...publishable, intent: "publish" }),
    );
    expect(noRowPublish.kind).toBe("append");
    if (noRowPublish.kind === "append")
      expect(evolveChannelListing(initialChannelListingAggregateState, noRowPublish.event).publishState).toBe(
        "pending",
      );
    for (const result of [
      { kind: "blocked" as const, reasons: ["publication-settings-missing"] as const },
      { kind: "blocked" as const, reasons: ["seller-unavailable"] as const },
    ]) {
      const decision = decideChannelListingComposition(
        initialChannelListingAggregateState,
        compositionInputFor(initialChannelListingAggregateState, result),
      );
      expect(decision.kind).toBe("append");
      if (decision.kind === "append")
        expect(evolveChannelListing(initialChannelListingAggregateState, decision.event).publishState).toBe("blocked");
    }
    for (const outcome of [
      { kind: "succeeded" as const, externalListingId: "external-listing" },
      { kind: "rejected" as const, code: "validation" as const },
      { kind: "outcome-unknown" as const },
    ]) {
      expect(
        decideChannelListingPublicationOutcome(initialChannelListingAggregateState, {
          connectionId: base.connectionId,
          channelListingId: base.channelListingId,
          operationId: `no-row-${outcome.kind}`,
          reportedDesiredStateSequence: 1,
          reportedListingRevision: 7,
          reportedDesiredStateHash: base.lastDesiredStateHash!,
          outcome,
        }),
      ).toEqual({ kind: "refused", code: "unknown-link" });
    }
  });

  it("refuses a valid tuple reported against a different connection or Link identity", () => {
    const state = desiredState();
    expect(
      decideChannelListingPublicationOutcome(state, {
        ...report(state, { kind: "succeeded", externalListingId: "external-listing" }),
        connectionId: "other-connection",
      }),
    ).toEqual({ kind: "refused", code: "desired-state-mismatch" });
    expect(
      decideChannelListingPublicationOutcome(state, {
        ...report(state, { kind: "succeeded", externalListingId: "external-listing" }),
        channelListingId: "cl_other",
      }),
    ).toEqual({ kind: "refused", code: "desired-state-mismatch" });
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

function compositionInputFor(
  state: ChannelListingAggregateState,
  result: ChannelListingCompositionResult,
): Parameters<typeof decideChannelListingComposition>[1] {
  return {
    connectionId: state.exists ? state.connectionId : "connection-synthetic",
    channelListingId: state.exists ? state.channelListingId : "cl_synthetic",
    listingId: state.exists ? state.listingId : "listing-synthetic",
    listingRevision: 7,
    nextStreamVersion: state.exists ? 2 : 1,
    result,
  };
}
