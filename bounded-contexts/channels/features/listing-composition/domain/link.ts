import type { AggregateEvolver } from "@chase-sets/event-core";
import type {
  ChannelCommandRefusal,
  ChannelListingCompositionResult,
  ChannelListingDesiredStateChangedData,
  ChannelListingEvent,
  ChannelListingLinkState,
  ChannelPublicationAdoption,
  ChannelPublicationBlockingReason,
  ChannelPublicationOutcome,
} from "./contracts";

export type ChannelDesiredStateRecord = Readonly<{
  sequence: number;
  listingRevision: number;
  desiredStateHash: string;
  intent: "publish" | "update" | "delist";
  payload: ChannelListingDesiredStateChangedData;
}>;

export type ChannelOperationBinding = Readonly<{
  channelListingId: string;
  sequence: number;
  listingRevision: number;
  desiredStateHash: string;
}>;

export type ChannelListingAggregateState = ChannelListingLinkState &
  Readonly<{
    exists: boolean;
    desiredStates: readonly ChannelDesiredStateRecord[];
    operationBindings: Readonly<Record<string, ChannelOperationBinding>>;
    appliedReports: readonly string[];
  }>;

export const initialChannelListingAggregateState: ChannelListingAggregateState = {
  exists: false,
  connectionId: "",
  channelListingId: "",
  listingId: "",
  externalListingId: null,
  externalOfferId: null,
  providerRevision: null,
  lastDesiredStateSequence: null,
  lastDesiredListingRevision: null,
  lastDesiredStateHash: null,
  lastDesiredIntent: null,
  lastPushedListingRevision: null,
  lastPushedPriceAmountMinor: null,
  lastPushedPriceCurrency: null,
  lastPushedQuantity: null,
  publishState: "blocked",
  blockingReasonCodes: [],
  failureReason: null,
  driftStatus: null,
  lastStreamVersion: 0,
  desiredStates: [],
  operationBindings: {},
  appliedReports: [],
};

export type LinkCompositionDecision =
  | Readonly<{ kind: "append"; event: ChannelListingEvent }>
  | Readonly<{ kind: "unchanged" }>;

export function decideChannelListingComposition(
  state: ChannelListingAggregateState,
  input: Readonly<{
    connectionId: string;
    channelListingId: string;
    listingId: string;
    listingRevision: number;
    nextStreamVersion: number;
    result: ChannelListingCompositionResult;
  }>,
): LinkCompositionDecision {
  if (input.result.kind === "blocked") {
    if (
      state.exists &&
      state.publishState === "blocked" &&
      equalReasons(state.blockingReasonCodes, input.result.reasons)
    ) {
      return { kind: "unchanged" };
    }
    return {
      kind: "append",
      event: {
        type: "channels.channel-listing.publication-blocked",
        data: {
          connectionId: input.connectionId,
          channelListingId: input.channelListingId,
          listingId: input.listingId,
          listingRevision: input.listingRevision,
          reasons: input.result.reasons,
        },
      },
    };
  }
  if (
    state.exists &&
    state.lastDesiredStateHash === input.result.desiredStateHash &&
    state.lastDesiredIntent === input.result.intent &&
    state.publishState === "pending"
  )
    return { kind: "unchanged" };

  const common = {
    connectionId: input.connectionId,
    channelListingId: input.channelListingId,
    listingId: input.listingId,
    listingRevision: input.listingRevision,
    desiredStateSequence: input.nextStreamVersion,
    desiredStateHash: input.result.desiredStateHash,
  };
  return input.result.intent === "delist"
    ? {
        kind: "append",
        event: {
          type: "channels.channel-listing.desired-state-changed",
          data: { ...common, intent: "delist", delist: input.result.delist },
        },
      }
    : {
        kind: "append",
        event: {
          type: "channels.channel-listing.desired-state-changed",
          data: { ...common, intent: input.result.intent, draft: input.result.draft },
        },
      };
}

export type PublicationOutcomeDecision =
  | Readonly<{ kind: "append"; event: ChannelListingEvent; recompose: boolean }>
  | Readonly<{ kind: "unchanged"; recompose: boolean }>
  | Readonly<{ kind: "refused"; code: ChannelCommandRefusal }>;

export function decideChannelListingPublicationOutcome(
  state: ChannelListingAggregateState,
  input: Readonly<{
    connectionId: string;
    channelListingId: string;
    operationId: string;
    reportedDesiredStateSequence: number;
    reportedListingRevision: number;
    reportedDesiredStateHash: string;
    outcome: ChannelPublicationOutcome;
  }>,
): PublicationOutcomeDecision {
  if (!state.exists) return { kind: "refused", code: "unknown-link" };
  const desired = state.desiredStates.find(
    (candidate) =>
      candidate.sequence === input.reportedDesiredStateSequence &&
      candidate.listingRevision === input.reportedListingRevision &&
      candidate.desiredStateHash === input.reportedDesiredStateHash,
  );
  if (!desired) return { kind: "refused", code: "desired-state-mismatch" };
  const binding: ChannelOperationBinding = {
    channelListingId: input.channelListingId,
    sequence: input.reportedDesiredStateSequence,
    listingRevision: input.reportedListingRevision,
    desiredStateHash: input.reportedDesiredStateHash,
  };
  const existingBinding = state.operationBindings[input.operationId];
  if (existingBinding && JSON.stringify(existingBinding) !== JSON.stringify(binding)) {
    return { kind: "refused", code: "operation-rebound" };
  }
  const reportIdentity = reportKey(input);
  if (state.appliedReports.includes(reportIdentity)) return { kind: "unchanged", recompose: false };

  const isSuccess = input.outcome.kind === "succeeded";
  if (isSuccess && identityConflicts(state, input.outcome)) {
    return { kind: "refused", code: "external-identity-conflict" };
  }
  const current = input.reportedDesiredStateSequence === state.lastDesiredStateSequence;
  if (!current && !isSuccess) return { kind: "unchanged", recompose: false };
  const adoption: ChannelPublicationAdoption = isSuccess
    ? current
      ? "identity-and-state-applied"
      : "identity-adopted"
    : "none";
  return {
    kind: "append",
    recompose: isSuccess,
    event: {
      type: "channels.channel-listing.publication-recorded",
      data: {
        connectionId: input.connectionId,
        channelListingId: input.channelListingId,
        operationId: input.operationId,
        reportedDesiredStateSequence: input.reportedDesiredStateSequence,
        reportedListingRevision: input.reportedListingRevision,
        reportedDesiredStateHash: input.reportedDesiredStateHash,
        outcome: input.outcome,
        adoption,
      },
    },
  };
}

export const evolveChannelListing: AggregateEvolver<ChannelListingAggregateState, ChannelListingEvent> = (
  state,
  event,
) => {
  const lastStreamVersion = state.lastStreamVersion + 1;
  switch (event.type) {
    case "channels.channel-listing.desired-state-changed": {
      const desired: ChannelDesiredStateRecord = {
        sequence: event.data.desiredStateSequence,
        listingRevision: event.data.listingRevision,
        desiredStateHash: event.data.desiredStateHash,
        intent: event.data.intent,
        payload: event.data,
      };
      return {
        ...state,
        exists: true,
        connectionId: event.data.connectionId,
        channelListingId: event.data.channelListingId,
        listingId: event.data.listingId,
        lastDesiredStateSequence: event.data.desiredStateSequence,
        lastDesiredListingRevision: event.data.listingRevision,
        lastDesiredStateHash: event.data.desiredStateHash,
        lastDesiredIntent: event.data.intent,
        publishState: "pending",
        blockingReasonCodes: [],
        failureReason: null,
        lastStreamVersion,
        desiredStates: [...state.desiredStates, desired],
      };
    }
    case "channels.channel-listing.publication-blocked":
      return {
        ...state,
        exists: true,
        connectionId: event.data.connectionId,
        channelListingId: event.data.channelListingId,
        listingId: event.data.listingId,
        publishState: "blocked",
        blockingReasonCodes: event.data.reasons,
        failureReason: null,
        lastStreamVersion,
      };
    case "channels.channel-listing.publication-recorded": {
      const desired = state.desiredStates.find(
        (candidate) => candidate.sequence === event.data.reportedDesiredStateSequence,
      )!;
      const outcome = event.data.outcome;
      const report = reportKey(event.data);
      const operationBindings = {
        ...state.operationBindings,
        [event.data.operationId]: {
          channelListingId: event.data.channelListingId,
          sequence: event.data.reportedDesiredStateSequence,
          listingRevision: event.data.reportedListingRevision,
          desiredStateHash: event.data.reportedDesiredStateHash,
        },
      };
      if (outcome.kind === "succeeded" && event.data.adoption === "identity-adopted") {
        return {
          ...state,
          externalListingId: state.externalListingId ?? outcome.externalListingId,
          externalOfferId: state.externalOfferId ?? outcome.externalOfferId ?? null,
          providerRevision: state.providerRevision ?? outcome.providerRevision ?? null,
          operationBindings,
          appliedReports: [...state.appliedReports, report],
          lastStreamVersion,
        };
      }
      if (outcome.kind === "succeeded") {
        const publishState = desired.intent === "delist" ? "delisted" : "published";
        const pushed =
          desired.payload.intent === "delist"
            ? { lastPushedQuantity: 0 }
            : {
                lastPushedListingRevision: desired.payload.listingRevision,
                lastPushedPriceAmountMinor: desired.payload.draft.price.amountMinor,
                lastPushedPriceCurrency: desired.payload.draft.price.currency,
                lastPushedQuantity: desired.payload.draft.quantity,
              };
        return {
          ...state,
          ...pushed,
          externalListingId: outcome.externalListingId,
          externalOfferId: outcome.externalOfferId ?? state.externalOfferId,
          providerRevision: outcome.providerRevision ?? state.providerRevision,
          publishState,
          blockingReasonCodes: [],
          failureReason: null,
          operationBindings,
          appliedReports: [...state.appliedReports, report],
          lastStreamVersion,
        };
      }
      return {
        ...state,
        publishState: "failed",
        blockingReasonCodes: [],
        failureReason: outcome.kind === "rejected" ? outcome.code : "outcome-unknown",
        operationBindings,
        appliedReports: [...state.appliedReports, report],
        lastStreamVersion,
      };
    }
  }
};

function identityConflicts(
  state: ChannelListingAggregateState,
  outcome: Extract<ChannelPublicationOutcome, { kind: "succeeded" }>,
): boolean {
  return (
    (state.externalListingId !== null && state.externalListingId !== outcome.externalListingId) ||
    (state.externalOfferId !== null &&
      outcome.externalOfferId !== undefined &&
      state.externalOfferId !== outcome.externalOfferId)
  );
}

function equalReasons(
  left: readonly ChannelPublicationBlockingReason[],
  right: readonly ChannelPublicationBlockingReason[],
): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function reportKey(
  input: Readonly<{
    operationId: string;
    reportedDesiredStateSequence: number;
    reportedListingRevision: number;
    reportedDesiredStateHash: string;
    outcome: ChannelPublicationOutcome;
  }>,
): string {
  return JSON.stringify([
    input.operationId,
    input.reportedDesiredStateSequence,
    input.reportedListingRevision,
    input.reportedDesiredStateHash,
    input.outcome,
  ]);
}
