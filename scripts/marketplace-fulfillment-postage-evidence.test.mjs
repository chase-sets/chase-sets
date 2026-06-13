import { describe, expect, it } from "vitest";
import {
  FULFILLMENT_POSTAGE_DELIVERY_EXCEPTION_EVIDENCE_KINDS,
  MARKETPLACE_FULFILLMENT_POSTAGE_EVIDENCE_VERSION,
  REQUIRED_FULFILLMENT_POSTAGE_EVENT_ID_GROUPS,
  REQUIRED_FULFILLMENT_POSTAGE_IDENTIFIERS,
  REQUIRED_FULFILLMENT_POSTAGE_PROOFS,
  REQUIRED_FULFILLMENT_POSTAGE_REFERENCES,
  buildFulfillmentPostageEvidence,
  parseFulfillmentPostageEvidenceArgs,
} from "./marketplace-fulfillment-postage-evidence.mjs";

function proof(overrides = {}) {
  return {
    proofReference: "FULFILLMENT-POSTAGE-PROOF-2026-05-30",
    proofCompletedAt: "2026-05-30T12:30:00.000Z",
    environment: "production",
    releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
    easyPostMode: "production",
    webhookDestination: "https://marketplace.chasesets.com/api/fulfillment/provider/postage/webhooks",
    providerEventRowCount: 4,
    matchedShipmentProviderEventRowCount: 4,
    trackingStatusProviderEventRowCount: 3,
    refundStatusProviderEventRowCount: 1,
    controlledParcelShipmentId: "ship_controlled_parcel_20260530",
    parcelProviderShipmentId: "shp_controlledParcel20260530",
    parcelProviderLabelId: "pl_controlledParcel20260530",
    trackingProviderObjectReference: "trk_controlledParcel20260530",
    trackingIdentifier: "9400111202555012345678",
    deliveryExceptionEvidenceKind: "provider-event",
    deliveryExceptionProviderEventId: "evt_deliveryException20260530",
    labelVoidRefundProviderObjectReference: "rfnd_labelVoid20260530",
    letterMailpieceShipmentId: "ship_letter_mailpiece_20260530",
    providerEventIds: [
      "evt_trackingPreTransit20260530",
      "evt_trackingInTransit20260530",
      "evt_trackingException20260530",
      "evt_refundStatus20260530",
    ],
    trackingStatusProviderEventIds: [
      "evt_trackingPreTransit20260530",
      "evt_trackingInTransit20260530",
      "evt_trackingException20260530",
    ],
    refundStatusProviderEventIds: ["evt_refundStatus20260530"],
    easyPostAccountReference: "EASYPOST-ACCOUNT-2026-05-30",
    webhookDestinationReference: "EASYPOST-WEBHOOK-DESTINATION-2026-05-30",
    providerEventQueryReference: "FULFILLMENT-POSTAGE-PROVIDER-EVENTS-2026-05-30",
    parcelLabelReference: "EASYPOST-LABEL-PURCHASE-2026-05-30",
    labelVoidRefundReference: "EASYPOST-LABEL-VOID-REFUND-2026-05-30",
    trackingEventReference: "EASYPOST-TRACKING-EVENT-2026-05-30",
    deliveryExceptionReference: "EASYPOST-DELIVERY-EXCEPTION-2026-05-30",
    letterMailpieceReference: "LETTER-MAILPIECE-HANDLING-2026-05-30",
    easyPostProductionModeProven: true,
    webhookDestinationConfigured: true,
    providerEventRowsProven: true,
    parcelLabelPurchaseProven: true,
    labelVoidRefundProven: true,
    trackingEventProven: true,
    deliveryExceptionProven: true,
    letterMailpieceHandlingProven: true,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    proof: proof(),
    reference: "FULFILLMENT-POSTAGE-2026-05-30",
    owner: "Fulfillment",
    checkedAt: "2026-05-30T13:00:00.000Z",
    ...overrides,
  };
}

describe("marketplace fulfillment postage evidence", () => {
  it("builds the approval gate from complete production EasyPost proof", () => {
    expect(buildFulfillmentPostageEvidence(input())).toEqual({
      schemaVersion: MARKETPLACE_FULFILLMENT_POSTAGE_EVIDENCE_VERSION,
      approved: true,
      reference: "FULFILLMENT-POSTAGE-2026-05-30",
      owner: "Fulfillment",
      checkedAt: "2026-05-30T13:00:00.000Z",
      proofReference: "FULFILLMENT-POSTAGE-PROOF-2026-05-30",
      proofCompletedAt: "2026-05-30T12:30:00.000Z",
      environment: "production",
      releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
      easyPostMode: "production",
      webhookDestination: "https://marketplace.chasesets.com/api/fulfillment/provider/postage/webhooks",
      providerEventRowCount: 4,
      matchedShipmentProviderEventRowCount: 4,
      trackingStatusProviderEventRowCount: 3,
      refundStatusProviderEventRowCount: 1,
      controlledParcelShipmentId: "ship_controlled_parcel_20260530",
      parcelProviderShipmentId: "shp_controlledParcel20260530",
      parcelProviderLabelId: "pl_controlledParcel20260530",
      trackingProviderObjectReference: "trk_controlledParcel20260530",
      trackingIdentifier: "9400111202555012345678",
      deliveryExceptionEvidenceKind: "provider-event",
      deliveryExceptionProviderEventId: "evt_deliveryException20260530",
      labelVoidRefundProviderObjectReference: "rfnd_labelVoid20260530",
      letterMailpieceShipmentId: "ship_letter_mailpiece_20260530",
      providerEventIds: [
        "evt_trackingPreTransit20260530",
        "evt_trackingInTransit20260530",
        "evt_trackingException20260530",
        "evt_refundStatus20260530",
      ],
      trackingStatusProviderEventIds: [
        "evt_trackingPreTransit20260530",
        "evt_trackingInTransit20260530",
        "evt_trackingException20260530",
      ],
      refundStatusProviderEventIds: ["evt_refundStatus20260530"],
      easyPostAccountReference: "EASYPOST-ACCOUNT-2026-05-30",
      webhookDestinationReference: "EASYPOST-WEBHOOK-DESTINATION-2026-05-30",
      providerEventQueryReference: "FULFILLMENT-POSTAGE-PROVIDER-EVENTS-2026-05-30",
      parcelLabelReference: "EASYPOST-LABEL-PURCHASE-2026-05-30",
      labelVoidRefundReference: "EASYPOST-LABEL-VOID-REFUND-2026-05-30",
      trackingEventReference: "EASYPOST-TRACKING-EVENT-2026-05-30",
      deliveryExceptionReference: "EASYPOST-DELIVERY-EXCEPTION-2026-05-30",
      letterMailpieceReference: "LETTER-MAILPIECE-HANDLING-2026-05-30",
      easyPostProductionModeProven: true,
      webhookDestinationConfigured: true,
      providerEventRowsProven: true,
      parcelLabelPurchaseProven: true,
      labelVoidRefundProven: true,
      trackingEventProven: true,
      deliveryExceptionProven: true,
      letterMailpieceHandlingProven: true,
      passesFulfillmentPostageGate: true,
    });
  });

  it("fails when any required postage proof is missing", () => {
    const evidence = buildFulfillmentPostageEvidence(
      input({
        proof: proof({
          labelVoidRefundProven: false,
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Fulfillment postage proof must prove labelVoidRefundProven=true.");
  });

  it("fails when proof is not production EasyPost mode", () => {
    const evidence = buildFulfillmentPostageEvidence(
      input({
        proof: proof({
          environment: "staging",
          easyPostMode: "test",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Fulfillment postage proof must run against production before marketplace launch.",
    );
    expect(evidence.errors).toContain("Fulfillment postage proof must use EasyPost production mode.");
  });

  it("fails when releaseCommit is not a 40-character Git commit SHA", () => {
    const evidence = buildFulfillmentPostageEvidence(
      input({
        proof: proof({
          releaseCommit: "fulfillment-postage-proof",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Fulfillment postage releaseCommit must be a 40-character Git commit SHA.");
  });

  it("fails when production EasyPost proof is stale or after checkedAt", () => {
    const staleEvidence = buildFulfillmentPostageEvidence(
      input({
        proof: proof({
          proofCompletedAt: "2026-04-15T12:30:00.000Z",
        }),
      }),
    );
    const futureEvidence = buildFulfillmentPostageEvidence(
      input({
        proof: proof({
          proofCompletedAt: "2026-05-30T13:05:00.000Z",
        }),
      }),
    );

    expect(staleEvidence.approved).toBe(false);
    expect(staleEvidence.errors).toContain("Fulfillment postage proofCompletedAt cannot be older than 30 days.");
    expect(futureEvidence.approved).toBe(false);
    expect(futureEvidence.errors).toContain("Fulfillment postage proofCompletedAt cannot be after checkedAt.");
  });

  it("fails when production EasyPost proof timestamps are date-only values", () => {
    const proofCompletedOnly = buildFulfillmentPostageEvidence(
      input({
        proof: proof({
          proofCompletedAt: "2026-05-30",
        }),
      }),
    );
    const checkedOnly = buildFulfillmentPostageEvidence(input({ checkedAt: "2026-05-30" }));

    expect(proofCompletedOnly.approved).toBe(false);
    expect(proofCompletedOnly.errors).toContain("Fulfillment postage proofCompletedAt must be an ISO timestamp.");
    expect(checkedOnly.approved).toBe(false);
    expect(checkedOnly.errors).toContain("Fulfillment postage evidence checkedAt must be an ISO timestamp.");
  });

  it("fails when webhook destination is not the production provider webhook path", () => {
    const evidence = buildFulfillmentPostageEvidence(
      input({
        proof: proof({
          webhookDestination: "https://staging.chasesets.com/api/fulfillment/provider/postage/webhooks",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Fulfillment postage proof must use the Fulfillment postage provider webhook path on a production Chase Sets host.",
    );
  });

  it("fails when webhook destination is not absolute HTTPS", () => {
    const evidence = buildFulfillmentPostageEvidence(
      input({
        proof: proof({
          webhookDestination: "http://marketplace.chasesets.com/api/fulfillment/provider/postage/webhooks",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Fulfillment postage proof must use an HTTPS webhook destination.");
  });

  it("fails when webhook destination uses an arbitrary host", () => {
    const evidence = buildFulfillmentPostageEvidence(
      input({
        proof: proof({
          webhookDestination: "https://example.com/api/fulfillment/provider/postage/webhooks",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Fulfillment postage proof must use the Fulfillment postage provider webhook path on a production Chase Sets host.",
    );
  });

  it("fails when provider event rows are claimed without rows", () => {
    const evidence = buildFulfillmentPostageEvidence(
      input({
        proof: proof({
          providerEventRowCount: 0,
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Fulfillment postage proof must include at least four provider event rows.");
  });

  it("fails when provider event rows are not matched to shipments or required EasyPost event kinds", () => {
    const evidence = buildFulfillmentPostageEvidence(
      input({
        proof: proof({
          matchedShipmentProviderEventRowCount: 3,
          trackingStatusProviderEventRowCount: 2,
          refundStatusProviderEventRowCount: 0,
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Fulfillment postage proof must include at least four provider event rows matched to shipments.",
    );
    expect(evidence.errors).toContain(
      "Fulfillment postage proof must include at least three tracking-status provider event rows.",
    );
    expect(evidence.errors).toContain(
      "Fulfillment postage proof must include at least one refund-status provider event row.",
    );
  });

  it("fails when EasyPost object identifiers are placeholders or wrong object types", () => {
    const evidence = buildFulfillmentPostageEvidence(
      input({
        proof: proof({
          parcelProviderShipmentId: "sample",
          parcelProviderLabelId: "shp_wrongType20260530",
          trackingProviderObjectReference: "evt_wrongType20260530",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Fulfillment postage parcelProviderShipmentId must be a concrete EasyPost identifier starting with shp_.",
    );
    expect(evidence.errors).toContain(
      "Fulfillment postage parcelProviderLabelId must be a concrete EasyPost identifier starting with pl_.",
    );
    expect(evidence.errors).toContain(
      "Fulfillment postage trackingProviderObjectReference must be a concrete EasyPost identifier starting with trk_.",
    );
  });

  it("fails when EasyPost provider event ids are missing, placeholders, or duplicated", () => {
    const evidence = buildFulfillmentPostageEvidence(
      input({
        proof: proof({
          providerEventIds: ["evt_trackingPreTransit20260530", "evt_trackingPreTransit20260530", "evt_sample"],
          trackingStatusProviderEventIds: ["evt_trackingPreTransit20260530", "event_trackingWrongPrefix20260530"],
          refundStatusProviderEventIds: [],
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Fulfillment postage providerEventIds must include at least 4 concrete EasyPost event IDs.",
    );
    expect(evidence.errors).toContain(
      "Fulfillment postage providerEventIds must not contain duplicate EasyPost event IDs.",
    );
    expect(evidence.errors).toContain(
      "Fulfillment postage providerEventIds entries must be concrete EasyPost event IDs starting with evt_.",
    );
    expect(evidence.errors).toContain(
      "Fulfillment postage trackingStatusProviderEventIds must include at least 3 concrete EasyPost event IDs.",
    );
    expect(evidence.errors).toContain(
      "Fulfillment postage trackingStatusProviderEventIds entries must be concrete EasyPost event IDs starting with evt_.",
    );
    expect(evidence.errors).toContain(
      "Fulfillment postage refundStatusProviderEventIds must include at least 1 concrete EasyPost event IDs.",
    );
  });

  it("accepts Fulfillment rehearsal evidence for the delivery exception path", () => {
    const evidence = buildFulfillmentPostageEvidence(
      input({
        proof: proof({
          deliveryExceptionEvidenceKind: "fulfillment-rehearsal",
          deliveryExceptionProviderEventId: undefined,
          deliveryExceptionRehearsalShipmentId: "shp_rehearsedException20260530",
          deliveryExceptionReference: "FULFILLMENT-DELIVERY-EXCEPTION-REHEARSAL-2026-05-30",
        }),
      }),
    );

    expect(evidence).toMatchObject({
      approved: true,
      passesFulfillmentPostageGate: true,
      deliveryExceptionEvidenceKind: "fulfillment-rehearsal",
      deliveryExceptionRehearsalShipmentId: "shp_rehearsedException20260530",
      deliveryExceptionReference: "FULFILLMENT-DELIVERY-EXCEPTION-REHEARSAL-2026-05-30",
    });
    expect(evidence).not.toHaveProperty("deliveryExceptionProviderEventId");
  });

  it("fails when Fulfillment rehearsal delivery exception proof lacks a concrete shipment id", () => {
    const evidence = buildFulfillmentPostageEvidence(
      input({
        proof: proof({
          deliveryExceptionEvidenceKind: "fulfillment-rehearsal",
          deliveryExceptionProviderEventId: undefined,
          deliveryExceptionRehearsalShipmentId: "placeholder",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Fulfillment postage deliveryExceptionRehearsalShipmentId must be a concrete identifier, not a placeholder.",
    );
  });

  it("fails when concrete postage references are missing", () => {
    expect(() =>
      buildFulfillmentPostageEvidence(
        input({
          proof: proof({
            parcelLabelReference: "",
          }),
        }),
      ),
    ).toThrow("Fulfillment postage parcelLabelReference must be a non-empty string.");
  });

  it("fails when concrete postage references are placeholders", () => {
    const evidence = buildFulfillmentPostageEvidence(
      input({
        proof: proof({
          parcelLabelReference: "record",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Fulfillment postage parcelLabelReference must point to a real external evidence record, not a placeholder.",
    );
  });

  it("keeps the required proof list aligned with the launch evidence verifier", () => {
    expect(REQUIRED_FULFILLMENT_POSTAGE_PROOFS).toEqual([
      "easyPostProductionModeProven",
      "webhookDestinationConfigured",
      "providerEventRowsProven",
      "parcelLabelPurchaseProven",
      "labelVoidRefundProven",
      "trackingEventProven",
      "deliveryExceptionProven",
      "letterMailpieceHandlingProven",
    ]);
    expect(REQUIRED_FULFILLMENT_POSTAGE_REFERENCES).toEqual([
      "easyPostAccountReference",
      "webhookDestinationReference",
      "providerEventQueryReference",
      "parcelLabelReference",
      "labelVoidRefundReference",
      "trackingEventReference",
      "deliveryExceptionReference",
      "letterMailpieceReference",
    ]);
    expect(REQUIRED_FULFILLMENT_POSTAGE_IDENTIFIERS).toEqual([
      "controlledParcelShipmentId",
      "parcelProviderShipmentId",
      "parcelProviderLabelId",
      "trackingProviderObjectReference",
      "trackingIdentifier",
      "labelVoidRefundProviderObjectReference",
      "letterMailpieceShipmentId",
    ]);
    expect(FULFILLMENT_POSTAGE_DELIVERY_EXCEPTION_EVIDENCE_KINDS).toEqual(["provider-event", "fulfillment-rehearsal"]);
    expect(REQUIRED_FULFILLMENT_POSTAGE_EVENT_ID_GROUPS).toEqual([
      { key: "providerEventIds", minimumCount: 4 },
      { key: "trackingStatusProviderEventIds", minimumCount: 3 },
      { key: "refundStatusProviderEventIds", minimumCount: 1 },
    ]);
  });

  it("parses operator arguments from flags and environment", () => {
    expect(
      parseFulfillmentPostageEvidenceArgs(
        [
          "--proof",
          "secure/fulfillment-postage.json",
          "--reference",
          "FULFILLMENT-POSTAGE-2026-05-30",
          "--owner",
          "Fulfillment Ops",
          "--checked-at",
          "2026-05-30T13:00:00.000Z",
        ],
        {},
      ),
    ).toMatchObject({
      proofPath: "secure/fulfillment-postage.json",
      reference: "FULFILLMENT-POSTAGE-2026-05-30",
      owner: "Fulfillment Ops",
      checkedAt: "2026-05-30T13:00:00.000Z",
    });

    expect(
      parseFulfillmentPostageEvidenceArgs([], {
        FULFILLMENT_POSTAGE_PROOF_RECORD: "secure/fulfillment-postage.json",
        PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE: "FULFILLMENT-POSTAGE-2026-05-30",
      }),
    ).toMatchObject({
      proofPath: "secure/fulfillment-postage.json",
      reference: "FULFILLMENT-POSTAGE-2026-05-30",
      owner: "Fulfillment",
    });
  });
});
