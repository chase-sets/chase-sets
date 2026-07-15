import { describe, expect, it } from "vitest";
import {
  decideReturnShipment,
  evolveReturnShipment,
  initialReturnShipmentState,
  type ReturnShipmentCommand,
  type ReturnShipmentEvent,
  type ReturnShipmentFactMetadata,
  type ReturnShipmentState,
  type RequestReturnShipmentCommand,
} from "./domain";
import { createReturnFacilityDirectory, selectReturnFacility } from "./facility-directory";

const remedyId = "rmd_1" as never;

function metadata(overrides: Partial<ReturnShipmentFactMetadata> = {}): ReturnShipmentFactMetadata {
  return {
    correlationRemedyId: remedyId,
    causationId: null,
    idempotencyKey: "idem-request-1",
    policyVersion: "return-policy-v1",
    ...overrides,
  };
}

function destinationSnapshot() {
  const directory = createReturnFacilityDirectory([
    {
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
      restrictedRouting: { operationalContact: "ops@internal", internalRoutingCode: "EAST-42" },
      displayName: "Chase Sets Returns (East)",
      displayInstructions: "Include the packing slip.",
    },
  ]);
  const result = selectReturnFacility(
    directory,
    {
      returnProgram: "platform-custody",
      carrier: "usps",
      region: "us-east",
      packageWeightOunces: 10,
      packageLengthInches: 9,
      packageWidthInches: 6,
      packageHeightInches: 2,
    },
    { asOf: "2026-06-01T00:00:00.000Z", selectionPolicyVersion: "facility-selection-v1" },
  );
  if (result.outcome !== "selected") {
    throw new Error("expected facility selection");
  }
  return result.snapshot;
}

function requestCommand(overrides: Partial<RequestReturnShipmentCommand> = {}): RequestReturnShipmentCommand {
  return {
    type: "RequestReturnShipment",
    returnShipmentId: "rsh_1" as never,
    remedyId,
    supportRequestId: "sup_1" as never,
    orderId: "ord_1" as never,
    outboundShipmentId: "shp_1" as never,
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

function fold(
  events: readonly ReturnShipmentEvent[],
  from: ReturnShipmentState = initialReturnShipmentState,
): ReturnShipmentState {
  return events.reduce(evolveReturnShipment, from);
}

function apply(state: ReturnShipmentState, command: ReturnShipmentCommand): ReturnShipmentState {
  return fold(decideReturnShipment(state, command), state);
}

function requestedState(): ReturnShipmentState {
  return apply(initialReturnShipmentState, requestCommand());
}

const milestoneMeta = metadata({ idempotencyKey: "idem-milestone" });

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

function readyState(): ReturnShipmentState {
  return apply(requestedState(), {
    type: "MarkReturnShipmentLabelReady",
    carrierName: "USPS",
    trackingIdentifier: "9400-1",
    labelProviderReference: "lbl_1",
    ...labelReadyProviderFields,
    metadata: milestoneMeta,
    readyAt: "2026-06-02T00:00:00.000Z",
  });
}

describe("ReturnShipment aggregate", () => {
  it("requests a reverse shipment and snapshots the destination", () => {
    const state = requestedState();
    expect(state.status).toBe("requested");
    expect(state.returnDirective).toBe("return-to-platform");
    expect(state.destinationSnapshot?.facilityId).toBe("fac_east");
    expect(state.labelStatus).toBe("pending");
    expect(state.milestones).toHaveLength(1);
  });

  it("rejects a directive that is not return-to-platform", () => {
    expect(() =>
      decideReturnShipment(initialReturnShipmentState, requestCommand({ returnDirective: "return-to-seller" })),
    ).toThrow();
    expect(() =>
      decideReturnShipment(initialReturnShipmentState, requestCommand({ returnDirective: "no-return" })),
    ).toThrow();
  });

  it("is idempotent when the same remedy re-requests creation", () => {
    const state = requestedState();
    expect(decideReturnShipment(state, requestCommand())).toEqual([]);
  });

  it("rejects reusing a stream for a different remedy (conflicting reuse)", () => {
    const state = requestedState();
    expect(() =>
      decideReturnShipment(
        state,
        requestCommand({
          remedyId: "rmd_other" as never,
          metadata: metadata({ correlationRemedyId: "rmd_other" as never }),
        }),
      ),
    ).toThrow();
  });

  it("rejects a return-by deadline that precedes the ship-by deadline", () => {
    expect(() =>
      decideReturnShipment(
        initialReturnShipmentState,
        requestCommand({ returnByDeadlineAt: "2026-06-05T00:00:00.000Z" }),
      ),
    ).toThrow();
  });

  it("advances through the full happy path with delivered and received as separate facts", () => {
    let state = requestedState();
    state = apply(state, {
      type: "MarkReturnShipmentLabelReady",
      carrierName: "USPS",
      trackingIdentifier: "9400-1",
      labelProviderReference: "lbl_1",
      ...labelReadyProviderFields,
      metadata: milestoneMeta,
      readyAt: "2026-06-02T00:00:00.000Z",
    });
    expect(state.status).toBe("ready-to-ship");
    expect(state.labelStatus).toBe("ready");
    state = apply(state, {
      type: "RecordReturnShipmentCarrierAccepted",
      metadata: milestoneMeta,
      occurredAt: "2026-06-03T00:00:00.000Z",
    });
    expect(state.status).toBe("carrier-accepted");
    state = apply(state, {
      type: "RecordReturnShipmentInTransit",
      metadata: milestoneMeta,
      occurredAt: "2026-06-04T00:00:00.000Z",
    });
    expect(state.status).toBe("in-transit");
    state = apply(state, {
      type: "RecordReturnShipmentDelivered",
      metadata: milestoneMeta,
      occurredAt: "2026-06-05T00:00:00.000Z",
    });
    expect(state.status).toBe("delivered");
    expect(state.deliveredAt).toBe("2026-06-05T00:00:00.000Z");
    expect(state.receivedAt).toBeNull();
    state = apply(state, {
      type: "RecordReturnShipmentReceived",
      metadata: milestoneMeta,
      receivedAt: "2026-06-06T00:00:00.000Z",
    });
    expect(state.status).toBe("received");
    expect(state.deliveredAt).toBe("2026-06-05T00:00:00.000Z");
    expect(state.receivedAt).toBe("2026-06-06T00:00:00.000Z");
  });

  it("converges duplicate and out-of-order carrier scans without regressing custody", () => {
    let state = requestedState();
    state = apply(state, {
      type: "MarkReturnShipmentLabelReady",
      carrierName: "USPS",
      trackingIdentifier: "t",
      labelProviderReference: "l",
      ...labelReadyProviderFields,
      metadata: milestoneMeta,
      readyAt: "2026-06-02T00:00:00.000Z",
    });
    state = apply(state, {
      type: "RecordReturnShipmentInTransit",
      metadata: milestoneMeta,
      occurredAt: "2026-06-04T00:00:00.000Z",
    });
    // A late "carrier-accepted" scan arrives after "in-transit": no regression, no event.
    expect(
      decideReturnShipment(state, {
        type: "RecordReturnShipmentCarrierAccepted",
        metadata: milestoneMeta,
        occurredAt: "2026-06-03T00:00:00.000Z",
      }),
    ).toEqual([]);
    // A duplicate "in-transit" scan is a no-op.
    expect(
      decideReturnShipment(state, {
        type: "RecordReturnShipmentInTransit",
        metadata: milestoneMeta,
        occurredAt: "2026-06-04T00:00:00.000Z",
      }),
    ).toEqual([]);
    expect(state.status).toBe("in-transit");
  });

  it("allows an exception overlay without regressing status and clears it on receipt", () => {
    let state = requestedState();
    state = apply(state, {
      type: "MarkReturnShipmentLabelReady",
      carrierName: "USPS",
      trackingIdentifier: "t",
      labelProviderReference: "l",
      ...labelReadyProviderFields,
      metadata: milestoneMeta,
      readyAt: "2026-06-02T00:00:00.000Z",
    });
    state = apply(state, {
      type: "RecordReturnShipmentInTransit",
      metadata: milestoneMeta,
      occurredAt: "2026-06-04T00:00:00.000Z",
    });
    state = apply(state, {
      type: "RaiseReturnShipmentException",
      exceptionType: "carrier-delay",
      notes: "stuck in hub",
      metadata: milestoneMeta,
      raisedAt: "2026-06-05T00:00:00.000Z",
    });
    expect(state.status).toBe("in-transit");
    expect(state.currentExceptionType).toBe("carrier-delay");
    expect(state.exceptions).toHaveLength(1);
    state = apply(state, {
      type: "RecordReturnShipmentDelivered",
      metadata: milestoneMeta,
      occurredAt: "2026-06-06T00:00:00.000Z",
    });
    state = apply(state, {
      type: "RecordReturnShipmentReceived",
      metadata: milestoneMeta,
      receivedAt: "2026-06-07T00:00:00.000Z",
    });
    expect(state.currentExceptionType).toBeNull();
  });

  it("cancels only before carrier custody and is idempotent", () => {
    let state = requestedState();
    state = apply(state, {
      type: "CancelReturnShipment",
      reason: "buyer changed mind",
      metadata: milestoneMeta,
      cancelledAt: "2026-06-02T00:00:00.000Z",
    });
    expect(state.status).toBe("cancelled");
    expect(
      decideReturnShipment(state, {
        type: "CancelReturnShipment",
        reason: null,
        metadata: milestoneMeta,
        cancelledAt: "2026-06-03T00:00:00.000Z",
      }),
    ).toEqual([]);
  });

  it("rejects cancelling once the parcel is in carrier custody", () => {
    let state = requestedState();
    state = apply(state, {
      type: "MarkReturnShipmentLabelReady",
      carrierName: "USPS",
      trackingIdentifier: "t",
      labelProviderReference: "l",
      ...labelReadyProviderFields,
      metadata: milestoneMeta,
      readyAt: "2026-06-02T00:00:00.000Z",
    });
    state = apply(state, {
      type: "RecordReturnShipmentCarrierAccepted",
      metadata: milestoneMeta,
      occurredAt: "2026-06-03T00:00:00.000Z",
    });
    expect(() =>
      decideReturnShipment(state, {
        type: "CancelReturnShipment",
        reason: null,
        metadata: milestoneMeta,
        cancelledAt: "2026-06-04T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("expires only before carrier custody", () => {
    let state = requestedState();
    state = apply(state, {
      type: "ExpireReturnShipment",
      reason: "ship-by passed",
      metadata: milestoneMeta,
      expiredAt: "2026-06-11T00:00:00.000Z",
    });
    expect(state.status).toBe("expired");
    expect(() =>
      decideReturnShipment(state, {
        type: "RecordReturnShipmentCarrierAccepted",
        metadata: milestoneMeta,
        occurredAt: "2026-06-12T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects milestones and exceptions after a terminal state", () => {
    let state = requestedState();
    state = apply(state, {
      type: "CancelReturnShipment",
      reason: null,
      metadata: milestoneMeta,
      cancelledAt: "2026-06-02T00:00:00.000Z",
    });
    expect(() =>
      decideReturnShipment(state, {
        type: "RaiseReturnShipmentException",
        exceptionType: "other",
        notes: null,
        metadata: milestoneMeta,
        raisedAt: "2026-06-03T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects a milestone before creation", () => {
    expect(() =>
      decideReturnShipment(initialReturnShipmentState, {
        type: "RecordReturnShipmentDelivered",
        metadata: milestoneMeta,
        occurredAt: "2026-06-05T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("records customer-safe label document, provider handles, and postage cost on label-ready", () => {
    const state = readyState();
    expect(state.labelDocumentUrl).toBe("https://labels.test/rsh_1.pdf");
    expect(state.postageProviderShipmentId).toBe("ps_1");
    expect(state.postageProviderLabelId).toBe("pl_1");
    expect(state.postageAmountCents).toBe(499);
    expect(state.estimatedPostageAmountCents).toBe(450);
    expect(state.postageCurrency).toBe("USD");
  });

  it("requires a customer-safe label document url on label-ready", () => {
    expect(() =>
      decideReturnShipment(requestedState(), {
        type: "MarkReturnShipmentLabelReady",
        carrierName: "USPS",
        trackingIdentifier: "9400-1",
        labelProviderReference: "lbl_1",
        ...labelReadyProviderFields,
        labelDocumentUrl: "   ",
        metadata: milestoneMeta,
        readyAt: "2026-06-02T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("records a machine-readable label-purchase failure while still awaiting a label", () => {
    const state = apply(requestedState(), {
      type: "RecordReturnShipmentLabelPurchaseFailed",
      failureReason: "provider-timeout",
      failureDetail: "USPS rating timed out.",
      postageProviderName: "sandbox-usps",
      postageProviderMode: "test",
      metadata: milestoneMeta,
      failedAt: "2026-06-02T00:00:00.000Z",
    });
    expect(state.status).toBe("requested");
    expect(state.labelStatus).toBe("failed");
    expect(state.labelFailureReason).toBe("provider-timeout");
    expect(state.labelFailureDetail).toBe("USPS rating timed out.");
  });

  it("rejects an unknown label failure reason", () => {
    expect(() =>
      decideReturnShipment(requestedState(), {
        type: "RecordReturnShipmentLabelPurchaseFailed",
        failureReason: "gremlins",
        failureDetail: null,
        metadata: milestoneMeta,
        failedAt: "2026-06-02T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("cannot record a purchase failure once the label is ready", () => {
    expect(() =>
      decideReturnShipment(readyState(), {
        type: "RecordReturnShipmentLabelPurchaseFailed",
        failureReason: "provider-error",
        failureDetail: null,
        metadata: milestoneMeta,
        failedAt: "2026-06-03T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("retries a label after a failure and reaches ready", () => {
    let state = apply(requestedState(), {
      type: "RecordReturnShipmentLabelPurchaseFailed",
      failureReason: "provider-timeout",
      failureDetail: null,
      metadata: milestoneMeta,
      failedAt: "2026-06-02T00:00:00.000Z",
    });
    expect(state.labelStatus).toBe("failed");
    state = apply(state, {
      type: "MarkReturnShipmentLabelReady",
      carrierName: "USPS",
      trackingIdentifier: "9400-1",
      labelProviderReference: "lbl_retry",
      ...labelReadyProviderFields,
      metadata: milestoneMeta,
      readyAt: "2026-06-02T06:00:00.000Z",
    });
    expect(state.status).toBe("ready-to-ship");
    expect(state.labelStatus).toBe("ready");
    expect(state.labelFailureReason).toBeNull();
  });

  it("voids an unused ready label idempotently and records the refund", () => {
    const state = apply(readyState(), {
      type: "VoidReturnShipmentLabel",
      refundStatus: "submitted",
      refundReference: "ref_1",
      reason: "case cancelled",
      metadata: milestoneMeta,
      voidedAt: "2026-06-02T12:00:00.000Z",
    });
    expect(state.labelStatus).toBe("voided");
    expect(state.labelRefundStatus).toBe("submitted");
    expect(state.labelRefundReference).toBe("ref_1");
    // Re-voiding is a no-op so a provider retry cannot emit a second refund fact.
    expect(
      decideReturnShipment(state, {
        type: "VoidReturnShipmentLabel",
        refundStatus: "submitted",
        refundReference: "ref_1",
        metadata: milestoneMeta,
        voidedAt: "2026-06-02T13:00:00.000Z",
      }),
    ).toEqual([]);
  });

  it("cannot void a label already in carrier custody", () => {
    const inCustody = apply(readyState(), {
      type: "RecordReturnShipmentCarrierAccepted",
      metadata: milestoneMeta,
      occurredAt: "2026-06-03T00:00:00.000Z",
    });
    expect(() =>
      decideReturnShipment(inCustody, {
        type: "VoidReturnShipmentLabel",
        refundStatus: "submitted",
        metadata: milestoneMeta,
        voidedAt: "2026-06-04T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("cannot void when no label has been purchased", () => {
    expect(() =>
      decideReturnShipment(requestedState(), {
        type: "VoidReturnShipmentLabel",
        refundStatus: "submitted",
        metadata: milestoneMeta,
        voidedAt: "2026-06-02T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("is replay-stable: folding the full event log reproduces the same state", () => {
    const commands: ReturnShipmentCommand[] = [
      requestCommand(),
      {
        type: "MarkReturnShipmentLabelReady",
        carrierName: "USPS",
        trackingIdentifier: "t",
        labelProviderReference: "l",
        ...labelReadyProviderFields,
        metadata: milestoneMeta,
        readyAt: "2026-06-02T00:00:00.000Z",
      },
      { type: "RecordReturnShipmentCarrierAccepted", metadata: milestoneMeta, occurredAt: "2026-06-03T00:00:00.000Z" },
      { type: "RecordReturnShipmentInTransit", metadata: milestoneMeta, occurredAt: "2026-06-04T00:00:00.000Z" },
      { type: "RecordReturnShipmentDelivered", metadata: milestoneMeta, occurredAt: "2026-06-05T00:00:00.000Z" },
      { type: "RecordReturnShipmentReceived", metadata: milestoneMeta, receivedAt: "2026-06-06T00:00:00.000Z" },
    ];
    const events: ReturnShipmentEvent[] = [];
    let live = initialReturnShipmentState;
    for (const command of commands) {
      const produced = decideReturnShipment(live, command);
      events.push(...produced);
      live = fold(produced, live);
    }
    const replayed = fold(events);
    expect(replayed).toEqual(live);
    expect(replayed.milestones.map((milestone) => milestone.status)).toEqual([
      "requested",
      "ready-to-ship",
      "carrier-accepted",
      "in-transit",
      "delivered",
      "received",
    ]);
  });
});
