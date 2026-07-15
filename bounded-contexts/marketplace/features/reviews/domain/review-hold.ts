import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { OrderId } from "@chase-sets/primitives/typed-ids";
import { ensureIsoTimestamp, normalizeRequiredText } from "./common";

export const REVIEW_DIRECTIONS = ["buyer-to-seller", "seller-to-buyer"] as const;

export type ReviewDirection = (typeof REVIEW_DIRECTIONS)[number];
export type ReviewHoldTerminalStatus = "resolved" | "cancelled";

type ReviewHoldRequestState = Readonly<{
  status: "open" | ReviewHoldTerminalStatus;
  directions: readonly ReviewDirection[];
  openedAt: string | null;
  terminalAt: string | null;
}>;

export type ReviewHoldState = Readonly<{
  orderId: OrderId | null;
  requests: Readonly<Record<string, ReviewHoldRequestState>>;
  holdStartedAt: string | null;
}>;

export const initialReviewHoldState: ReviewHoldState = {
  orderId: null,
  requests: {},
  holdStartedAt: null,
};

export type RecordReviewHoldOpenedCommand = Readonly<{
  type: "RecordReviewHoldOpened";
  orderId: OrderId;
  supportRequestId: string;
  openedAt: string;
  directions?: readonly ReviewDirection[];
}>;

export type RecordReviewHoldTerminalCommand = Readonly<{
  type: "RecordReviewHoldTerminal";
  orderId: OrderId;
  supportRequestId: string;
  terminalAt: string;
  terminalStatus: ReviewHoldTerminalStatus;
}>;

export type ReviewHoldCommand = RecordReviewHoldOpenedCommand | RecordReviewHoldTerminalCommand;

type ReviewHoldTransitionData = Readonly<{
  orderId: OrderId;
  supportRequestId: string;
  requestStatus: "open" | ReviewHoldTerminalStatus;
  requestDirections: readonly ReviewDirection[];
  lifecycleAt: string;
  activeSupportRequestIds: readonly string[];
  heldDirections: readonly ReviewDirection[];
  holdStartedAt: string | null;
}>;

export type ReviewHoldPlacedEvent = DomainEvent<"marketplace.review-hold.placed", ReviewHoldTransitionData>;
export type ReviewHoldExtendedEvent = DomainEvent<"marketplace.review-hold.extended", ReviewHoldTransitionData>;
export type ReviewHoldReducedEvent = DomainEvent<"marketplace.review-hold.reduced", ReviewHoldTransitionData>;
export type ReviewHoldReleasedEvent = DomainEvent<"marketplace.review-hold.released", ReviewHoldTransitionData>;
export type ReviewHoldTerminalRecordedEvent = DomainEvent<
  "marketplace.review-hold.terminal-recorded",
  ReviewHoldTransitionData
>;

export type ReviewHoldEvent =
  | ReviewHoldPlacedEvent
  | ReviewHoldExtendedEvent
  | ReviewHoldReducedEvent
  | ReviewHoldReleasedEvent
  | ReviewHoldTerminalRecordedEvent;

function normalizeDirections(directions?: readonly ReviewDirection[]): readonly ReviewDirection[] {
  const normalized = REVIEW_DIRECTIONS.filter((direction) => directions?.includes(direction) ?? true);
  return normalized.length > 0 ? normalized : REVIEW_DIRECTIONS;
}

function activeRequests(requests: ReviewHoldState["requests"]): readonly [string, ReviewHoldRequestState][] {
  return Object.entries(requests)
    .filter((entry): entry is [string, ReviewHoldRequestState] => entry[1].status === "open")
    .sort(([left], [right]) => left.localeCompare(right));
}

function heldDirections(requests: ReviewHoldState["requests"]): readonly ReviewDirection[] {
  const active = activeRequests(requests);
  return REVIEW_DIRECTIONS.filter((direction) => active.some(([, request]) => request.directions.includes(direction)));
}

function transitionData(
  params: Readonly<{
    orderId: OrderId;
    supportRequestId: string;
    request: ReviewHoldRequestState;
    lifecycleAt: string;
    nextRequests: ReviewHoldState["requests"];
    holdStartedAt: string | null;
  }>,
): ReviewHoldTransitionData {
  return {
    orderId: params.orderId,
    supportRequestId: params.supportRequestId,
    requestStatus: params.request.status,
    requestDirections: params.request.directions,
    lifecycleAt: params.lifecycleAt,
    activeSupportRequestIds: activeRequests(params.nextRequests).map(([requestId]) => requestId),
    heldDirections: heldDirections(params.nextRequests),
    holdStartedAt: params.holdStartedAt,
  };
}

export const decideReviewHold: AggregateDecider<ReviewHoldState, ReviewHoldCommand, ReviewHoldEvent> = (
  state,
  command,
) => {
  const supportRequestId = normalizeRequiredText(command.supportRequestId, "Support request is required.");
  const existing = state.requests[supportRequestId];

  if (command.type === "RecordReviewHoldOpened") {
    const openedAt = ensureIsoTimestamp(command.openedAt, "Review hold opening must record a timestamp.");
    if (existing?.status === "open") {
      return [];
    }
    if (existing?.terminalAt && Date.parse(existing.terminalAt) >= Date.parse(openedAt)) {
      return [];
    }

    const request: ReviewHoldRequestState = {
      status: "open",
      directions: normalizeDirections(command.directions),
      openedAt,
      terminalAt: null,
    };
    const nextRequests = { ...state.requests, [supportRequestId]: request };
    const wasHeld = activeRequests(state.requests).length > 0;
    const holdStartedAt = wasHeld ? state.holdStartedAt : openedAt;

    return [
      {
        type: wasHeld ? "marketplace.review-hold.extended" : "marketplace.review-hold.placed",
        data: transitionData({
          orderId: command.orderId,
          supportRequestId,
          request,
          lifecycleAt: openedAt,
          nextRequests,
          holdStartedAt,
        }),
      },
    ];
  }

  const terminalAt = ensureIsoTimestamp(command.terminalAt, "Review hold terminal state must record a timestamp.");
  if (existing?.openedAt && Date.parse(terminalAt) < Date.parse(existing.openedAt)) {
    return [];
  }
  if (existing?.terminalAt && Date.parse(existing.terminalAt) >= Date.parse(terminalAt)) {
    return [];
  }

  const request: ReviewHoldRequestState = {
    status: command.terminalStatus,
    directions: existing?.directions ?? REVIEW_DIRECTIONS,
    openedAt: existing?.openedAt ?? null,
    terminalAt,
  };
  const nextRequests = { ...state.requests, [supportRequestId]: request };
  const wasHeld = activeRequests(state.requests).length > 0;
  const isHeld = activeRequests(nextRequests).length > 0;
  const type = !wasHeld
    ? "marketplace.review-hold.terminal-recorded"
    : isHeld
      ? "marketplace.review-hold.reduced"
      : "marketplace.review-hold.released";

  return [
    {
      type,
      data: transitionData({
        orderId: command.orderId,
        supportRequestId,
        request,
        lifecycleAt: terminalAt,
        nextRequests,
        holdStartedAt: isHeld ? state.holdStartedAt : null,
      }),
    },
  ];
};

export const evolveReviewHold: AggregateEvolver<ReviewHoldState, ReviewHoldEvent> = (state, event) => {
  const data = event.data;
  const previous = state.requests[data.supportRequestId];
  const request: ReviewHoldRequestState =
    data.requestStatus === "open"
      ? {
          status: "open",
          directions: data.requestDirections,
          openedAt: data.lifecycleAt,
          terminalAt: null,
        }
      : {
          status: data.requestStatus,
          directions: data.requestDirections,
          openedAt: previous?.openedAt ?? null,
          terminalAt: data.lifecycleAt,
        };

  return {
    orderId: data.orderId,
    requests: { ...state.requests, [data.supportRequestId]: request },
    holdStartedAt: data.holdStartedAt,
  };
};

export function isReviewDirectionHeld(state: ReviewHoldState, direction: ReviewDirection): boolean {
  return heldDirections(state.requests).includes(direction);
}

export function reviewDirectionForAuthorRole(authorRole: "buyer" | "seller"): ReviewDirection {
  return authorRole === "buyer" ? "buyer-to-seller" : "seller-to-buyer";
}
