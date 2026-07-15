// Consolidated typed shipment action module — the single fulfillment state machine
// that the web command center and the MCP seller tools both drive. Every seller-facing
// shipment intent (pack, buy the label, void it, dispatch, deliver, return, raise an
// exception) maps to exactly one named action here. Legality is data: an action is only
// legal from the statuses named in its rule, so illegal transitions are rejected in this
// module — never in the UI. The pure resolver derives the context-aware "next action"
// (pack -> label -> dispatch) plus the disclosed actions for any shipment status, so the
// command center and the shipment drawer render one action form without duplicating the
// state machine.

import { assert, FulfillmentDomainError, type PostageLabelStatus, type ShipmentStatus } from "./common";

// The consolidated seller action vocabulary. Packing line confirmations stay inside the
// packing flow; these are the lifecycle transitions the command surface exposes.
export type ShipmentActionName =
  | "start-packing"
  | "complete-packing"
  | "buy-label"
  | "void-label"
  | "dispatch"
  | "record-delivery"
  | "return"
  | "raise-exception";

// How the action reports back on the invoking surface — mirrors the Seller Desk
// blueprint feedback shapes so the command center and the MCP facade stay aligned.
export type ShipmentActionFeedback = "job-progress" | "row-transition" | "confirmation-gate" | "status-banner";

export type ShipmentActionRule = Readonly<{
  action: ShipmentActionName;
  // The statuses this action is legal from. An action requested from any other status is
  // rejected here before it can reach the aggregate.
  allowedFrom: readonly ShipmentStatus[];
  // The status the shipment settles into on success (or "unchanged" for actions that do
  // not move the lifecycle forward, e.g. raising an exception mid-transit).
  resultsIn: ShipmentStatus | "unchanged";
  // When present, the action additionally requires the label to be in this postage state
  // (voiding a label requires a purchased label).
  requiresLabelStatus?: PostageLabelStatus;
  permission: "fulfillment.manage";
  feedback: ShipmentActionFeedback;
}>;

const RULES: readonly ShipmentActionRule[] = [
  {
    action: "start-packing",
    allowedFrom: ["awaiting-package", "packing"],
    resultsIn: "packing",
    permission: "fulfillment.manage",
    feedback: "job-progress",
  },
  {
    action: "complete-packing",
    allowedFrom: ["awaiting-package", "packing"],
    resultsIn: "awaiting-label",
    permission: "fulfillment.manage",
    feedback: "job-progress",
  },
  {
    action: "buy-label",
    allowedFrom: ["awaiting-label"],
    resultsIn: "label-attached",
    permission: "fulfillment.manage",
    feedback: "job-progress",
  },
  {
    action: "void-label",
    allowedFrom: ["label-attached"],
    resultsIn: "awaiting-label",
    requiresLabelStatus: "purchased",
    permission: "fulfillment.manage",
    feedback: "confirmation-gate",
  },
  {
    action: "dispatch",
    allowedFrom: ["label-attached"],
    resultsIn: "dispatched",
    permission: "fulfillment.manage",
    feedback: "row-transition",
  },
  {
    action: "record-delivery",
    allowedFrom: ["dispatched", "exception"],
    resultsIn: "delivered",
    permission: "fulfillment.manage",
    feedback: "row-transition",
  },
  {
    action: "return",
    allowedFrom: ["dispatched", "exception"],
    resultsIn: "returned",
    permission: "fulfillment.manage",
    feedback: "row-transition",
  },
  {
    action: "raise-exception",
    // Any live shipment can enter exception except the terminal delivered/returned
    // states — matching the aggregate decider precisely.
    allowedFrom: ["awaiting-package", "packing", "awaiting-label", "label-attached", "dispatched", "exception"],
    resultsIn: "exception",
    permission: "fulfillment.manage",
    feedback: "status-banner",
  },
] as const;

export const SHIPMENT_ACTION_RULES: Readonly<Record<ShipmentActionName, ShipmentActionRule>> = Object.fromEntries(
  RULES.map((rule) => [rule.action, rule]),
) as Readonly<Record<ShipmentActionName, ShipmentActionRule>>;

export const SHIPMENT_ACTION_NAMES: readonly ShipmentActionName[] = RULES.map((rule) => rule.action);

// Terminal statuses have no seller action left to take.
const TERMINAL_STATUSES: readonly ShipmentStatus[] = ["delivered", "returned", "cancelled"];

export function isTerminalShipmentStatus(status: ShipmentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export type ShipmentActionLegalityInput = Readonly<{
  status: ShipmentStatus;
  labelStatus?: PostageLabelStatus | null;
}>;

// Pure legality check. Returns whether the requested action is legal from the given
// shipment state, without touching the aggregate or any transport.
export function isShipmentActionAllowed(action: ShipmentActionName, input: ShipmentActionLegalityInput): boolean {
  const rule = SHIPMENT_ACTION_RULES[action];
  if (!rule.allowedFrom.includes(input.status)) {
    return false;
  }
  if (rule.requiresLabelStatus && input.labelStatus !== rule.requiresLabelStatus) {
    return false;
  }
  return true;
}

// Rejects an illegal transition in the module — the single guard both transports call
// before dispatching a command, so the UI never has to encode the state machine.
export function assertShipmentActionAllowed(action: ShipmentActionName, input: ShipmentActionLegalityInput): void {
  const rule = SHIPMENT_ACTION_RULES[action];
  assert(
    rule.allowedFrom.includes(input.status),
    `Cannot ${action.replaceAll("-", " ")} a shipment that is ${input.status}.`,
  );
  if (rule.requiresLabelStatus) {
    assert(
      input.labelStatus === rule.requiresLabelStatus,
      `Cannot ${action.replaceAll("-", " ")} a shipment whose label is ${input.labelStatus ?? "not purchased"}.`,
    );
  }
}

export type ShipmentActionDisclosure = "primary" | "disclosed";

export type ShipmentActionPlan = Readonly<{
  status: ShipmentStatus;
  // The one next action the shipment's state calls for (pack -> label -> dispatch), or
  // null when the shipment is terminal or waiting on the carrier.
  primary: ShipmentActionName | null;
  // Every other legal action, kept under disclosure (void, exception, return, deliver).
  disclosed: readonly ShipmentActionName[];
  terminal: boolean;
}>;

// The primary "next action" for each live status — the forward step in the fulfillment
// spine. Statuses absent here surface no primary action (their work is disclosed or the
// shipment is terminal / carrier-driven).
const PRIMARY_BY_STATUS: Partial<Record<ShipmentStatus, ShipmentActionName>> = {
  "awaiting-package": "start-packing",
  packing: "complete-packing",
  "awaiting-label": "buy-label",
  "label-attached": "dispatch",
};

// The order disclosed actions render in — most operationally likely first.
const DISCLOSURE_ORDER: readonly ShipmentActionName[] = ["void-label", "record-delivery", "return", "raise-exception"];

// Derives the context-aware action set for a shipment status: one primary next action
// plus the disclosed remainder. Shared by the command center list, the shipment drawer,
// and the MCP facade so they never diverge from the state machine.
export function resolveShipmentActionPlan(input: ShipmentActionLegalityInput): ShipmentActionPlan {
  const terminal = isTerminalShipmentStatus(input.status);
  const primaryCandidate = PRIMARY_BY_STATUS[input.status];
  const primary = primaryCandidate && isShipmentActionAllowed(primaryCandidate, input) ? primaryCandidate : null;

  const disclosed = DISCLOSURE_ORDER.filter((action) => action !== primary && isShipmentActionAllowed(action, input));

  return { status: input.status, primary, disclosed, terminal };
}

// The lifecycle command issuers the executor drives. The runtime supplies these; the
// specialized label purchase/void orchestration lives in the runtime and is reached
// through buy-label / void-label, which the executor rejects here so callers use the
// dedicated postage paths.
export type ShipmentLifecycleDispatcher = Readonly<{
  startPacking: () => Promise<ShipmentActionResult>;
  completePacking: () => Promise<ShipmentActionResult>;
  dispatch: () => Promise<ShipmentActionResult>;
  recordDelivery: () => Promise<ShipmentActionResult>;
  returnShipment: () => Promise<ShipmentActionResult>;
  raiseException: () => Promise<ShipmentActionResult>;
}>;

export type ShipmentActionResult = Readonly<{ shipmentId: string; version: number }>;

// The single transport-agnostic entry point. The web command center and the MCP seller
// tools both call this with a named action; the pure legality gate runs first, then the
// matching lifecycle command is issued. Label purchase and void keep their dedicated
// postage-provider orchestration and are dispatched through the runtime's postage paths,
// so requesting them here is rejected with a clear pointer.
export async function executeShipmentAction(
  dispatcher: ShipmentLifecycleDispatcher,
  params: Readonly<{ action: ShipmentActionName; current: ShipmentActionLegalityInput }>,
): Promise<ShipmentActionResult> {
  assertShipmentActionAllowed(params.action, params.current);

  switch (params.action) {
    case "start-packing":
      return dispatcher.startPacking();
    case "complete-packing":
      return dispatcher.completePacking();
    case "dispatch":
      return dispatcher.dispatch();
    case "record-delivery":
      return dispatcher.recordDelivery();
    case "return":
      return dispatcher.returnShipment();
    case "raise-exception":
      return dispatcher.raiseException();
    case "buy-label":
    case "void-label":
      throw new FulfillmentDomainError(
        `The ${params.action} action must be dispatched through the postage-label path, not the lifecycle executor.`,
      );
    default:
      return assertNeverAction(params.action);
  }
}

function assertNeverAction(action: never): never {
  throw new FulfillmentDomainError(`Unhandled shipment action: ${JSON.stringify(action)}`);
}
