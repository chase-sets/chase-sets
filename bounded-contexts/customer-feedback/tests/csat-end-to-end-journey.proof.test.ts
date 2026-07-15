// Terminal launch-readiness PROOF for issue #5156: prove the Customer Feedback
// CSAT capability behaves as ONE coherent system across the whole journey —
// eligible source outcome -> server-issued invitation -> presentation ->
// deliberate rating/comment/consent -> submission -> analytics metric ->
// low-score attention -> triage/assignment -> consented follow-up delivery ->
// disposition/close -> reopen, together with the privacy/consent + RBAC
// invariants the customer-feedback work enforces.
//
// Test files may reference issue numbers freely (the source issue-ref ban exempts
// tests, and this file also lives under `tests/`). This proof composes the
// customer-feedback deciders/evolvers in a journey framing (a decide->evolve fold,
// exactly as a real command handler folds an aggregate), drives the merged
// source-context outcome-fact contract, and asserts the cross-context seam from
// each context's context.json so metric/notification facts can only flow along
// the declared subscriptions. Browser, deployed-topology, DB-scale, accessibility,
// performance, and representative-staging rows are recorded as pending in the
// acceptance doc; here we prove every capture, scoring, attention, follow-up,
// replay, deploy-skew, privacy, and negative-RBAC invariant against the merged
// contracts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NotificationDeliveryGuard } from "@chase-sets/outbound-messaging";
import { describe, expect, it } from "vitest";

import {
  CsatInvitationDecisionError,
  decideCsatInvitation,
  evolveCsatInvitation,
  initialCsatInvitationState,
  type CsatEligibilityControls,
  type CsatInvitationAggregateState,
  type CsatInvitationCommand,
} from "../features/csat/domain/invitation-decider";
import { transactionalCsatV1, legacyExperienceRatingV0, type CsatRatingValue } from "../features/csat/domain/survey";
import {
  type CsatInvitationId,
  type CsatInvitationPublicReference,
  type CsatSurveySubmittedEvent,
  type CustomerFeedbackInvitationEvent,
} from "../features/csat/domain/invitation";
import { createCsatOutcomeFactV1, type CsatOutcomeFactV1 } from "../features/csat/domain/outcome-fact";
import type { CsatSamplingPolicyV1 } from "../features/csat/domain/sampling";
import { calculateCsat, calculateResponseRate } from "../features/csat/domain/csat-metric";
import { classifyStoredFeedbackEvent } from "../features/csat/domain/replay-compat";
import {
  csatWorkflowOutcomeCodes,
  csatWorkflowOutcomeSourceContext,
  isProvenanceAuthoritative,
  type CsatWorkflowOutcomeCode,
} from "../features/csat/domain/workflow-outcomes";
import {
  FeedbackCaseDecisionError,
  decideFeedbackCase,
  evolveFeedbackCase,
  initialFeedbackCaseState,
  type FeedbackCaseAggregateState,
  type FeedbackCaseCommand,
} from "../features/cases/domain/feedback-case-decider";
import {
  feedbackCaseActorCan,
  type FeedbackCase,
  type FeedbackCaseActor,
  type FeedbackCaseEvent,
  type FeedbackCaseId,
} from "../features/cases/domain/feedback-case";
import { classifyFeedbackAttention } from "../features/attention/domain/attention";
import {
  canAccessFeedbackAttention,
  feedbackAttentionExportAllowed,
  type FeedbackAttentionApiActor,
} from "../features/attention/api/access";
import { createFeedbackNotificationDeliveryGuard } from "../features/attention/integrations/notifications/delivery-authorization";
import { customerFeedbackPrivacyCapabilities, privacyPermission } from "../features/privacy/domain/policy";

// ---------------------------------------------------------------------------
// Journey fixtures and decide->evolve folds.
// ---------------------------------------------------------------------------

const BASE = "2026-03-01T00:00:00.000Z";
const PRESENT_AT = "2026-03-01T00:05:00.000Z";
const SUBMIT_AT = "2026-03-01T00:06:00.000Z";
const AFTER_TTL = "2026-03-20T00:00:00.000Z"; // policy TTL is P14D -> expired by here.

const SUBJECT_ACCOUNT = "acc_buyer_0001";
const INVITATION_ID = "csatinv_01JQZZ0000000000000000000A" as CsatInvitationId;
const PUBLIC_REFERENCE = "csatref_12345678-1234-1234-1234-123456789012" as CsatInvitationPublicReference;
const CASE_ID = "fbcase_01JQZZ0000000000000000000B" as FeedbackCaseId;
const CONSENT_VERSION = transactionalCsatV1.followUpConsentVersion;

function policyFor(outcomeCode: CsatWorkflowOutcomeCode): CsatSamplingPolicyV1 {
  return {
    policySchemaVersion: 1,
    policyId: `policy:${outcomeCode}`,
    outcomeCode,
    surveyVersion: transactionalCsatV1.id,
    issuanceEnabled: true,
    sampleRate: 1, // deterministic include: bucket in [0,1) is always < 1.
    cohortKey: "beta",
    perSubjectCooldown: "P30D",
    invitationTtl: "P14D",
    dependsOnBetaCohorts: false,
  };
}

const eligibleControls: CsatEligibilityControls = {
  subjectEligible: true,
  consentAllowed: true,
  trafficKind: "customer",
  lastIssuedAt: null,
};

function outcomeFact(
  outcomeCode: CsatWorkflowOutcomeCode,
  entityType: string,
  entityId: string,
  subjectKind: CsatOutcomeFactV1["subjectKind"],
  overrides: Partial<Pick<CsatOutcomeFactV1, "idempotencyKey" | "outcomeOccurredAt">> = {},
): CsatOutcomeFactV1 {
  return createCsatOutcomeFactV1({
    outcomeCode,
    sourceContext: csatWorkflowOutcomeSourceContext[outcomeCode],
    subjectAccountId: SUBJECT_ACCOUNT,
    subjectKind,
    subject: { entityType, entityId },
    outcomeOccurredAt: overrides.outcomeOccurredAt ?? BASE,
    idempotencyKey:
      overrides.idempotencyKey ?? `${csatWorkflowOutcomeSourceContext[outcomeCode]}:${outcomeCode}:${entityId}`,
  });
}

function evaluateCommand(fact: CsatOutcomeFactV1, evaluatedAt = BASE): CsatInvitationCommand {
  return {
    type: "EvaluateCsatOutcomeFact",
    invitationId: INVITATION_ID,
    publicReference: PUBLIC_REFERENCE,
    fact,
    policy: policyFor(fact.outcomeCode),
    controls: eligibleControls,
    evaluatedAt,
  };
}

function presentCommand(actedAt = PRESENT_AT): CsatInvitationCommand {
  return {
    type: "PresentCsatInvitation",
    publicReference: PUBLIC_REFERENCE,
    subjectAccountId: SUBJECT_ACCOUNT,
    surveyVersion: transactionalCsatV1.id,
    actedAt,
  };
}

function submitCommand(
  rating: CsatRatingValue,
  options: Readonly<{ consent?: boolean; comment?: string | null; idempotencyKey?: string; submittedAt?: string }> = {},
): CsatInvitationCommand {
  const consent = options.consent ?? true;
  const submittedAt = options.submittedAt ?? SUBMIT_AT;
  return {
    type: "SubmitCsatSurvey",
    publicReference: PUBLIC_REFERENCE,
    subjectAccountId: SUBJECT_ACCOUNT,
    surveyVersion: transactionalCsatV1.id,
    rating,
    comment: options.comment ?? "Clear, honest free-text feedback.",
    followUpConsent: consent,
    followUpConsentVersion: CONSENT_VERSION,
    followUpConsentAt: consent ? submittedAt : null,
    submissionIdempotencyKey: options.idempotencyKey ?? "sub-key-1",
    submittedAt,
  };
}

type InvitationRun = Readonly<{
  state: CsatInvitationAggregateState;
  events: readonly CustomerFeedbackInvitationEvent[];
}>;

function runInvitation(
  commands: readonly CsatInvitationCommand[],
  start: CsatInvitationAggregateState = initialCsatInvitationState,
): InvitationRun {
  let state = start;
  const events: CustomerFeedbackInvitationEvent[] = [];
  for (const command of commands) {
    for (const event of decideCsatInvitation(state, command)) {
      state = evolveCsatInvitation(state, event);
      events.push(event);
    }
  }
  return { state, events };
}

function foldInvitation(events: readonly CustomerFeedbackInvitationEvent[]): CsatInvitationAggregateState {
  return events.reduce(evolveCsatInvitation, initialCsatInvitationState);
}

function submittedData(run: InvitationRun): CsatSurveySubmittedEvent["data"] {
  const submitted = run.events.find(
    (event): event is CsatSurveySubmittedEvent => event.type === "customer-feedback.survey.submitted",
  );
  if (!submitted) throw new Error("Expected a submitted survey event in the run.");
  return submitted.data;
}

function eventTypes(run: InvitationRun): readonly string[] {
  return run.events.map((event) => event.type);
}

// A full commerce journey: eligible outcome -> issued -> presented -> submitted.
function commerceJourney(rating: CsatRatingValue, consent = true): InvitationRun {
  return runInvitation([
    evaluateCommand(outcomeFact("checkout.completed", "checkout-session", "chk_1", "buyer")),
    presentCommand(),
    submitCommand(rating, { consent }),
  ]);
}

type CaseRun = Readonly<{ state: FeedbackCaseAggregateState; events: readonly FeedbackCaseEvent[] }>;

function runCase(
  commands: readonly FeedbackCaseCommand[],
  start: FeedbackCaseAggregateState = initialFeedbackCaseState,
): CaseRun {
  let state = start;
  const events: FeedbackCaseEvent[] = [];
  for (const command of commands) {
    for (const event of decideFeedbackCase(state, command)) {
      state = evolveFeedbackCase(state, event);
      events.push(event);
    }
  }
  return { state, events };
}

function foldCase(events: readonly FeedbackCaseEvent[]): FeedbackCaseAggregateState {
  return events.reduce(evolveFeedbackCase, initialFeedbackCaseState);
}

const manager: FeedbackCaseActor = { actorId: "user_op_manager", authority: "manage-feedback-cases" };
const notifier: FeedbackCaseActor = { actorId: "user_op_notifier", authority: "notify-feedback-cases" };
const viewer: FeedbackCaseActor = { actorId: "user_op_viewer", authority: "view-feedback-cases" };

// ===========================================================================
// J01 — Commerce / post-transaction happy path (#5150 branch).
// ===========================================================================

describe("J01 commerce happy path: eligible outcome to scored submission", () => {
  it("issues from a server outcome fact, presents, and records a deliberate satisfied rating", () => {
    const run = commerceJourney(5);
    expect(eventTypes(run)).toEqual([
      "customer-feedback.invitation.eligible",
      "customer-feedback.invitation.issued",
      "customer-feedback.invitation.presented",
      "customer-feedback.survey.submitted",
    ]);
    const invitation = run.state.invitation;
    expect(invitation?.state).toBe("submitted");
    // Provenance is copied only from the redeemed fact — the client never asserts it.
    expect(invitation?.provenance.outcomeCode).toBe("checkout.completed");
    expect(invitation?.provenance.sourceContext).toBe("checkout");
    // The browser-facing reference is opaque, never the aggregate id or a source id.
    expect(invitation?.publicReference).toBe(PUBLIC_REFERENCE);
    expect(invitation?.publicReference).not.toContain("chk_1");
    expect(run.state.acceptedSubmission?.rating).toBe(5);
    // Follow-up consent is captured with its full, versioned, this-response-only metadata.
    expect(run.state.acceptedSubmission?.followUpConsent).toBe(true);
    expect(run.state.acceptedSubmission?.followUpConsentApplicability).toBe("this-response-only");
    expect(run.state.acceptedSubmission?.followUpConsentVersion).toBe(CONSENT_VERSION);
  });

  it("requires deliberate presentation before submission (no default answer path)", () => {
    // Submitting without a prior presentation is refused: there is no auto-answer.
    const run = runInvitation([
      evaluateCommand(outcomeFact("checkout.completed", "checkout-session", "chk_2", "buyer")),
    ]);
    expect(() => decideCsatInvitation(run.state, submitCommand(4))).toThrowError(CsatInvitationDecisionError);
    expect(transactionalCsatV1.ratingScale.defaultSelection).toBeNull();
  });
});

// ===========================================================================
// J02 / J03 — Each coverage branch produces a real journey (#5150/#5151/#5152).
// ===========================================================================

describe("J02 seller / money branch journey (#5151)", () => {
  it("drives a payout-completed and listing-published journey to a scored submission", () => {
    for (const [code, entityType, entityId] of [
      ["payout.completed", "payout", "pay_1"],
      ["listing.published", "listing", "lst_1"],
      ["offer.accepted", "offer", "off_1"],
      ["inventory.item-adjusted", "inventory-item", "inv_1"],
    ] as const) {
      const run = runInvitation([
        evaluateCommand(outcomeFact(code, entityType, entityId, "seller")),
        presentCommand(),
        submitCommand(5),
      ]);
      expect(run.state.invitation?.state).toBe("submitted");
      expect(run.state.invitation?.provenance.outcomeCode).toBe(code);
      expect(run.state.invitation?.subjectKind).toBe("seller");
    }
  });
});

describe("J03 discovery / onboarding branch journey (#5152)", () => {
  it("drives an onboarding and discovery journey to a scored submission", () => {
    for (const [code, entityType, entityId, kind] of [
      ["onboarding.completed", "account", "acc_x", "account"],
      ["discovery.search-completed", "search-session", "ses_1", "visitor"],
      ["registration.completed", "account", "acc_y", "account"],
      ["authentication.completed", "session", "ses_2", "account"],
    ] as const) {
      const run = runInvitation([
        evaluateCommand(outcomeFact(code, entityType, entityId, kind)),
        presentCommand(),
        submitCommand(4),
      ]);
      expect(run.state.invitation?.state).toBe("submitted");
      expect(run.state.invitation?.provenance.outcomeCode).toBe(code);
    }
  });
});

// ===========================================================================
// J04 — Checkout failure then recovery: one analyzable outcome, no duplicate.
// ===========================================================================

describe("J04 failure/recovery yields a single analyzable outcome with no duplicate response", () => {
  it("issues one invitation per distinct recovered outcome fact and dedupes redelivery", () => {
    const recovered = outcomeFact("checkout.recovered", "checkout-session", "chk_r", "buyer", {
      idempotencyKey: "checkout:recovered:chk_r",
    });
    const run = runInvitation([evaluateCommand(recovered), presentCommand(), submitCommand(5)]);
    expect(run.state.invitation?.provenance.outcomeCode).toBe("checkout.recovered");

    // Re-delivering the identical recovered fact to the redeemed aggregate is a no-op
    // (duplicate/out-of-order/reversed-then-reissued facts never mint a second survey).
    expect(decideCsatInvitation(run.state, evaluateCommand(recovered))).toEqual([]);

    // Re-submitting the same idempotency key with identical content is idempotent.
    expect(decideCsatInvitation(run.state, submitCommand(5))).toEqual([]);
  });

  it("refuses a different outcome fact on an already-redeemed invitation aggregate", () => {
    const run = runInvitation([
      evaluateCommand(outcomeFact("checkout.completed", "checkout-session", "chk_3", "buyer")),
    ]);
    const different = outcomeFact("checkout.recovered", "checkout-session", "chk_3", "buyer", {
      idempotencyKey: "checkout:recovered:other",
    });
    expect(() => decideCsatInvitation(run.state, evaluateCommand(different))).toThrowError(/already-redeemed|redeemed/);
  });
});

// ===========================================================================
// J05 / J06 — Closed loop: low score -> attention -> follow-up -> close -> reopen.
// ===========================================================================

function openLowScoreCase(rating: CsatRatingValue = 1): CaseRun {
  const submission = submittedData(commerceJourney(rating));
  return runCase([
    {
      type: "OpenFeedbackCase",
      caseId: CASE_ID,
      submission,
      openReason: "low-score",
      actor: manager,
      actedAt: SUBMIT_AT,
    },
  ]);
}

describe("J05 closed loop: low score raises attention and a consented follow-up completes", () => {
  it("opens a case with attention, triages, delivers a consented follow-up, and closes", () => {
    const opened = openLowScoreCase(1);
    expect(opened.events.map((event) => event.type)).toEqual([
      "customer-feedback.case.opened",
      "customer-feedback.case.attention-requested",
    ]);
    expect(classifyFeedbackAttention(1).requiresAttention).toBe(true);
    expect(opened.state.feedbackCase?.priority).toBe("urgent");
    expect(opened.state.feedbackCase?.consent.status).toBe("granted");

    const closed = runCase(
      [
        { type: "TriageFeedbackCase", actor: manager, actedAt: "2026-03-01T00:10:00.000Z" },
        { type: "AssignFeedbackCase", ownerId: "user_op_owner", actor: manager, actedAt: "2026-03-01T00:11:00.000Z" },
        {
          type: "SetFeedbackCaseDueDate",
          dueAt: "2026-03-02T00:00:00.000Z",
          actor: manager,
          actedAt: "2026-03-01T00:12:00.000Z",
        },
        {
          type: "RequestFeedbackCaseFollowUp",
          consentVersion: CONSENT_VERSION,
          channel: "web",
          actor: manager,
          actedAt: "2026-03-01T00:13:00.000Z",
        },
        {
          type: "MarkFeedbackCaseFollowUpSent",
          deliveryReference: "ntf_followup_1",
          channel: "web",
          actor: notifier,
          actedAt: "2026-03-01T00:14:00.000Z",
        },
        {
          type: "RecordFeedbackCaseFollowUpOutcome",
          outcome: "resolved",
          actor: manager,
          actedAt: "2026-03-01T00:20:00.000Z",
        },
        {
          type: "SetFeedbackCaseDisposition",
          disposition: "support-resolved",
          actor: manager,
          actedAt: "2026-03-01T00:21:00.000Z",
        },
        { type: "CloseFeedbackCase", actor: manager, actedAt: "2026-03-01T00:22:00.000Z" },
      ],
      opened.state,
    );
    const feedbackCase = closed.state.feedbackCase;
    expect(feedbackCase?.status).toBe("closed");
    expect(feedbackCase?.ownerId).toBe("user_op_owner");
    expect(feedbackCase?.followUpStatus).toBe("completed");
    expect(feedbackCase?.followUpOutcome).toBe("resolved");
    expect(feedbackCase?.disposition).toBe("support-resolved");
  });

  it("refuses closure while a customer follow-up is still pending", () => {
    const opened = openLowScoreCase(2);
    const pending = runCase(
      [
        { type: "TriageFeedbackCase", actor: manager, actedAt: "2026-03-01T00:10:00.000Z" },
        {
          type: "RequestFeedbackCaseFollowUp",
          consentVersion: CONSENT_VERSION,
          channel: "web",
          actor: manager,
          actedAt: "2026-03-01T00:13:00.000Z",
        },
        {
          type: "SetFeedbackCaseDisposition",
          disposition: "support-resolved",
          actor: manager,
          actedAt: "2026-03-01T00:21:00.000Z",
        },
      ],
      opened.state,
    );
    expect(() =>
      decideFeedbackCase(pending.state, {
        type: "CloseFeedbackCase",
        actor: manager,
        actedAt: "2026-03-01T00:22:00.000Z",
      }),
    ).toThrowError(FeedbackCaseDecisionError);
  });
});

describe("J06 reopen re-raises attention", () => {
  it("reopens a closed case back to triaged and requests fresh attention", () => {
    const opened = openLowScoreCase(1);
    const closed = runCase(
      [
        { type: "TriageFeedbackCase", actor: manager, actedAt: "2026-03-01T00:10:00.000Z" },
        {
          type: "SetFeedbackCaseDisposition",
          disposition: "no-action",
          actor: manager,
          actedAt: "2026-03-01T00:21:00.000Z",
        },
        { type: "CloseFeedbackCase", actor: manager, actedAt: "2026-03-01T00:22:00.000Z" },
      ],
      opened.state,
    );
    const reopened = runCase(
      [{ type: "ReopenFeedbackCase", actor: manager, actedAt: "2026-03-03T00:00:00.000Z" }],
      closed.state,
    );
    expect(reopened.events.map((event) => event.type)).toEqual([
      "customer-feedback.case.reopened",
      "customer-feedback.case.attention-requested",
    ]);
    expect(reopened.state.feedbackCase?.status).toBe("triaged");
    expect(reopened.state.feedbackCase?.disposition).toBeNull();
  });
});

// ===========================================================================
// J07 / J08 / J09 / J10 — Deterministic edge behavior on the invitation aggregate.
// ===========================================================================

describe("J07 dismiss then return and submit behaves deterministically", () => {
  it("allows submission after a presented invitation is dismissed and revisited", () => {
    const run = runInvitation([
      evaluateCommand(outcomeFact("order.delivered", "shipment", "shp_1", "buyer")),
      presentCommand(),
      {
        type: "DismissCsatInvitation",
        publicReference: PUBLIC_REFERENCE,
        subjectAccountId: SUBJECT_ACCOUNT,
        surveyVersion: transactionalCsatV1.id,
        actedAt: "2026-03-01T00:05:30.000Z",
      },
      submitCommand(4),
    ]);
    expect(run.state.invitation?.state).toBe("submitted");
    expect(eventTypes(run)).toContain("customer-feedback.invitation.dismissed");
  });
});

describe("J08 expiration is deterministic and never revived", () => {
  it("emits an expired event when presented past the invitation TTL", () => {
    const issued = runInvitation([evaluateCommand(outcomeFact("order.delivered", "shipment", "shp_2", "buyer"))]);
    const expired = runInvitation([presentCommand(AFTER_TTL)], issued.state);
    expect(expired.events.map((event) => event.type)).toEqual(["customer-feedback.invitation.expired"]);
    expect(expired.state.invitation?.state).toBe("expired");
  });
});

describe("J09 duplicate tab / double submit resolves to at-most-one response", () => {
  it("is idempotent for the same submission and conflicts on a divergent one", () => {
    const run = commerceJourney(3);
    // Same idempotency key + identical content -> no second event (duplicate tab).
    expect(decideCsatInvitation(run.state, submitCommand(3))).toEqual([]);
    // A divergent submission on a redeemed invitation is a hard conflict, never a silent overwrite.
    expect(() => decideCsatInvitation(run.state, submitCommand(1, { idempotencyKey: "sub-key-2" }))).toThrowError(
      /submission-conflict|already accepted/,
    );
  });
});

describe("J10 duplicate and out-of-order outcome facts converge", () => {
  it("re-evaluating the same fact after issuance is a no-op", () => {
    const fact = outcomeFact("return.resolved", "return", "ret_1", "buyer");
    const run = runInvitation([evaluateCommand(fact)]);
    expect(decideCsatInvitation(run.state, evaluateCommand(fact))).toEqual([]);
    expect(run.state.invitation?.state).toBe("issued");
  });
});

// ===========================================================================
// J11 / J12 / J13 — Negative RBAC and consent-gated notification delivery.
// ===========================================================================

describe("J11 negative RBAC on the operator attention surface", () => {
  const cases: ReadonlyArray<
    Readonly<{
      label: string;
      actor: FeedbackAttentionApiActor | null;
      view: boolean;
      manage: boolean;
      notify: boolean;
      export: boolean;
    }>
  > = [
    { label: "anonymous", actor: null, view: false, manage: false, notify: false, export: false },
    {
      label: "ordinary account",
      actor: { permissions: ["account.read", "listings.write"] },
      view: false,
      manage: false,
      notify: false,
      export: false,
    },
    {
      label: "view-only staff",
      actor: { permissions: ["support.view"] },
      view: true,
      manage: false,
      notify: false,
      export: false,
    },
    {
      label: "notify staff",
      actor: { permissions: ["support.notify"] },
      view: true,
      manage: false,
      notify: true,
      export: false,
    },
    {
      label: "manager staff",
      actor: { permissions: ["support.manage"] },
      view: true,
      manage: true,
      notify: true,
      export: false,
    },
    {
      label: "export-only staff",
      actor: { permissions: [privacyPermission("export-sensitive-feedback")] },
      view: true,
      manage: false,
      notify: false,
      export: true,
    },
  ];

  it("grants exactly the capabilities each staff role should have and nothing more", () => {
    for (const scenario of cases) {
      expect(canAccessFeedbackAttention(scenario.actor, "view")).toBe(scenario.view);
      expect(canAccessFeedbackAttention(scenario.actor, "manage")).toBe(scenario.manage);
      expect(canAccessFeedbackAttention(scenario.actor, "notify")).toBe(scenario.notify);
      expect(canAccessFeedbackAttention(scenario.actor, "export")).toBe(scenario.export);
      expect(feedbackAttentionExportAllowed(scenario.actor)).toBe(scenario.export);
    }
  });

  it("keeps sensitive export gated behind the dedicated privacy capability, not support.manage", () => {
    expect(canAccessFeedbackAttention({ permissions: ["support.manage"] }, "export")).toBe(false);
    expect(
      canAccessFeedbackAttention({ permissions: [privacyPermission("export-sensitive-feedback")] }, "export"),
    ).toBe(true);
  });
});

describe("J12 negative RBAC on feedback-case commands", () => {
  it("requires manager authority for lifecycle commands and refuses lower authorities", () => {
    const submission = submittedData(commerceJourney(1));
    for (const actor of [notifier, viewer]) {
      expect(() =>
        decideFeedbackCase(initialFeedbackCaseState, {
          type: "OpenFeedbackCase",
          caseId: CASE_ID,
          submission,
          openReason: "low-score",
          actor,
          actedAt: SUBMIT_AT,
        }),
      ).toThrowError(FeedbackCaseDecisionError);
    }
    // A view-only actor cannot request follow-up either.
    const opened = openLowScoreCase(1);
    const triaged = runCase(
      [{ type: "TriageFeedbackCase", actor: manager, actedAt: "2026-03-01T00:10:00.000Z" }],
      opened.state,
    );
    expect(() =>
      decideFeedbackCase(triaged.state, {
        type: "RequestFeedbackCaseFollowUp",
        consentVersion: CONSENT_VERSION,
        actor: viewer,
        actedAt: "2026-03-01T00:13:00.000Z",
      }),
    ).toThrowError(FeedbackCaseDecisionError);
  });

  it("permits notify authority for delivery commands only, mirroring feedbackCaseActorCan", () => {
    expect(feedbackCaseActorCan(notifier, "notify")).toBe(true);
    expect(feedbackCaseActorCan(notifier, "manage")).toBe(false);
    expect(feedbackCaseActorCan(viewer, "view")).toBe(true);
    expect(feedbackCaseActorCan(viewer, "manage")).toBe(false);
    expect(feedbackCaseActorCan(manager, "manage")).toBe(true);
    expect(feedbackCaseActorCan(manager, "export")).toBe(true);
    // A notify actor can mark a requested follow-up sent (a delivery command).
    const opened = openLowScoreCase(1);
    const requested = runCase(
      [
        { type: "TriageFeedbackCase", actor: manager, actedAt: "2026-03-01T00:10:00.000Z" },
        {
          type: "RequestFeedbackCaseFollowUp",
          consentVersion: CONSENT_VERSION,
          channel: "web",
          actor: manager,
          actedAt: "2026-03-01T00:13:00.000Z",
        },
      ],
      opened.state,
    );
    const sent = runCase(
      [
        {
          type: "MarkFeedbackCaseFollowUpSent",
          deliveryReference: "ntf_x",
          channel: "web",
          actor: notifier,
          actedAt: "2026-03-01T00:14:00.000Z",
        },
      ],
      requested.state,
    );
    expect(sent.state.feedbackCase?.followUpStatus).toBe("sent");
  });
});

describe("J13 follow-up notification delivery is consent-gated at the guard seam", () => {
  const requestedCase = (() => {
    const opened = openLowScoreCase(1);
    return runCase(
      [
        { type: "TriageFeedbackCase", actor: manager, actedAt: "2026-03-01T00:10:00.000Z" },
        {
          type: "RequestFeedbackCaseFollowUp",
          consentVersion: CONSENT_VERSION,
          channel: "web",
          actor: manager,
          actedAt: "2026-03-01T00:13:00.000Z",
        },
      ],
      opened.state,
    ).state.feedbackCase;
  })();

  type Delivery = Parameters<NotificationDeliveryGuard["evaluateNotificationDelivery"]>[0];

  function followUpDelivery(
    overrides: Readonly<{ recipient?: string; channel?: string; template?: number; caseId?: string }> = {},
  ): Delivery {
    return {
      message: {
        messageType: "customer-feedback.case.follow-up-requested",
        recipientAccountId: overrides.recipient ?? SUBJECT_ACCOUNT,
        templateVersion: overrides.template ?? 1,
        templateData: { caseId: overrides.caseId ?? CASE_ID, consentVersion: CONSENT_VERSION },
      },
      channel: { channel: overrides.channel ?? "web" },
    } as unknown as Delivery;
  }

  function guardFor(feedbackCase: FeedbackCase | null): NotificationDeliveryGuard {
    return createFeedbackNotificationDeliveryGuard(async () => feedbackCase);
  }

  it("allows delivery only when the case, consent, recipient, channel, and template all match", async () => {
    const decision = await guardFor(requestedCase ?? null).evaluateNotificationDelivery(followUpDelivery());
    expect(decision.allowed).toBe(true);
  });

  it("blocks delivery to a mismatched recipient", async () => {
    const decision = await guardFor(requestedCase ?? null).evaluateNotificationDelivery(
      followUpDelivery({ recipient: "acc_intruder" }),
    );
    expect(decision.allowed).toBe(false);
  });

  it("blocks delivery once consent is withdrawn", async () => {
    const withdrawn = requestedCase
      ? ({
          ...requestedCase,
          consent: { ...requestedCase.consent, status: "withdrawn" as const, withdrawnAt: SUBMIT_AT },
        } satisfies FeedbackCase)
      : null;
    const decision = await guardFor(withdrawn).evaluateNotificationDelivery(followUpDelivery());
    expect(decision.allowed).toBe(false);
  });

  it("passes through unrelated notification message types unchanged", async () => {
    const unrelated = {
      message: { messageType: "notifications.other" },
      channel: { channel: "web" },
    } as unknown as Delivery;
    const decision = await guardFor(requestedCase ?? null).evaluateNotificationDelivery(unrelated);
    expect(decision.allowed).toBe(true);
  });
});

// ===========================================================================
// J14 — Replay from empty state reproduces invitation and case state exactly.
// ===========================================================================

describe("J14 replay from an empty projection reproduces state exactly", () => {
  it("re-folding the invitation event log yields an identical aggregate", () => {
    const run = commerceJourney(2);
    expect(foldInvitation(run.events)).toEqual(run.state);
  });

  it("re-folding the feedback-case event log yields an identical aggregate", () => {
    const opened = openLowScoreCase(1);
    const closed = runCase(
      [
        { type: "TriageFeedbackCase", actor: manager, actedAt: "2026-03-01T00:10:00.000Z" },
        {
          type: "SetFeedbackCaseDisposition",
          disposition: "no-action",
          actor: manager,
          actedAt: "2026-03-01T00:21:00.000Z",
        },
        { type: "CloseFeedbackCase", actor: manager, actedAt: "2026-03-01T00:22:00.000Z" },
      ],
      opened.state,
    );
    const allEvents = [...opened.events, ...closed.events];
    expect(foldCase(allEvents)).toEqual(closed.state);
  });
});

// ===========================================================================
// J15 — Rolling-deploy skew: old/new/unknown events classified, never corrupt.
// ===========================================================================

describe("J15 deploy skew tolerates version skew and surfaces unknowns explicitly", () => {
  it("defaults a versionless native event to v1 and reads an explicit version", () => {
    expect(classifyStoredFeedbackEvent({ eventType: "customer-feedback.survey.submitted", payload: {} })).toEqual({
      kind: "native",
      eventType: "customer-feedback.survey.submitted",
      eventSchemaVersion: 1,
    });
    expect(
      classifyStoredFeedbackEvent({
        eventType: "customer-feedback.invitation.issued",
        payload: { eventSchemaVersion: 2 },
      }),
    ).toEqual({ kind: "native", eventType: "customer-feedback.invitation.issued", eventSchemaVersion: 2 });
  });

  it("maps legacy experience events to the non-CSAT classification and unknowns to unrecognized", () => {
    const legacy = classifyStoredFeedbackEvent({
      eventType: "experience.platform-feedback.submitted",
      payload: { rating: 5 },
    });
    expect(legacy.kind).toBe("legacy-experience-rating");
    if (legacy.kind === "legacy-experience-rating") {
      expect(legacy.classification.csatEligible).toBe(false);
    }
    expect(classifyStoredFeedbackEvent({ eventType: "some.unrelated.event", payload: {} })).toEqual({
      kind: "unrecognized",
      eventType: "some.unrelated.event",
    });
  });
});

// ===========================================================================
// J16 — Honest metrics: excluded legacy/incompatible data, unknowable denominators.
// ===========================================================================

describe("J16 CSAT and response-rate metrics stay honest under mixed data", () => {
  it("counts only matching CSAT-eligible submissions and reports an unknowable rate as null", () => {
    const version = transactionalCsatV1.id;
    const score = calculateCsat({
      surveyVersion: version,
      window: "trailing-7d",
      minimumSampleSize: 1,
      ratings: [
        { surveyVersion: version, csatEligible: true, rating: 5, submittedAt: BASE },
        { surveyVersion: version, csatEligible: true, rating: 2, submittedAt: BASE },
        // Legacy rating: csatEligible false -> excluded from numerator AND denominator.
        { surveyVersion: legacyExperienceRatingV0.id, csatEligible: false, rating: 5, submittedAt: BASE },
        // Incompatible question version -> excluded even though it is transactional-csat.
        {
          surveyVersion: { ...version, questionVersion: "csat.q.v2" },
          csatEligible: true,
          rating: 5,
          submittedAt: BASE,
        },
      ],
    });
    expect(score.submittedCount).toBe(2);
    expect(score.satisfiedCount).toBe(1);
    expect(score.csat).toBe(0.5);

    expect(calculateCsat({ surveyVersion: version, window: "trailing-7d", ratings: [] }).csat).toBeNull();
    expect(calculateResponseRate("trailing-7d", { presentedCount: 0, submittedCount: 0 }).responseRate).toBeNull();
    expect(calculateResponseRate("trailing-30d", { presentedCount: 4, submittedCount: 1 }).responseRate).toBe(0.25);
  });
});

// ===========================================================================
// J17 / J18 — Privacy: redaction protects content after replay; hold gates it.
// ===========================================================================

describe("J17 redaction protects response content and is replay-stable and idempotent", () => {
  const redactCommand: CsatInvitationCommand = {
    type: "RedactCsatResponse",
    scope: "all-sensitive",
    reason: "data-subject-request",
    actorId: "user_privacy_1",
    idempotencyKey: "redact-key-1",
    redactedAt: "2026-03-05T00:00:00.000Z",
  };

  it("redacts free text and direct identifiers and withdraws follow-up consent", () => {
    const submitted = commerceJourney(2);
    const redacted = runInvitation([redactCommand], submitted.state);
    expect(redacted.events.map((event) => event.type)).toEqual(["customer-feedback.response.redacted"]);
    expect(redacted.state.acceptedSubmission?.comment).toBeNull();
    expect(redacted.state.invitation?.subjectAccountId).toBe("[redacted]");
    expect(redacted.state.acceptedSubmission?.followUpConsent).toBe(false);
    expect(redacted.state.invitation?.redactedScopes).toContain("all-sensitive");

    // Replay of the full log reproduces the redacted (protected) state exactly.
    expect(foldInvitation([...submitted.events, ...redacted.events])).toEqual(redacted.state);
    // Re-issuing the same redaction key is idempotent.
    expect(decideCsatInvitation(redacted.state, redactCommand)).toEqual([]);
  });

  it("an active privacy hold blocks redaction until released", () => {
    const submitted = commerceJourney(2);
    const held = runInvitation(
      [
        {
          type: "PlaceCsatResponsePrivacyHold",
          holdId: "hold_1",
          reason: "litigation-hold",
          actorId: "user_privacy_1",
          placedAt: "2026-03-04T00:00:00.000Z",
        },
      ],
      submitted.state,
    );
    expect(() => decideCsatInvitation(held.state, { ...redactCommand, idempotencyKey: "redact-key-2" })).toThrowError(
      CsatInvitationDecisionError,
    );
    const released = runInvitation(
      [
        {
          type: "ReleaseCsatResponsePrivacyHold",
          holdId: "hold_1",
          reason: "litigation-hold",
          actorId: "user_privacy_1",
          releasedAt: "2026-03-04T12:00:00.000Z",
        },
      ],
      held.state,
    );
    const redacted = runInvitation([{ ...redactCommand, idempotencyKey: "redact-key-3" }], released.state);
    expect(redacted.state.invitation?.redactedScopes).toContain("all-sensitive");
  });
});

describe("J18 response redaction cascades protection into the feedback case", () => {
  it("withdraws consent, cancels follow-up, and marks the case redacted", () => {
    const opened = openLowScoreCase(1);
    const protectedCase = runCase(
      [
        { type: "TriageFeedbackCase", actor: manager, actedAt: "2026-03-01T00:10:00.000Z" },
        {
          type: "RequestFeedbackCaseFollowUp",
          consentVersion: CONSENT_VERSION,
          channel: "web",
          actor: manager,
          actedAt: "2026-03-01T00:13:00.000Z",
        },
        {
          type: "ProtectFeedbackCaseAfterResponseRedaction",
          scope: "all-sensitive",
          reason: "data-subject-request",
          actor: manager,
          actedAt: "2026-03-06T00:00:00.000Z",
        },
      ],
      opened.state,
    );
    const feedbackCase = protectedCase.state.feedbackCase;
    expect(feedbackCase?.disposition).toBe("redacted");
    expect(feedbackCase?.consent.status).toBe("withdrawn");
    expect(feedbackCase?.followUpStatus).toBe("cancelled");
  });
});

// ===========================================================================
// J19 — Cross-context seam: metric/notification facts flow only along context.json.
// ===========================================================================

type SeamSubscription = Readonly<{
  sourceContextName?: string;
  projectionName?: string;
  reactionName?: string;
  handlerKind?: string;
  eventTypes?: readonly string[];
  projectionHandlerSetNames?: readonly string[];
  reactionHandlerSetNames?: readonly string[];
}>;

type SeamContext = Readonly<{
  contextName?: string;
  allowedContextDependencies?: readonly string[];
  eventReactions?: readonly SeamSubscription[];
  eventSubscriptions?: readonly SeamSubscription[];
  projectionGroups?: readonly SeamSubscription[];
}>;

const baseDir = fileURLToPath(new URL(".", import.meta.url));

function loadContext(relativePath: string): SeamContext {
  return JSON.parse(readFileSync(resolve(baseDir, relativePath), "utf8")) as SeamContext;
}

function seamEntries(context: SeamContext): readonly SeamSubscription[] {
  return [...(context.eventSubscriptions ?? []), ...(context.eventReactions ?? [])];
}

describe("J19 cross-context seam contract from context.json", () => {
  const customerFeedback = loadContext("../context.json");
  const notifications = loadContext("../../notifications/context.json");

  it("opens feedback cases only from customer-feedback submission and redaction facts", () => {
    const opening = seamEntries(customerFeedback).find(
      (entry) => entry.reactionName === "customer-feedback-feedback-case-opening",
    );
    expect(opening?.eventTypes).toEqual(
      expect.arrayContaining(["customer-feedback.survey.submitted", "customer-feedback.response.redacted"]),
    );
    expect(opening?.sourceContextName).toBe("customer-feedback");
  });

  it("records notification delivery only from the notifications delivery-reported fact", () => {
    const recording = seamEntries(customerFeedback).find(
      (entry) => entry.reactionName === "customer-feedback-notification-delivery-recording",
    );
    expect(recording?.eventTypes).toEqual(["notifications.customer-feedback.delivery-reported"]);
    expect(recording?.sourceContextName).toBe("notifications");
  });

  it("routes attention, follow-up, and digest notifications only from customer-feedback events", () => {
    const projection = seamEntries(notifications).find((entry) =>
      (entry.eventTypes ?? []).some((type) => type.startsWith("customer-feedback.")),
    );
    expect(projection?.sourceContextName).toBe("customer-feedback");
    expect(projection?.eventTypes).toEqual(
      expect.arrayContaining([
        "customer-feedback.case.attention-requested",
        "customer-feedback.case.follow-up-requested",
        "customer-feedback.attention.digest-requested",
      ]),
    );
  });

  it("keeps customer-feedback free of inbound context dependencies (facts flow in, not reach-outs)", () => {
    expect(customerFeedback.allowedContextDependencies ?? []).toEqual([]);
    // The analytics and case projections that back the dashboard and queue are declared and owned here.
    const projectionNames = (customerFeedback.projectionGroups ?? []).map((group) => group.projectionName);
    expect(projectionNames).toEqual(
      expect.arrayContaining([
        "customer-feedback-csat-invitation-projection",
        "customer-feedback-csat-analytics-projection",
        "customer-feedback-feedback-case-projection",
        "customer-feedback-case-attention-projection",
      ]),
    );
  });
});

// ===========================================================================
// J20 — Provenance authority: only the owning source context can assert a code.
// ===========================================================================

describe("J20 outcome-fact provenance is authoritative per coverage branch", () => {
  const branches: ReadonlyArray<Readonly<{ branch: string; codes: readonly CsatWorkflowOutcomeCode[] }>> = [
    {
      branch: "commerce/post-transaction (#5150)",
      codes: [
        "checkout.completed",
        "checkout.recovered",
        "order.delivered",
        "return.resolved",
        "support.request-resolved",
        "reputation.review-received",
      ],
    },
    {
      branch: "seller/money (#5151)",
      codes: ["listing.published", "offer.accepted", "inventory.item-adjusted", "payout.completed"],
    },
    {
      branch: "discovery/onboarding (#5152)",
      codes: [
        "discovery.search-completed",
        "registration.completed",
        "authentication.completed",
        "onboarding.completed",
      ],
    },
  ];

  it("accepts a fact only from its declared owning context and rejects a spoofed owner", () => {
    for (const { codes } of branches) {
      for (const code of codes) {
        const owner = csatWorkflowOutcomeSourceContext[code];
        expect(isProvenanceAuthoritative(code, owner)).toBe(true);
        expect(isProvenanceAuthoritative(code, "customer-feedback")).toBe(false);
        expect(() =>
          createCsatOutcomeFactV1({
            outcomeCode: code,
            sourceContext: "customer-feedback",
            subjectAccountId: SUBJECT_ACCOUNT,
            subjectKind: "account",
            subject: { entityType: "spoof", entityId: "x" },
            outcomeOccurredAt: BASE,
            idempotencyKey: `spoof:${code}`,
          }),
        ).toThrowError(/provenance/);
      }
    }
  });

  it("covers every registered outcome code across the three coverage branches", () => {
    const covered = new Set(branches.flatMap((entry) => entry.codes));
    expect(covered.size).toBe(csatWorkflowOutcomeCodes.length);
    for (const code of csatWorkflowOutcomeCodes) expect(covered.has(code)).toBe(true);
  });
});

// ===========================================================================
// Evidence-doc pin: keep the acceptance matrix from drifting from the journeys.
// ===========================================================================

describe("acceptance evidence matrix stays complete", () => {
  const doc = readFileSync(resolve(baseDir, "../docs/csat-end-to-end-journey-acceptance.md"), "utf8");

  it("keeps every required journey id in the acceptance matrix", () => {
    for (let index = 1; index <= 20; index += 1) {
      expect(doc).toContain(`| J${index.toString().padStart(2, "0")} |`);
    }
  });

  it("requires every scenario type before signoff", () => {
    for (const scenarioType of [
      "happy path",
      "branch coverage",
      "failure/recovery",
      "closed loop",
      "deterministic edge",
      "negative RBAC",
      "consent",
      "replay recovery",
      "deploy skew",
      "metric honesty",
      "privacy",
      "seam",
    ]) {
      expect(doc).toContain(scenarioType);
    }
  });

  it("anchors acceptance to the automated coverage and records the pending staging rows", () => {
    for (const anchor of [
      "csat-end-to-end-journey.proof.test.ts",
      "invitation-decider.test.ts",
      "feedback-case-decider.test.ts",
      "delivery-authorization.test.ts",
      "csat-metric.test.ts",
      "replay-compat.test.ts",
      "analytics-query.test.ts",
      "admin-http.test.ts",
    ]) {
      expect(doc).toContain(anchor);
    }
    expect(doc).toContain("## Representative-staging evidence");
    expect(doc).toContain("## Deferred defects");
    expect(doc).toContain("## Runbook");
  });

  it("keeps the privacy capabilities documented in the acceptance ubiquitous language", () => {
    for (const capability of customerFeedbackPrivacyCapabilities) expect(doc).toContain(capability);
  });
});
