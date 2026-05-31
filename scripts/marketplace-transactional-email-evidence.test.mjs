import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_TRANSACTIONAL_EMAIL_EVIDENCE_VERSION,
  REQUIRED_TRANSACTIONAL_EMAIL_IDENTIFIERS,
  REQUIRED_TRANSACTIONAL_EMAIL_PROOFS,
  REQUIRED_TRANSACTIONAL_EMAIL_REFERENCES,
  REQUIRED_TRANSACTIONAL_EMAIL_TEMPLATE_AREAS,
  buildTransactionalEmailEvidence,
  parseTransactionalEmailEvidenceArgs,
} from "./marketplace-transactional-email-evidence.mjs";

function proof(overrides = {}) {
  return {
    proofReference: "NOTIFICATIONS-SES-PROOF-2026-05-30",
    proofCompletedAt: "2026-05-30T12:30:00.000Z",
    environment: "production",
    releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
    sesConfigurationSetName: "transactional-production",
    webhookDestination: "https://marketplace.chasesets.com/api/notifications/provider/email/webhooks",
    providerEventRowCount: 3,
    controlledSendProviderMessageId: "ses_msg_controlled_20260530",
    outboxRowId: "42",
    deliveryProviderEventId: "amazon-ses:ses_msg_controlled_20260530:delivery:2026-05-30T12:31:00.000Z",
    bounceProviderEventId: "amazon-ses:ses_msg_bounce_20260530:bounce:2026-05-30T12:32:00.000Z",
    complaintProviderEventId: "amazon-ses:ses_msg_complaint_20260530:complaint:2026-05-30T12:33:00.000Z",
    sesIdentityReference: "SES-IDENTITY-CHASESETS-COM-2026-05-30",
    controlledSendMessageReference: "SES-MESSAGE-CONTROLLED-SEND-2026-05-30",
    outboxDispatchReference: "NOTIFICATION-OUTBOX-DISPATCH-2026-05-30",
    deliveryEventReference: "SES-DELIVERY-EVENT-2026-05-30",
    bounceEventReference: "SES-BOUNCE-EVENT-2026-05-30",
    complaintEventReference: "SES-COMPLAINT-EVENT-2026-05-30",
    deliveryMonitoringReference: "SES-MONITORING-2026-05-30",
    snsSubscriptionConfirmationReference: "SNS-SUBSCRIPTION-CONFIRMATION-2026-05-30",
    templateReviewReference: "TRANSACTIONAL-TEMPLATE-REVIEW-2026-05-30",
    sesDnsVerified: true,
    controlledSendProven: true,
    outboxDispatchProven: true,
    bounceComplaintParsingProven: true,
    deliveryMonitoringProven: true,
    webhookDestinationConfigured: true,
    snsSubscriptionConfirmed: true,
    criticalTemplateAreasCovered: ["auth", "orders", "payments", "fulfillment", "refunds", "support", "payouts"],
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    proof: proof(),
    reference: "NOTIFICATIONS-SES-2026-05-30",
    owner: "Notifications",
    checkedAt: "2026-05-30T13:00:00.000Z",
    ...overrides,
  };
}

describe("marketplace transactional email evidence", () => {
  it("builds the launch packet gate from complete production SES proof", () => {
    expect(buildTransactionalEmailEvidence(input())).toEqual({
      schemaVersion: MARKETPLACE_TRANSACTIONAL_EMAIL_EVIDENCE_VERSION,
      approved: true,
      reference: "NOTIFICATIONS-SES-2026-05-30",
      owner: "Notifications",
      checkedAt: "2026-05-30T13:00:00.000Z",
      proofReference: "NOTIFICATIONS-SES-PROOF-2026-05-30",
      proofCompletedAt: "2026-05-30T12:30:00.000Z",
      environment: "production",
      releaseCommit: "f318fd3577b635959dabc23117f509ed45621268",
      sesConfigurationSetName: "transactional-production",
      webhookDestination: "https://marketplace.chasesets.com/api/notifications/provider/email/webhooks",
      providerEventRowCount: 3,
      controlledSendProviderMessageId: "ses_msg_controlled_20260530",
      outboxRowId: "42",
      deliveryProviderEventId: "amazon-ses:ses_msg_controlled_20260530:delivery:2026-05-30T12:31:00.000Z",
      bounceProviderEventId: "amazon-ses:ses_msg_bounce_20260530:bounce:2026-05-30T12:32:00.000Z",
      complaintProviderEventId: "amazon-ses:ses_msg_complaint_20260530:complaint:2026-05-30T12:33:00.000Z",
      sesIdentityReference: "SES-IDENTITY-CHASESETS-COM-2026-05-30",
      controlledSendMessageReference: "SES-MESSAGE-CONTROLLED-SEND-2026-05-30",
      outboxDispatchReference: "NOTIFICATION-OUTBOX-DISPATCH-2026-05-30",
      deliveryEventReference: "SES-DELIVERY-EVENT-2026-05-30",
      bounceEventReference: "SES-BOUNCE-EVENT-2026-05-30",
      complaintEventReference: "SES-COMPLAINT-EVENT-2026-05-30",
      deliveryMonitoringReference: "SES-MONITORING-2026-05-30",
      snsSubscriptionConfirmationReference: "SNS-SUBSCRIPTION-CONFIRMATION-2026-05-30",
      templateReviewReference: "TRANSACTIONAL-TEMPLATE-REVIEW-2026-05-30",
      criticalTemplateAreasCovered: ["auth", "orders", "payments", "fulfillment", "refunds", "support", "payouts"],
      sesDnsVerified: true,
      controlledSendProven: true,
      outboxDispatchProven: true,
      bounceComplaintParsingProven: true,
      deliveryMonitoringProven: true,
      webhookDestinationConfigured: true,
      snsSubscriptionConfirmed: true,
      passesTransactionalEmailGate: true,
    });
  });

  it("fails when any required production SES proof is missing", () => {
    const evidence = buildTransactionalEmailEvidence(
      input({
        proof: proof({
          bounceComplaintParsingProven: false,
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Transactional email proof must prove bounceComplaintParsingProven=true.");
  });

  it("fails when proof is not production or uses the wrong configuration set", () => {
    const evidence = buildTransactionalEmailEvidence(
      input({
        proof: proof({
          environment: "staging",
          sesConfigurationSetName: "transactional-staging",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Transactional email proof must run against production before marketplace launch.",
    );
    expect(evidence.errors).toContain(
      "Transactional email proof must use the transactional-production SES configuration set.",
    );
  });

  it("fails when releaseCommit is not a 40-character Git commit SHA", () => {
    const evidence = buildTransactionalEmailEvidence(
      input({
        proof: proof({
          releaseCommit: "transactional-email-proof",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Transactional email releaseCommit must be a 40-character Git commit SHA.");
  });

  it("fails when production SES proof is stale or after checkedAt", () => {
    const staleEvidence = buildTransactionalEmailEvidence(
      input({
        proof: proof({
          proofCompletedAt: "2026-04-15T12:30:00.000Z",
        }),
      }),
    );
    const futureEvidence = buildTransactionalEmailEvidence(
      input({
        proof: proof({
          proofCompletedAt: "2026-05-30T13:05:00.000Z",
        }),
      }),
    );

    expect(staleEvidence.approved).toBe(false);
    expect(staleEvidence.errors).toContain("Transactional email proofCompletedAt cannot be older than 30 days.");
    expect(futureEvidence.approved).toBe(false);
    expect(futureEvidence.errors).toContain("Transactional email proofCompletedAt cannot be after checkedAt.");
  });

  it("fails when production SES proof timestamps are date-only values", () => {
    const proofCompletedOnly = buildTransactionalEmailEvidence(
      input({
        proof: proof({
          proofCompletedAt: "2026-05-30",
        }),
      }),
    );
    const checkedOnly = buildTransactionalEmailEvidence(input({ checkedAt: "2026-05-30" }));

    expect(proofCompletedOnly.approved).toBe(false);
    expect(proofCompletedOnly.errors).toContain("Transactional email proofCompletedAt must be an ISO timestamp.");
    expect(checkedOnly.approved).toBe(false);
    expect(checkedOnly.errors).toContain("Transactional email evidence checkedAt must be an ISO timestamp.");
  });

  it("fails when webhook destination is not the production provider webhook path", () => {
    const evidence = buildTransactionalEmailEvidence(
      input({
        proof: proof({
          webhookDestination: "https://staging.chasesets.com/api/notifications/provider/email/webhooks",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Transactional email proof must use the Notifications email provider webhook path on a production Chase Sets host.",
    );
  });

  it("fails when webhook destination is not absolute HTTPS", () => {
    const evidence = buildTransactionalEmailEvidence(
      input({
        proof: proof({
          webhookDestination: "http://marketplace.chasesets.com/api/notifications/provider/email/webhooks",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Transactional email proof must use an HTTPS webhook destination.");
  });

  it("fails when webhook destination uses an arbitrary host", () => {
    const evidence = buildTransactionalEmailEvidence(
      input({
        proof: proof({
          webhookDestination: "https://example.com/api/notifications/provider/email/webhooks",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Transactional email proof must use the Notifications email provider webhook path on a production Chase Sets host.",
    );
  });

  it("fails when a critical template area is missing", () => {
    const evidence = buildTransactionalEmailEvidence(
      input({
        proof: proof({
          criticalTemplateAreasCovered: ["auth", "orders", "payments", "fulfillment", "refunds", "support"],
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Transactional email proof must include critical template area payouts.");
  });

  it("fails when concrete provider event references are missing", () => {
    expect(() =>
      buildTransactionalEmailEvidence(
        input({
          proof: proof({
            bounceEventReference: "",
          }),
        }),
      ),
    ).toThrow("Transactional email bounceEventReference must be a non-empty string.");
  });

  it("fails when concrete provider event references are placeholders", () => {
    const evidence = buildTransactionalEmailEvidence(
      input({
        proof: proof({
          bounceEventReference: "n/a",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Transactional email bounceEventReference must point to a real external evidence record, not a placeholder.",
    );
  });

  it("fails when provider webhook event rows do not prove delivery, bounce, and complaint coverage", () => {
    const evidence = buildTransactionalEmailEvidence(
      input({
        proof: proof({
          providerEventRowCount: 2,
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Transactional email proof must include at least three provider event rows.");
  });

  it("fails when controlled send and outbox identifiers are placeholders or not concrete", () => {
    const evidence = buildTransactionalEmailEvidence(
      input({
        proof: proof({
          controlledSendProviderMessageId: "sample",
          outboxRowId: "0",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain(
      "Transactional email controlledSendProviderMessageId must be a concrete identifier, not a placeholder.",
    );
    expect(evidence.errors).toContain(
      "Transactional email outboxRowId must be a positive transactional_email_outbox row id.",
    );
  });

  it("fails when provider event ids do not match the SES event shape", () => {
    const evidence = buildTransactionalEmailEvidence(
      input({
        proof: proof({
          deliveryProviderEventId: "amazon-ses:ses_msg_controlled_20260530:bounce:2026-05-30T12:31:00.000Z",
          bounceProviderEventId: "amazon-ses:sample:bounce:2026-05-30T12:32:00.000Z",
          complaintProviderEventId: "amazon-ses:ses_msg_complaint_20260530:complaint:2026-05-30",
        }),
      }),
    );

    expect(evidence.approved).toBe(false);
    expect(evidence.errors).toContain("Transactional email deliveryProviderEventId must be a delivery provider event.");
    expect(evidence.errors).toContain(
      "Transactional email bounceProviderEventId provider message id must be a concrete identifier, not a placeholder.",
    );
    expect(evidence.errors).toContain(
      "Transactional email complaintProviderEventId occurred-at value must be an ISO timestamp.",
    );
  });

  it("keeps the required proof lists aligned with the launch evidence verifier", () => {
    expect(REQUIRED_TRANSACTIONAL_EMAIL_PROOFS).toEqual([
      "sesDnsVerified",
      "controlledSendProven",
      "outboxDispatchProven",
      "bounceComplaintParsingProven",
      "deliveryMonitoringProven",
      "webhookDestinationConfigured",
      "snsSubscriptionConfirmed",
    ]);
    expect(REQUIRED_TRANSACTIONAL_EMAIL_TEMPLATE_AREAS).toEqual([
      "auth",
      "orders",
      "payments",
      "fulfillment",
      "refunds",
      "support",
      "payouts",
    ]);
    expect(REQUIRED_TRANSACTIONAL_EMAIL_REFERENCES).toEqual([
      "sesIdentityReference",
      "controlledSendMessageReference",
      "outboxDispatchReference",
      "deliveryEventReference",
      "bounceEventReference",
      "complaintEventReference",
      "deliveryMonitoringReference",
      "snsSubscriptionConfirmationReference",
      "templateReviewReference",
    ]);
    expect(REQUIRED_TRANSACTIONAL_EMAIL_IDENTIFIERS).toEqual([
      "controlledSendProviderMessageId",
      "outboxRowId",
      "deliveryProviderEventId",
      "bounceProviderEventId",
      "complaintProviderEventId",
    ]);
  });

  it("parses operator arguments from flags and environment", () => {
    expect(
      parseTransactionalEmailEvidenceArgs(
        [
          "--proof",
          "secure/transactional-email.json",
          "--reference",
          "NOTIFICATIONS-SES-2026-05-30",
          "--owner",
          "Notifications Ops",
          "--checked-at",
          "2026-05-30T13:00:00.000Z",
        ],
        {},
      ),
    ).toMatchObject({
      proofPath: "secure/transactional-email.json",
      reference: "NOTIFICATIONS-SES-2026-05-30",
      owner: "Notifications Ops",
      checkedAt: "2026-05-30T13:00:00.000Z",
    });

    expect(
      parseTransactionalEmailEvidenceArgs([], {
        TRANSACTIONAL_EMAIL_PROOF_RECORD: "secure/transactional-email.json",
        PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE: "NOTIFICATIONS-SES-2026-05-30",
      }),
    ).toMatchObject({
      proofPath: "secure/transactional-email.json",
      reference: "NOTIFICATIONS-SES-2026-05-30",
      owner: "Notifications",
    });
  });
});
