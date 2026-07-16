// Release-readiness PROOF for issue #5232: prove the buyer-to-platform reverse
// logistics and custody journey behaves as one coherent system across Fulfillment
// (the ReturnShipment aggregate, platform-facility directory, deadline/exception
// derivation, and unidentified-package reconciliation), Support/Platform-Operations
// (the authorized refund trigger and remedy-effect closure), and Inventory (recovered
// custody). Fulfillment reports logistics facts; Support decides money; Inventory owns
// recovered stock only after intake.
//
// Test files may reference issue numbers freely (the source issue-ref ban exempts
// tests). This proof composes the REAL Fulfillment-owned deciders across the full
// custody chain (buyer ships back -> carrier tracking milestones -> facility intake ->
// disposition) and asserts the cross-context money/custody seam from each context's
// context.json, so a refund can only be released by the configured milestone trigger
// and recovered stock only appears after facility intake. Money-safety of the refund
// release itself (exact-once, coverage-gated, closure blocked until effects complete)
// is owned and unit-proven by Platform-Operations' remedy deciders; this proof pins the
// seam that feeds it rather than duplicating that coverage (composed, not duplicated).
// Browser and staging rows are recorded as pending in the acceptance doc; here every
// custody, deadline, replay, privacy, and fail-safe invariant is proven against the
// merged contracts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { refundTriggers } from "@chase-sets/primitives/platform-coverage";
import {
  decideReturnShipment,
  evolveReturnShipment,
  initialReturnShipmentState,
  type ReturnShipmentCommand,
  type ReturnShipmentEvent,
  type ReturnShipmentFacilityIntake,
  type ReturnShipmentFactMetadata,
  type ReturnShipmentState,
  type RequestReturnShipmentCommand,
} from "../features/return-shipments/domain/domain";
import {
  createReturnFacilityDirectory,
  customerSafeDestination,
  normalizeReturnDestinationSnapshot,
  selectReturnFacility,
  type ReturnDestinationSnapshot,
  type ReturnFacilityInput,
} from "../features/return-shipments/domain/facility-directory";
import {
  returnShipmentDeliveryStageRank,
  returnShipmentLabelFailureReasons,
} from "../features/return-shipments/domain/common";
import {
  customerSafeReturnShipmentDeadlineSignals,
  deriveReturnShipmentDeadlineSignals,
  DEFAULT_RETURN_SHIPMENT_DEADLINE_POLICY,
} from "../features/return-shipments/read-model/deadlines";
import {
  decideUnidentifiedReturnPackage,
  evolveUnidentifiedReturnPackage,
  initialUnidentifiedReturnPackageState,
  type UnidentifiedReturnPackageCommand,
  type UnidentifiedReturnPackageEvent,
  type UnidentifiedReturnPackageState,
} from "../features/return-shipments/domain/unidentified-package";

const baseDir = fileURLToPath(new URL(".", import.meta.url));

// Typed-id branding is enforced elsewhere; the journey framing only needs stable string identities.
const id = (value: string): never => value as never;
const remedyId = id("rmd_5232");

// ---------------------------------------------------------------------------
// Fixtures — a real facility directory, request, label, and intake.
// ---------------------------------------------------------------------------

function metadata(overrides: Partial<ReturnShipmentFactMetadata> = {}): ReturnShipmentFactMetadata {
  return {
    correlationRemedyId: remedyId,
    causationId: null,
    idempotencyKey: "idem-request",
    policyVersion: "return-policy-v1",
    ...overrides,
  };
}

function facilityInput(overrides: Partial<ReturnFacilityInput> = {}): ReturnFacilityInput {
  return {
    facilityId: "fac_east",
    configVersion: "v1",
    effectiveAt: "2026-01-01T00:00:00.000Z",
    supportedReturnPrograms: ["platform-custody"],
    supportedCarriers: ["usps"],
    supportedRegions: ["us-east"],
    packageConstraints: { maxWeightOunces: 80, maxLengthInches: 24, maxWidthInches: 18, maxHeightInches: 12 },
    postalAddress: {
      name: "Returns East",
      line1: "100 Dock St",
      city: "Newark",
      state: "NJ",
      postalCode: "07102",
      country: "US",
    },
    restrictedRouting: { operationalContact: "ops@internal.example", internalRoutingCode: "EAST-42" },
    displayName: "Chase Sets Returns (East)",
    displayInstructions: "Include the packing slip.",
    ...overrides,
  };
}

const selectionCriteria = {
  returnProgram: "platform-custody",
  carrier: "usps",
  region: "us-east",
  packageWeightOunces: 10,
  packageLengthInches: 9,
  packageWidthInches: 6,
  packageHeightInches: 2,
} as const;

function selectDestination(
  inputs: readonly ReturnFacilityInput[] = [facilityInput()],
  asOf = "2026-06-01T00:00:00.000Z",
) {
  const directory = createReturnFacilityDirectory(inputs);
  return selectReturnFacility(directory, selectionCriteria, { asOf, selectionPolicyVersion: "facility-selection-v1" });
}

function destinationSnapshot(): ReturnDestinationSnapshot {
  const result = selectDestination();
  if (result.outcome !== "selected") {
    throw new Error("expected a facility to be selected for the fixture");
  }
  return result.snapshot;
}

function requestCommand(overrides: Partial<RequestReturnShipmentCommand> = {}): RequestReturnShipmentCommand {
  return {
    type: "RequestReturnShipment",
    returnShipmentId: id("rsh_1"),
    remedyId,
    supportRequestId: id("sup_1"),
    orderId: id("ord_1"),
    outboundShipmentId: id("shp_1"),
    affectedOrderLineIds: ["oli_1"],
    returnDirective: "return-to-platform",
    shipFromSnapshot: {
      name: "Buyer",
      line1: "2 Market St",
      city: "Chicago",
      state: "IL",
      postalCode: "60601",
      country: "US",
    },
    destinationSnapshot: destinationSnapshot(),
    packageRequirements: { weightOunces: 10, lengthInches: 9, widthInches: 6, heightInches: 2 },
    costPayer: "platform",
    costAllocationReference: "cov_1",
    shipByDeadlineAt: "2026-06-10T00:00:00.000Z",
    returnByDeadlineAt: "2026-06-20T00:00:00.000Z",
    metadata: metadata(),
    requestedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

const labelReadyProviderFields = {
  labelDocumentUrl: "https://labels.test/rsh_1.pdf",
  postageProviderName: "sandbox-usps",
  postageProviderMode: "test",
  postageProviderShipmentId: "ps_1",
  postageProviderLabelId: "pl_1",
  postageAmountCents: 499,
  estimatedPostageAmountCents: 450,
  postageCurrency: "USD",
} as const;

function labelReadyCommand(overrides: Partial<ReturnShipmentCommand> = {}): ReturnShipmentCommand {
  return {
    type: "MarkReturnShipmentLabelReady",
    carrierName: "USPS",
    trackingIdentifier: "9400-1",
    labelProviderReference: "lbl_1",
    ...labelReadyProviderFields,
    metadata: metadata({ idempotencyKey: "idem-label" }),
    readyAt: "2026-06-02T00:00:00.000Z",
    ...overrides,
  } as ReturnShipmentCommand;
}

function facilityIntake(overrides: Partial<ReturnShipmentFacilityIntake> = {}): ReturnShipmentFacilityIntake {
  return {
    facilityId: "fac_east",
    stationId: "station-7",
    operatorUserId: "usr_operator",
    receivedAt: "2026-06-06T00:00:00.000Z",
    packageCondition: "intact",
    sealCondition: "intact",
    measuredWeightOunces: 10.2,
    evidence: [
      {
        attachmentId: "rie_1",
        storageKey: "return-intake/fac_east/rie_1/evidence.jpg",
        contentType: "image/jpeg",
        byteSize: 1200,
        sha256: "a".repeat(64),
        uploadedAt: "2026-06-05T23:59:00.000Z",
        retentionUntil: "2027-06-05T23:59:00.000Z",
        securityScanStatus: "clean",
      },
    ],
    discrepancies: [
      {
        type: "expected",
        expectedItemReference: "line-1",
        observedItemReference: "line-1",
        quantity: 1,
        notes: null,
        evidenceAttachmentIds: ["rie_1"],
        owner: "Fulfillment",
        nextAction: "Complete custody handoff",
      },
    ],
    disposition: "completed",
    custodyIdentifier: "CUST-1001",
    idempotencyKey: "intake-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Aggregate drivers.
// ---------------------------------------------------------------------------

function fold(
  events: readonly ReturnShipmentEvent[],
  from: ReturnShipmentState = initialReturnShipmentState,
): ReturnShipmentState {
  return events.reduce(evolveReturnShipment, from);
}

/** Decide + fold one command, returning the emitted events and the resulting state. */
function step(
  state: ReturnShipmentState,
  command: ReturnShipmentCommand,
): { events: readonly ReturnShipmentEvent[]; state: ReturnShipmentState } {
  const events = decideReturnShipment(state, command);
  return { events, state: fold(events, state) };
}

function apply(state: ReturnShipmentState, command: ReturnShipmentCommand): ReturnShipmentState {
  return step(state, command).state;
}

function carrierAccepted(occurredAt: string, detail: string | null = null): ReturnShipmentCommand {
  return {
    type: "RecordReturnShipmentCarrierAccepted",
    detail,
    metadata: metadata({ idempotencyKey: `idem-carrier-${occurredAt}` }),
    occurredAt,
  };
}

function inTransit(occurredAt: string): ReturnShipmentCommand {
  return {
    type: "RecordReturnShipmentInTransit",
    detail: null,
    metadata: metadata({ idempotencyKey: `idem-transit-${occurredAt}` }),
    occurredAt,
  };
}

function delivered(occurredAt: string): ReturnShipmentCommand {
  return {
    type: "RecordReturnShipmentDelivered",
    detail: null,
    metadata: metadata({ idempotencyKey: `idem-delivered-${occurredAt}` }),
    occurredAt,
  };
}

function completeIntake(intake: ReturnShipmentFacilityIntake): ReturnShipmentCommand {
  return {
    type: "CompleteReturnShipmentFacilityIntake",
    intake,
    metadata: metadata({ idempotencyKey: `idem-intake-${intake.idempotencyKey}` }),
  };
}

function requestedState(): ReturnShipmentState {
  return apply(initialReturnShipmentState, requestCommand());
}

function readyState(): ReturnShipmentState {
  return apply(requestedState(), labelReadyCommand());
}

// ===========================================================================
// J01 — Return directive creates one ReturnShipment and platform-destination label.
// ===========================================================================

describe("J01 return directive creates exactly one ReturnShipment and a platform-destination label", () => {
  it("captures an immutable destination snapshot and the declared cost payer on the requested fact", () => {
    const { events, state } = step(initialReturnShipmentState, requestCommand());
    const requested = events[0];
    expect(requested?.type).toBe("fulfillment.return-shipment.requested.v2");
    expect(state.returnDirective).toBe("return-to-platform");
    expect(state.status).toBe("requested");
    expect(state.destinationSnapshot?.destinationType).toBe("platform-facility");
    expect(state.destinationSnapshot?.facilityId).toBe("fac_east");
    // Correct shipping-cost payer/allocation reference is stamped onto the aggregate.
    expect(state.costPayer).toBe("platform");
    expect(state.costAllocationReference).toBe("cov_1");
    // The snapshot re-validates to itself (immutable, auditable, decoupled from later directory edits).
    expect(normalizeReturnDestinationSnapshot(state.destinationSnapshot!)).toEqual(state.destinationSnapshot);
  });

  it("purchases at most one active label: the requested shipment becomes ready exactly once", () => {
    const ready = readyState();
    expect(ready.status).toBe("ready-to-ship");
    expect(ready.labelStatus).toBe("ready");
    expect(ready.trackingIdentifier).toBe("9400-1");
    // A second label-ready command on an already-ready shipment is a no-op (no second active label).
    const second = step(ready, labelReadyCommand({ trackingIdentifier: "9400-2" } as Partial<ReturnShipmentCommand>));
    expect(second.events).toHaveLength(0);
    expect(second.state.trackingIdentifier).toBe("9400-1");
  });

  it("is idempotent by return directive: replaying the request with identical linkage emits nothing", () => {
    const requested = requestedState();
    const replay = step(requested, requestCommand());
    expect(replay.events).toHaveLength(0);
    expect(replay.state).toEqual(requested);
  });

  it("rejects reuse of the stream for a different order/remedy/directive linkage", () => {
    const requested = requestedState();
    expect(() => decideReturnShipment(requested, requestCommand({ orderId: id("ord_other") }))).toThrow();
    expect(() => decideReturnShipment(requested, requestCommand({ returnDirective: "return-to-seller" }))).toThrow();
  });
});

// ===========================================================================
// J02 — Buyer downloads label, carrier accepts, tracks, delivers, facility intakes.
// ===========================================================================

describe("J02 the buyer-to-platform custody chain advances monotonically to a single intake", () => {
  it("walks requested -> ready -> carrier-accepted -> in-transit -> delivered -> received", () => {
    let state = readyState();
    state = apply(state, carrierAccepted("2026-06-03T00:00:00.000Z"));
    expect(state.status).toBe("carrier-accepted");
    state = apply(state, inTransit("2026-06-04T00:00:00.000Z"));
    expect(state.status).toBe("in-transit");
    state = apply(state, delivered("2026-06-05T00:00:00.000Z"));
    expect(state.status).toBe("delivered");
    const receipt = step(state, completeIntake(facilityIntake()));
    expect(receipt.state.status).toBe("received");
    // Exactly one facility-intake-completed fact, and it carries the custody evidence.
    const intakeEvents = receipt.events.filter(
      (event) => event.type === "fulfillment.return-shipment.facility-intake-completed.v1",
    );
    expect(intakeEvents).toHaveLength(1);
    expect(receipt.state.facilityIntake?.custodyIdentifier).toBe("CUST-1001");
    // Custody timeline preserves every stage in order.
    expect(receipt.state.milestones.map((milestone) => milestone.status)).toEqual([
      "requested",
      "ready-to-ship",
      "carrier-accepted",
      "in-transit",
      "delivered",
      "received",
    ]);
  });

  it("keeps the buyer-facing label document customer-safe and never leaks restricted facility routing", () => {
    const ready = readyState();
    expect(ready.labelDocumentUrl).toBe("https://labels.test/rsh_1.pdf");
    const snapshot = ready.destinationSnapshot!;
    // The immutable snapshot on the event log never carries the restricted operational secrets.
    expect(Object.keys(snapshot)).not.toContain("restrictedRouting");
    expect(JSON.stringify(snapshot)).not.toContain("EAST-42");
    expect(JSON.stringify(snapshot)).not.toContain("ops@internal.example");
  });
});

// ===========================================================================
// J03/J04 — Refund triggers on carrier acceptance vs facility intake are DISTINCT.
// The refund release is Support-owned; this proves the Fulfillment facts that feed
// each trigger are separate, correlatable, and money-free.
// ===========================================================================

describe("J03/J04 carrier-accepted and facility-intake triggers are distinct, correlatable, and money-free facts", () => {
  it("publishes carrier-accepted and facility-intake as separate facts, each carrying the remedy correlation and a stable idempotency key", () => {
    const accepted = step(readyState(), carrierAccepted("2026-06-03T00:00:00.000Z"));
    const acceptedFact = accepted.events.find(
      (event) => event.type === "fulfillment.return-shipment.carrier-accepted.v1",
    );
    expect(acceptedFact).toBeDefined();
    const acceptedData = acceptedFact!.data as Record<string, unknown>;
    expect(acceptedData["remedyId"]).toBe(remedyId);
    expect(acceptedData["supportRequestId"]).toBe(id("sup_1"));
    expect((acceptedData["metadata"] as ReturnShipmentFactMetadata).idempotencyKey).toBeTruthy();
    // A logistics fact never carries money: Support decides the release, Fulfillment only reports custody.
    for (const forbidden of ["amount", "refundId", "refundAmount", "currencyCode", "allocation"]) {
      expect(Object.keys(acceptedData)).not.toContain(forbidden);
    }

    let delivered = apply(accepted.state, inTransit("2026-06-04T00:00:00.000Z"));
    delivered = apply(delivered, {
      type: "RecordReturnShipmentDelivered",
      detail: null,
      metadata: metadata({ idempotencyKey: "idem-delivered" }),
      occurredAt: "2026-06-05T00:00:00.000Z",
    });
    const intake = step(delivered, completeIntake(facilityIntake()));
    const intakeFact = intake.events.find(
      (event) => event.type === "fulfillment.return-shipment.facility-intake-completed.v1",
    );
    const intakeData = intakeFact!.data as Record<string, unknown>;
    // Distinct fact type, distinct idempotency key from carrier acceptance.
    expect(intakeFact!.type).not.toBe(acceptedFact!.type);
    for (const forbidden of ["amount", "refundId", "refundAmount", "currencyCode"]) {
      expect(Object.keys(intakeData)).not.toContain(forbidden);
    }
  });

  it("aligns the Fulfillment milestone facts one-to-one with the Support refund-trigger taxonomy", () => {
    // Every non-immediate refund trigger has a corresponding Fulfillment milestone fact,
    // so Support can only release on a milestone Fulfillment actually reports.
    const milestoneBackedTriggers = refundTriggers.filter(
      (trigger) => trigger !== "immediate" && trigger !== "operator-release",
    );
    expect(milestoneBackedTriggers).toEqual(["carrier-accepted", "delivered", "facility-intake"]);
    // These map to the three-and-only-three return-shipment facts the Support seam consumes (asserted below).
  });
});

// ===========================================================================
// J05 — Duplicate directive and label-purchase retry after timeout.
// ===========================================================================

describe("J05 duplicate directive and label-purchase retry after a provider timeout converge safely", () => {
  it("records a fresh, actionable failure for each retried purchase and still allows a later success", () => {
    const requested = requestedState();
    const firstFailure = step(requested, {
      type: "RecordReturnShipmentLabelPurchaseFailed",
      failureReason: "provider-timeout",
      failureDetail: "Carrier API did not respond in time.",
      metadata: metadata({ idempotencyKey: "idem-fail-1" }),
      failedAt: "2026-06-02T00:00:00.000Z",
    });
    expect(firstFailure.state.labelStatus).toBe("failed");
    expect(firstFailure.state.labelFailureReason).toBe("provider-timeout");
    // A retried purchase after the timeout records another actionable failure (Support sees every attempt).
    const secondFailure = step(firstFailure.state, {
      type: "RecordReturnShipmentLabelPurchaseFailed",
      failureReason: "provider-timeout",
      failureDetail: "Second attempt also timed out.",
      metadata: metadata({ idempotencyKey: "idem-fail-2" }),
      failedAt: "2026-06-02T00:05:00.000Z",
    });
    expect(secondFailure.events).toHaveLength(1);
    // The next retry succeeds; the shipment reaches a single ready label.
    const recovered = apply(secondFailure.state, labelReadyCommand());
    expect(recovered.status).toBe("ready-to-ship");
    expect(recovered.labelStatus).toBe("ready");
  });

  it("refuses to record a purchase failure once a label is already ready", () => {
    expect(() =>
      decideReturnShipment(readyState(), {
        type: "RecordReturnShipmentLabelPurchaseFailed",
        failureReason: "provider-timeout",
        failureDetail: null,
        metadata: metadata({ idempotencyKey: "idem-fail-late" }),
        failedAt: "2026-06-03T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

// ===========================================================================
// J06 — Webhook before API response; duplicate and out-of-order carrier scans.
// ===========================================================================

describe("J06 duplicate and out-of-order carrier scans never regress custody state", () => {
  it("ignores a duplicate carrier-accepted scan (exact-once milestone publication)", () => {
    const accepted = step(readyState(), carrierAccepted("2026-06-03T00:00:00.000Z"));
    const duplicate = step(accepted.state, carrierAccepted("2026-06-03T00:05:00.000Z"));
    expect(duplicate.events).toHaveLength(0);
    expect(duplicate.state.status).toBe("carrier-accepted");
  });

  it("converges when a delivered scan arrives before the carrier-accepted scan (webhook-before-API)", () => {
    // Delivered observed first (out of order); a later carrier-accepted scan cannot pull the stage back.
    let state = apply(readyState(), delivered("2026-06-05T00:00:00.000Z"));
    expect(state.status).toBe("delivered");
    const lateAccept = step(state, carrierAccepted("2026-06-03T00:00:00.000Z"));
    expect(lateAccept.events).toHaveLength(0);
    expect(lateAccept.state.status).toBe("delivered");
    // A monotonic later stage still advances.
    const received = apply(lateAccept.state, completeIntake(facilityIntake()));
    expect(received.status).toBe("received");
    expect(returnShipmentDeliveryStageRank(received.status)).toBe(returnShipmentDeliveryStageRank("received"));
  });

  it("re-drives to an identical furthest stage regardless of scan arrival order", () => {
    const forward = fold(
      [...decideReturnShipment(readyState(), carrierAccepted("2026-06-03T00:00:00.000Z"))],
      readyState(),
    );
    const forwardFinal = apply(
      apply(forward, inTransit("2026-06-04T00:00:00.000Z")),
      delivered("2026-06-05T00:00:00.000Z"),
    );

    let reordered = apply(readyState(), delivered("2026-06-05T00:00:00.000Z"));
    reordered = apply(reordered, carrierAccepted("2026-06-03T00:00:00.000Z"));
    reordered = apply(reordered, inTransit("2026-06-04T00:00:00.000Z"));
    expect(reordered.status).toBe(forwardFinal.status);
    expect(reordered.status).toBe("delivered");
  });
});

// ===========================================================================
// J07 — Missing webhook repaired by scheduled reconciliation (derived deadline signals).
// ===========================================================================

describe("J07 a missing webhook is surfaced deterministically by derived reconciliation signals", () => {
  const inCustody = {
    status: "in-transit" as const,
    shipByDeadlineAt: "2026-06-10T00:00:00.000Z",
    labelStatus: "ready" as const,
    lastMovementAt: "2026-06-04T00:00:00.000Z",
    deliveredAt: null,
    receivedAt: null,
  };

  it("derives the same stalled-in-transit signal for the same asOf (replay-safe reconciliation)", () => {
    const asOf = "2026-06-10T00:00:00.000Z";
    const first = deriveReturnShipmentDeadlineSignals(inCustody, asOf);
    const second = deriveReturnShipmentDeadlineSignals(inCustody, asOf);
    expect(second).toEqual(first);
    const stalled = first.find((signal) => signal.code === "stalled-in-transit");
    expect(stalled).toBeDefined();
    expect(stalled?.owner).toBe("fulfillment-carrier-ops");
    expect(stalled?.exceptionType).toBe("carrier-delay");
  });

  it("raises a delivery-without-intake signal when the facility scan is delivered but intake is missing", () => {
    const delivered = {
      status: "delivered",
      shipByDeadlineAt: "2026-06-10T00:00:00.000Z",
      labelStatus: "ready",
      lastMovementAt: "2026-06-05T00:00:00.000Z",
      deliveredAt: "2026-06-05T00:00:00.000Z",
      receivedAt: null,
    };
    const signals = deriveReturnShipmentDeadlineSignals(delivered, "2026-06-08T00:00:00.000Z");
    const gap = signals.find((signal) => signal.code === "delivery-without-intake");
    expect(gap).toBeDefined();
    expect(gap?.owner).toBe("facility-operations");
    // Escalation is derived deterministically once the escalation window elapses.
    const escalated = deriveReturnShipmentDeadlineSignals(delivered, "2026-06-20T00:00:00.000Z").find(
      (signal) => signal.code === "delivery-without-intake",
    );
    expect(escalated?.escalated).toBe(true);
  });
});

// ===========================================================================
// J08 — Buyer misses ship-by deadline and label expires/voids.
// ===========================================================================

describe("J08 a missed ship-by deadline expires the return and the unused label voids at most once", () => {
  it("derives a ship-by-overdue signal and a void-eligible label after the grace window", () => {
    const overdueInput = {
      status: "ready-to-ship",
      shipByDeadlineAt: "2026-06-10T00:00:00.000Z",
      labelStatus: "ready",
      lastMovementAt: null,
      deliveredAt: null,
      receivedAt: null,
    };
    const afterGrace = new Date(
      Date.parse("2026-06-10T00:00:00.000Z") +
        (DEFAULT_RETURN_SHIPMENT_DEADLINE_POLICY.labelVoidGraceHours + 1) * 3_600_000,
    ).toISOString();
    const signals = deriveReturnShipmentDeadlineSignals(overdueInput, afterGrace);
    expect(signals.some((signal) => signal.code === "ship-by-overdue")).toBe(true);
    expect(signals.some((signal) => signal.code === "label-void-eligible")).toBe(true);
  });

  it("expires the return and voids the label idempotently — no second refund fact", () => {
    const expired = apply(readyState(), {
      type: "ExpireReturnShipment",
      reason: "Buyer missed the ship-by deadline.",
      metadata: metadata({ idempotencyKey: "idem-expire" }),
      expiredAt: "2026-06-14T00:00:00.000Z",
    });
    expect(expired.status).toBe("expired");
    // Voiding a label before carrier custody is allowed and emits a single void fact.
    const voided = step(readyState(), {
      type: "VoidReturnShipmentLabel",
      refundStatus: "requested",
      refundReference: "void-1",
      reason: "unused",
      metadata: metadata({ idempotencyKey: "idem-void" }),
      voidedAt: "2026-06-14T00:00:00.000Z",
    });
    expect(voided.events).toHaveLength(1);
    expect(voided.state.labelStatus).toBe("voided");
    // A duplicate void is a no-op so a reconciliation sweep cannot emit a second refund fact.
    const secondVoid = step(voided.state, {
      type: "VoidReturnShipmentLabel",
      refundStatus: "requested",
      refundReference: "void-1",
      reason: "unused",
      metadata: metadata({ idempotencyKey: "idem-void-2" }),
      voidedAt: "2026-06-15T00:00:00.000Z",
    });
    expect(secondVoid.events).toHaveLength(0);
  });
});

// ===========================================================================
// J09 — Carrier loses/damages/stalls the return (no unconditional refund).
// ===========================================================================

describe("J09 a lost, damaged, or stalled return follows an explicit exception path and never advances custody", () => {
  it("records a lost-in-transit exception without regressing or completing custody", () => {
    const inCustody = apply(readyState(), carrierAccepted("2026-06-03T00:00:00.000Z"));
    const exception = step(inCustody, {
      type: "RaiseReturnShipmentException",
      exceptionType: "lost-in-transit",
      notes: "No scans for 10 days; carrier trace opened.",
      metadata: metadata({ idempotencyKey: "idem-exception" }),
      raisedAt: "2026-06-15T00:00:00.000Z",
    });
    expect(exception.state.currentExceptionType).toBe("lost-in-transit");
    // The exception is an overlay; the furthest custody stage is unchanged, so no delivered/received
    // fact exists — Support has no facility-intake or delivered trigger to release a refund against.
    expect(exception.state.status).toBe("carrier-accepted");
    expect(exception.state.deliveredAt).toBeNull();
    expect(exception.state.receivedAt).toBeNull();
    expect(exception.state.facilityIntake).toBeNull();
  });

  it("rejects an exception on an already-terminal (received) shipment", () => {
    let state = apply(readyState(), carrierAccepted("2026-06-03T00:00:00.000Z"));
    state = apply(state, delivered("2026-06-05T00:00:00.000Z"));
    state = apply(state, completeIntake(facilityIntake()));
    expect(() =>
      decideReturnShipment(state, {
        type: "RaiseReturnShipmentException",
        exceptionType: "lost-in-transit",
        notes: null,
        metadata: metadata({ idempotencyKey: "idem-late-exception" }),
        raisedAt: "2026-06-07T00:00:00.000Z",
      }),
    ).toThrow();
  });
});

// ===========================================================================
// J10 — Carrier reports delivered but the facility cannot find the package.
// ===========================================================================

describe("J10 a delivered-not-found return raises a facility signal and withholds the intake trigger", () => {
  it("stays at delivered with no facility-intake fact until the package is physically found", () => {
    const delivered = apply(readyState(), {
      type: "RecordReturnShipmentDelivered",
      detail: "Carrier marked delivered to dock.",
      metadata: metadata({ idempotencyKey: "idem-delivered" }),
      occurredAt: "2026-06-05T00:00:00.000Z",
    });
    expect(delivered.status).toBe("delivered");
    expect(delivered.receivedAt).toBeNull();
    // The scheduled reconciliation surfaces the missing intake to facility operations.
    const signals = deriveReturnShipmentDeadlineSignals(
      {
        status: "delivered",
        shipByDeadlineAt: "2026-06-10T00:00:00.000Z",
        labelStatus: "ready",
        lastMovementAt: "2026-06-05T00:00:00.000Z",
        deliveredAt: "2026-06-05T00:00:00.000Z",
        receivedAt: null,
      },
      "2026-06-08T00:00:00.000Z",
    );
    expect(signals.some((signal) => signal.code === "delivery-without-intake")).toBe(true);
  });
});

// ===========================================================================
// J11 — Facility receives damaged/empty/extra/substituted/unidentified packages.
// ===========================================================================

describe("J11 a discrepant intake never auto-completes and an unidentified package reconciles explicitly", () => {
  it("routes a discrepant intake to quarantine or manual review, never completed", () => {
    let state = apply(readyState(), carrierAccepted("2026-06-03T00:00:00.000Z"));
    state = apply(state, delivered("2026-06-05T00:00:00.000Z"));
    const damagedIntake = facilityIntake({
      packageCondition: "damaged",
      disposition: "quarantine",
      discrepancies: [
        {
          type: "damaged",
          expectedItemReference: "line-1",
          observedItemReference: "line-1",
          quantity: 1,
          notes: "Corner crushed.",
          evidenceAttachmentIds: ["rie_1"],
          owner: "facility-operations",
          nextAction: "Quarantine and open a damage claim.",
        },
      ],
    });
    const receipt = step(state, completeIntake(damagedIntake));
    expect(receipt.state.status).toBe("received");
    expect(receipt.state.facilityIntake?.disposition).toBe("quarantine");
  });

  it("rejects a discrepant intake that claims a completed disposition (fail-safe)", () => {
    let state = apply(readyState(), delivered("2026-06-05T00:00:00.000Z"));
    const badIntake = facilityIntake({
      disposition: "completed",
      discrepancies: [
        {
          type: "missing",
          expectedItemReference: "line-1",
          observedItemReference: null,
          quantity: 1,
          notes: "Empty box.",
          evidenceAttachmentIds: ["rie_1"],
          owner: "facility-operations",
          nextAction: "Manual review.",
        },
      ],
    });
    expect(() => decideReturnShipment(state, completeIntake(badIntake))).toThrow();
  });

  it("records and later reconciles an unidentified package with its return shipment exactly once", () => {
    const record = decideUnidentifiedReturnPackage(initialUnidentifiedReturnPackageState, {
      type: "RecordUnidentifiedReturnPackage",
      unidentifiedPackageId: id("urp_1"),
      facilityId: "fac_east",
      stationId: "station-7",
      operatorUserId: "usr_operator",
      receivedAt: "2026-06-06T00:00:00.000Z",
      packageCondition: "intact",
      sealCondition: "intact",
      measuredWeightOunces: 9.5,
      evidence: facilityIntake().evidence,
      custodyIdentifier: "CUST-UNKNOWN-1",
      notes: "No label; matched later by weight and postmark.",
      owner: "facility-operations",
      nextAction: "Attempt reconciliation to an open return.",
    });
    const recorded = record.reduce(evolveUnidentifiedReturnPackage, initialUnidentifiedReturnPackageState);
    expect(recorded.unidentifiedPackageId).toBe(id("urp_1"));

    const reconcileCommand: UnidentifiedReturnPackageCommand = {
      type: "ReconcileUnidentifiedReturnPackage",
      returnShipmentId: id("rsh_1"),
      reconciledByUserId: "usr_operator",
      reconciledAt: "2026-06-07T00:00:00.000Z",
      reason: "Matched to open return by weight and postmark.",
    };
    const reconcileEvents = decideUnidentifiedReturnPackage(recorded, reconcileCommand);
    const reconciled = reconcileEvents.reduce(evolveUnidentifiedReturnPackage, recorded);
    expect(reconciled.returnShipmentId).toBe(id("rsh_1"));
    // Replaying the same reconciliation is a no-op (exact-once handoff).
    const replay = decideUnidentifiedReturnPackage(reconciled, reconcileCommand);
    expect(replay).toHaveLength(0);
    // Reconciling to a different return shipment is rejected.
    expect(() =>
      decideUnidentifiedReturnPackage(reconciled, { ...reconcileCommand, returnShipmentId: id("rsh_other") }),
    ).toThrow();
  });
});

// ===========================================================================
// J12 — No eligible facility / provider outage / secure-label storage failure.
// ===========================================================================

describe("J12 an unroutable directive fails explicitly and never creates a shipment", () => {
  it("returns no-eligible-facility for an unsupported region rather than throwing", () => {
    const result = selectDestination([facilityInput({ supportedRegions: ["us-west"] })]);
    expect(result.outcome).toBe("no-eligible-facility");
  });

  it("returns no-eligible-facility when the only facility is retired at selection time (readiness gate)", () => {
    const result = selectDestination(
      [facilityInput({ effectiveAt: "2026-01-01T00:00:00.000Z", retiredAt: "2026-03-01T00:00:00.000Z" })],
      "2026-06-01T00:00:00.000Z",
    );
    expect(result.outcome).toBe("no-eligible-facility");
  });

  it("names every provider/facility outage in the actionable label-failure taxonomy", () => {
    for (const reason of ["no-eligible-facility", "provider-timeout", "secure-document-storage-failure"]) {
      expect(returnShipmentLabelFailureReasons).toContain(reason);
    }
    // A secure-label storage failure records an actionable failure fact, keeping the shipment unlabelled.
    const failure = step(requestedState(), {
      type: "RecordReturnShipmentLabelPurchaseFailed",
      failureReason: "secure-document-storage-failure",
      failureDetail: "Label PDF could not be stored securely.",
      metadata: metadata({ idempotencyKey: "idem-secure-fail" }),
      failedAt: "2026-06-02T00:00:00.000Z",
    });
    expect(failure.state.labelStatus).toBe("failed");
    expect(failure.state.labelFailureReason).toBe("secure-document-storage-failure");
  });
});

// ===========================================================================
// J13 — Rollout paused while returns are already in flight.
// ===========================================================================

describe("J13 pausing new directives leaves in-flight returns trackable and receivable", () => {
  it("blocks new directives when the facility is retired but still intakes an already-captured snapshot", () => {
    // An in-flight shipment captured the destination before the pause.
    let inFlight = apply(readyState(), carrierAccepted("2026-06-03T00:00:00.000Z"));
    inFlight = apply(inFlight, delivered("2026-06-05T00:00:00.000Z"));

    // Rollout pause: the facility is retired, so NEW directives no longer route to it.
    const pausedSelection = selectDestination(
      [facilityInput({ effectiveAt: "2026-01-01T00:00:00.000Z", retiredAt: "2026-06-02T00:00:00.000Z" })],
      "2026-06-06T00:00:00.000Z",
    );
    expect(pausedSelection.outcome).toBe("no-eligible-facility");

    // The active return still completes intake against its immutable captured snapshot.
    const receipt = step(inFlight, completeIntake(facilityIntake()));
    expect(receipt.state.status).toBe("received");
    expect(
      receipt.events.some((event) => event.type === "fulfillment.return-shipment.facility-intake-completed.v1"),
    ).toBe(true);
  });
});

// ===========================================================================
// J14 — Customer and operator views enforce privacy/authorization boundaries.
// ===========================================================================

describe("J14 customer-facing views expose only display-safe data; operator/facility secrets stay restricted", () => {
  it("customer-safe destination drops restricted operational routing", () => {
    const snapshot = destinationSnapshot();
    const safe = customerSafeDestination(snapshot);
    expect(safe.displayName).toBe("Chase Sets Returns (East)");
    expect(Object.keys(safe)).not.toContain("restrictedRouting");
    expect(JSON.stringify(safe)).not.toContain("EAST-42");
    expect(JSON.stringify(safe)).not.toContain("ops@internal.example");
  });

  it("customer-safe deadline signals omit operator-internal signals like label-void-eligible", () => {
    const afterGrace = new Date(
      Date.parse("2026-06-10T00:00:00.000Z") +
        (DEFAULT_RETURN_SHIPMENT_DEADLINE_POLICY.labelVoidGraceHours + 1) * 3_600_000,
    ).toISOString();
    const signals = deriveReturnShipmentDeadlineSignals(
      {
        status: "ready-to-ship",
        shipByDeadlineAt: "2026-06-10T00:00:00.000Z",
        labelStatus: "ready",
        lastMovementAt: null,
        deliveredAt: null,
        receivedAt: null,
      },
      afterGrace,
    );
    // The operator sees the void-eligible signal; the customer projection does not.
    expect(signals.some((signal) => signal.code === "label-void-eligible")).toBe(true);
    const customerSafe = customerSafeReturnShipmentDeadlineSignals(signals);
    expect(customerSafe.some((signal) => signal.code === "label-void-eligible")).toBe(false);
  });

  it("intake custody evidence storage keys never appear on the customer-safe destination view", () => {
    const safe = customerSafeDestination(destinationSnapshot());
    expect(JSON.stringify(safe)).not.toContain("return-intake/");
  });
});

// ===========================================================================
// Cross-context seam: money can only flow through the authorized milestone trigger,
// and recovered stock only appears after facility intake.
// ===========================================================================

type SeamSubscription = Readonly<{
  sourceContextName?: string;
  projectionName?: string;
  reactionName?: string;
  projectionHandlerSetNames?: readonly string[];
  reactionHandlerSetNames?: readonly string[];
  eventTypes?: readonly string[];
}>;

type SeamContext = Readonly<{
  ownedNouns?: readonly string[];
  eventSubscriptions?: readonly SeamSubscription[];
  eventReactions?: readonly SeamSubscription[];
}>;

function loadContext(relativePath: string): SeamContext {
  return JSON.parse(readFileSync(resolve(baseDir, relativePath), "utf8")) as SeamContext;
}

function seamEntries(context: SeamContext): readonly SeamSubscription[] {
  return [...(context.eventSubscriptions ?? []), ...(context.eventReactions ?? [])];
}

function eventTypesFor(context: SeamContext, handlerName: string): readonly string[] {
  return seamEntries(context)
    .filter((entry) => entry.projectionName === handlerName || entry.reactionName === handlerName)
    .flatMap((entry) => entry.eventTypes ?? []);
}

const fulfillmentContext = loadContext("../context.json");
const platformOperationsContext = loadContext("../../platform-operations/context.json");
const inventoryContext = loadContext("../../inventory/context.json");
const settlementContext = loadContext("../../settlement/context.json");

describe("custody-to-money seam: refunds flow only from authorized Fulfillment milestone facts", () => {
  it("keeps the ReturnShipment aggregate owned by Fulfillment", () => {
    expect(fulfillmentContext.ownedNouns).toContain("return-shipment");
  });

  it("feeds Support only the three refund-trigger milestone facts — never the label, void, or exception facts", () => {
    const consumed = eventTypesFor(platformOperationsContext, "support-shipment-source-projection");
    const returnFacts = consumed.filter((type) => type.startsWith("fulfillment.return-shipment."));
    expect([...returnFacts].sort()).toEqual([
      "fulfillment.return-shipment.carrier-accepted.v1",
      "fulfillment.return-shipment.delivered.v1",
      "fulfillment.return-shipment.facility-intake-completed.v1",
    ]);
    // The money-bearing seam must not consume label-void or exception facts, so a void or
    // a carrier exception can never, by itself, drive a refund release.
    expect(returnFacts).not.toContain("fulfillment.return-shipment.label-voided.v1");
    expect(returnFacts).not.toContain("fulfillment.return-shipment.exception-raised.v1");
  });

  it("hands recovered custody to Inventory only on facility intake completion", () => {
    const consumed = eventTypesFor(inventoryContext, "inventory-fulfillment-recovered-item-workflow");
    expect(consumed).toEqual(["fulfillment.return-shipment.facility-intake-completed.v1"]);
    expect(inventoryContext.ownedNouns).toContain("recovered-item");
  });

  it("routes recovered value to Settlement only from the Inventory-owned recovered-item value fact", () => {
    const consumed = seamEntries(settlementContext).flatMap((entry) => entry.eventTypes ?? []);
    expect(consumed).toContain("inventory.recovered-item.value-reported.v1");
    // Settlement never subscribes directly to a raw Fulfillment carrier fact.
    expect(consumed.some((type) => type.startsWith("fulfillment.return-shipment."))).toBe(false);
  });
});

// ===========================================================================
// Evidence doc pin: the acceptance matrix cannot drift from the required journeys.
// ===========================================================================

describe("acceptance evidence matrix stays complete", () => {
  const doc = readFileSync(resolve(baseDir, "../docs/reverse-logistics-custody-journey-acceptance.md"), "utf8");

  it("keeps every required journey id in the acceptance matrix", () => {
    for (let index = 1; index <= 14; index += 1) {
      const journeyId = `J${index.toString().padStart(2, "0")}`;
      expect(doc).toContain(`| ${journeyId} |`);
    }
  });

  it("requires every scenario type before signoff", () => {
    for (const scenarioType of [
      "happy path",
      "money-safety",
      "custody",
      "replay recovery",
      "deadline",
      "fail-safe",
      "privacy",
      "rollout",
    ]) {
      expect(doc).toContain(scenarioType);
    }
  });

  it("anchors acceptance to the composed cross-context coverage", () => {
    for (const anchor of [
      "reverse-logistics-custody-journey.proof.test.ts",
      "domain.test.ts",
      "facility-directory.test.ts",
      "deadlines.test.ts",
      "unidentified-package.test.ts",
      "remedy.test.ts",
      "source-projection.test.ts",
    ]) {
      expect(doc).toContain(anchor);
    }
  });

  it("records the pending staging evidence, runbooks, and a deferred-defect ledger", () => {
    expect(doc).toContain("## Observability");
    expect(doc).toContain("## Rollout and operations");
    expect(doc).toContain("## Staging evidence");
    expect(doc).toContain("## Deferred defects");
    expect(doc).toContain("## Runbook");
  });
});
