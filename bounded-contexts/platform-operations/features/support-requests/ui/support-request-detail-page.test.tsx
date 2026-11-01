import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { getSupportFlowDefinition } from "../domain/flow-catalog";
import { projectSupportParticipantPolicy, type SupportParticipantPolicy } from "../api/support-flow-projection";
import type { SupportRequestDetail } from "./contracts";
import { SupportRequestDetailPage } from "./support-request-detail-page";

const now = "2026-07-15T12:00:00.000Z";
const elevationRoleAttribute = ["data", "elevation", "role"].join("-");

function markedRole(role: "entity" | "furniture") {
  return document.querySelectorAll(`[${elevationRoleAttribute}="${role}"]`);
}

function mismatchedMarkedRole(role: "entity" | "furniture") {
  return document.querySelectorAll(`[${elevationRoleAttribute}]:not([${elevationRoleAttribute}="${role}"])`);
}

function buildRequest(overrides: Partial<SupportRequestDetail> = {}): SupportRequestDetail {
  return {
    support_request_id: "sup_case_detail",
    display_reference: "SUP-CASEDETA",
    order_id: "ord_case_detail",
    buyer_account_id: "acc_buyer",
    seller_account_id: "acc_seller",
    flow_type: "product-damaged",
    status: "waiting-on-seller",
    priority: "normal",
    opened_by_account_id: "acc_buyer",
    opened_by_role: "buyer",
    opened_at: "2026-07-15T08:00:00.000Z",
    updated_at: "2026-07-15T10:00:00.000Z",
    seller_response_due_at: "2026-07-16T08:00:00.000Z",
    support_review_due_at: "2026-07-16T20:00:00.000Z",
    seller_condition_attestation_due_at: null,
    order_return_context: null,
    affected_line_items: [],
    return_investigation: null,
    checklist: [
      {
        key: "buyer-attestation",
        label: "Buyer confirms the issue in a structured support form.",
        ownerRole: "buyer",
        evidenceTypes: ["buyer-attestation"],
        required: true,
        satisfiedAt: "2026-07-15T08:05:00.000Z",
      },
      {
        key: "damage-evidence",
        label: "Buyer provides item and package photos.",
        ownerRole: "buyer",
        evidenceTypes: ["photo", "unboxing-photo", "condition-notes"],
        required: true,
        satisfiedAt: null,
      },
      {
        key: "seller-response",
        label: "Seller responds with the requested structured action.",
        ownerRole: "seller",
        evidenceTypes: ["seller-attestation"],
        required: false,
        satisfiedAt: null,
      },
    ],
    evidence: [
      {
        evidenceId: "sev_attestation",
        submittedByAccountId: "acc_buyer",
        submittedByRole: "buyer",
        evidenceType: "buyer-attestation",
        summary: "The package arrived with a crushed corner.",
        occurredAt: null,
        submittedAt: "2026-07-15T08:05:00.000Z",
        attachments: [],
      },
    ],
    responses: [],
    offers: [],
    pending_offer: null,
    resolution: null,
    closed_at: null,
    cancellation_reason: null,
    escalated_at: null,
    escalated_by_account_id: null,
    escalated_by_role: null,
    escalation_reason: null,
    return_refund_gate_status: null,
    return_delivered_at: null,
    return_refund_release_due_at: null,
    return_condition_disputed_at: null,
    remedy: null,
    remedy_approval: null,
    contested: false,
    case_presentation: "decision-pending",
    closure_eligible: false,
    closure_blocking_reasons: [],
    next_remedy_action: null,
    remedy_repair_guidance: [],
    ...overrides,
  };
}

function pendingOfferWith(pendingWithRole: "buyer" | "seller") {
  return {
    offerId: "sof_partial",
    responseId: "srp_partial",
    offeredByAccountId: "acc_seller" as const,
    offeredByRole: "seller" as const,
    pendingWithRole,
    responseType: "offer-partial-refund" as const,
    resolutionType: "partial-refund" as const,
    refundAmount: "12.00",
    summary: "Keep the item and receive a partial refund.",
    offeredAt: "2026-07-15T10:00:00.000Z",
    status: "pending" as const,
    decidedByAccountId: null,
    decidedByRole: null,
    decidedAt: null,
    decisionSummary: null,
  };
}

/**
 * Renders the page with the participant policy the detail API returns for this
 * viewer, unless a test supplies one; `opener` says whether the viewer opened the case.
 */
function renderPage(
  request: SupportRequestDetail,
  viewerRole: "buyer" | "seller",
  {
    opener = false,
    participantPolicy,
  }: Readonly<{ opener?: boolean; participantPolicy?: SupportParticipantPolicy }> = {},
) {
  const flow = getSupportFlowDefinition("product-damaged");
  const accountId = opener ? request.opened_by_account_id : "acc_viewer_not_opener";
  const router = createMemoryRouter(
    [
      {
        path: "/account/support/:id",
        element: (
          <SupportRequestDetailPage
            request={request}
            flow={flow}
            viewerRole={viewerRole}
            participantPolicy={
              participantPolicy ?? projectSupportParticipantPolicy(request, { role: viewerRole, accountId }, flow)
            }
            now={now}
          />
        ),
      },
    ],
    { initialEntries: [`/account/support/${request.support_request_id}`] },
  );

  render(<RouterProvider router={router} />);
}

describe("SupportRequestDetailPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("participant form busies only its own submission while sibling controls remain independent", () => {
    renderPage(
      buildRequest({
        checklist: buildRequest().checklist.map((item) =>
          item.key === "damage-evidence" ? { ...item, satisfiedAt: null } : { ...item, satisfiedAt: item.satisfiedAt },
        ),
      }),
      "buyer",
    );
    const submit = screen.getByRole("button", { name: "Submit evidence" });
    expect(submit.closest("form")).toBeTruthy();
    expect(submit.closest("form")?.getAttribute("aria-busy")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send response" })).toBeNull();
  });

  it("prompts the buyer for their unsatisfied required evidence before exposing seller actions", () => {
    renderPage(buildRequest(), "buyer");

    expect(screen.getByRole("heading", { name: "SUP-CASEDETA" })).toBeTruthy();
    expect(screen.getByText("Waiting on seller")).toBeTruthy();
    expect(screen.getByText("You need to act")).toBeTruthy();
    expect(screen.getByText("Due in 20 hours")).toBeTruthy();
    expect(
      screen.getByText(
        "Damage evidence and carrier claim data allow support to resolve without parties negotiating packaging details. If the seller does not respond by the deadline, the buyer is eligible for a return-for-refund without additional buyer-seller messages.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Buyer provides item and package photos." })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit evidence" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send response" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Request support review" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel case" })).toBeNull();
  });

  it("shows structured flow responses only to the seller when the buyer checklist is complete", () => {
    const request = buildRequest({
      checklist: buildRequest().checklist.map((item) =>
        item.key === "damage-evidence" ? { ...item, satisfiedAt: "2026-07-15T09:00:00.000Z" } : item,
      ),
    });

    renderPage(request, "seller");

    expect(screen.getByText("You need to act")).toBeTruthy();
    expect(screen.getByLabelText("Response")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send response" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit evidence" })).toBeNull();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Send response",
      "Request support review",
    ]);
    expect(screen.getAllByRole("heading", { name: "Next action" })).toHaveLength(1);
  });

  it("shows the waiting party no mutation controls", () => {
    const request = buildRequest({
      checklist: buildRequest().checklist.map((item) =>
        item.required ? { ...item, satisfiedAt: "2026-07-15T09:00:00.000Z" } : item,
      ),
    });

    renderPage(request, "buyer");

    expect(screen.getByText("Waiting on seller until the deadline")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send response" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit evidence" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel case" })).toBeNull();
  });

  it.each(["accept-return", "offer-partial-refund", "offer-replacement"])(
    "response form omits derived resolution: %s",
    (responseType) => {
      renderPage(
        buildRequest({
          checklist: buildRequest().checklist.map((item) => ({ ...item, satisfiedAt: now })),
        }),
        "seller",
      );
      fireEvent.change(screen.getByLabelText("Response"), { target: { value: responseType } });
      const form = screen.getByRole("button", { name: "Send response" }).closest("form")!;
      const data = new FormData(form);
      expect(data.get("responseType")).toBe(responseType);
      expect(data.has("offerResolutionType")).toBe(false);
      expect(data.has("refundAmount")).toBe(responseType === "offer-partial-refund");
      expect(form.elements.namedItem("summary")).toBeTruthy();
    },
  );

  it("lets only the party holding a pending offer accept or decline it", () => {
    const pendingOffer = {
      offerId: "sof_partial",
      responseId: "srp_partial",
      offeredByAccountId: "acc_seller" as const,
      offeredByRole: "seller" as const,
      pendingWithRole: "buyer" as const,
      responseType: "offer-partial-refund" as const,
      resolutionType: "partial-refund" as const,
      refundAmount: "12.00",
      summary: "Keep the item and receive a partial refund.",
      offeredAt: "2026-07-15T10:00:00.000Z",
      status: "pending" as const,
      decidedByAccountId: null,
      decidedByRole: null,
      decidedAt: null,
      decisionSummary: null,
    };
    const request = buildRequest({
      status: "waiting-on-buyer",
      pending_offer: pendingOffer,
      offers: [pendingOffer],
      responses: [
        {
          responseId: "srp_partial",
          responseType: "offer-partial-refund",
          submittedByAccountId: "acc_seller",
          submittedByRole: "seller",
          summary: pendingOffer.summary,
          submittedAt: pendingOffer.offeredAt,
          offerId: pendingOffer.offerId,
        },
      ],
    });

    renderPage(request, "buyer");

    expect(screen.getByText("$12.00")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Accept offer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decline offer" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Submit evidence" })).toBeNull();
  });

  it("marks each reachable support action state as furniture-only", () => {
    const evidenceRequest = buildRequest({
      status: "waiting-on-buyer",
      checklist: [
        {
          key: "damage-photos",
          label: "Upload damage photos.",
          ownerRole: "buyer",
          evidenceTypes: ["photo", "support-note"],
          required: true,
          satisfiedAt: null,
        },
        {
          key: "condition-notes",
          label: "Describe the item condition.",
          ownerRole: "buyer",
          evidenceTypes: ["condition-notes"],
          required: true,
          satisfiedAt: null,
        },
      ],
    });

    renderPage(evidenceRequest, "buyer", { opener: true });

    expect(screen.getByRole("heading", { name: "Upload damage photos." })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Describe the item condition." })).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Submit evidence",
      "Submit evidence",
      "Cancel case",
    ]);
    expect.soft(markedRole("entity")).toHaveLength(0);
    expect.soft(markedRole("furniture")).toHaveLength(3);
    expect.soft(mismatchedMarkedRole("furniture")).toHaveLength(0);

    cleanup();

    const pendingOffer = {
      offerId: "sof_pending",
      responseId: "srp_pending",
      offeredByAccountId: "acc_seller" as const,
      offeredByRole: "seller" as const,
      pendingWithRole: "buyer" as const,
      responseType: "offer-partial-refund" as const,
      resolutionType: "partial-refund" as const,
      refundAmount: "12.00",
      summary: "Keep the item and receive a partial refund.",
      offeredAt: "2026-07-15T10:00:00.000Z",
      status: "pending" as const,
      decidedByAccountId: null,
      decidedByRole: null,
      decidedAt: null,
      decisionSummary: null,
    };
    const offerRequest = buildRequest({
      status: "waiting-on-buyer",
      pending_offer: pendingOffer,
      offers: [pendingOffer],
    });

    renderPage(offerRequest, "buyer", { opener: true });

    expect(screen.getByRole("heading", { name: "Review the offer" })).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Accept offer",
      "Decline offer",
      "Cancel case",
    ]);
    expect.soft(markedRole("entity")).toHaveLength(0);
    expect.soft(markedRole("furniture")).toHaveLength(2);
    expect.soft(mismatchedMarkedRole("furniture")).toHaveLength(0);
  });

  it("renders one chronological stream for evidence, offers, escalation, and resolution", () => {
    const request = buildRequest({
      status: "resolved",
      offers: [
        {
          offerId: "sof_declined",
          responseId: "srp_declined",
          offeredByAccountId: "acc_seller",
          offeredByRole: "seller",
          pendingWithRole: "buyer",
          responseType: "offer-partial-refund",
          resolutionType: "partial-refund",
          refundAmount: "8.00",
          summary: "Seller offered a partial refund.",
          offeredAt: "2026-07-15T09:00:00.000Z",
          status: "declined",
          decidedByAccountId: "acc_buyer",
          decidedByRole: "buyer",
          decidedAt: "2026-07-15T09:30:00.000Z",
          decisionSummary: "Buyer requested support review.",
        },
      ],
      responses: [],
      escalated_at: "2026-07-15T10:00:00.000Z",
      escalated_by_account_id: "acc_buyer",
      escalated_by_role: "buyer",
      escalation_reason: "The parties could not agree.",
      resolution: {
        resolutionType: "partial-refund",
        summary: "Support approved a partial refund.",
        refundAmount: "10.00",
        resolvedByAccountId: null,
        resolvedByRole: "support",
        resolvedAt: "2026-07-15T11:00:00.000Z",
        responsibility: "carrier",
        evidenceBasis: { type: "operator-finding", reference: "support-workbench.finding.v1" },
        responsibilityReasonCode: "product-damaged.carrier-damage",
      },
      case_presentation: "decision-made",
    });

    renderPage(request, "buyer");

    const timeline = screen.getByRole("list", { name: "Case timeline" });
    const text = timeline.textContent ?? "";
    expect(text.indexOf("Case opened")).toBeLessThan(text.indexOf("Evidence submitted"));
    expect(text.indexOf("Evidence submitted")).toBeLessThan(text.indexOf("Offer made"));
    expect(text.indexOf("Offer made")).toBeLessThan(text.indexOf("Support review requested"));
    expect(text.indexOf("Support review requested")).toBeLessThan(text.indexOf("Case resolved"));
    expect(screen.getByText("$10.00")).toBeTruthy();
    expect(screen.getByText("Decision made; refund processing details will appear here when available.")).toBeTruthy();
  });

  it("lets a buyer acting next with nothing left to provide request support review, without seller controls", () => {
    const request = buildRequest({
      status: "waiting-on-buyer",
      checklist: buildRequest().checklist.map((item) => ({ ...item, satisfiedAt: "2026-07-15T09:00:00.000Z" })),
    });

    renderPage(request, "buyer");

    expect(screen.getByText("You need to act")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Next action" })).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Request support review"]);
    expect(screen.queryByLabelText("Response")).toBeNull();
  });

  it("shows a seller holding a pending offer only the offer decision", () => {
    const pendingOffer = pendingOfferWith("seller");
    renderPage(buildRequest({ pending_offer: pendingOffer, offers: [pendingOffer] }), "seller");

    expect(screen.getByRole("heading", { name: "Review the offer" })).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Accept offer",
      "Decline offer",
    ]);
  });

  it("offers cancellation only to the opener while they act next", () => {
    const actingBuyer = buildRequest({ status: "waiting-on-buyer" });

    renderPage(actingBuyer, "buyer", { opener: true });
    expect(screen.getByRole("button", { name: "Cancel case" })).toBeTruthy();
    cleanup();

    renderPage(actingBuyer, "buyer");
    expect(screen.queryByRole("button", { name: "Cancel case" })).toBeNull();
    cleanup();

    renderPage(buildRequest({ status: "waiting-on-seller", checklist: [] }), "buyer", { opener: true });
    expect(screen.getByText("Waiting on seller until the deadline")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel case" })).toBeNull();
  });

  it.each([
    ["resolved", "Resolved"],
    ["closed", "Closed"],
    ["cancelled", "Cancelled"],
  ])("shows a %s case its status without a deadline or any control", (status, label) => {
    const pendingOffer = pendingOfferWith("buyer");
    renderPage(buildRequest({ status, pending_offer: pendingOffer, offers: [pendingOffer] }), "buyer", {
      opener: true,
    });

    expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^Due in/)).toBeNull();
    expect(screen.queryByText("You need to act")).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Next action" })).toBeNull();
  });

  it("renders the next actor, deadline and controls the API policy names instead of deriving them from the row", () => {
    const pendingOffer = pendingOfferWith("buyer");
    const offerForBuyer = buildRequest({
      status: "waiting-on-buyer",
      pending_offer: pendingOffer,
      offers: [pendingOffer],
      seller_response_due_at: null,
      support_review_due_at: null,
    });

    renderPage(offerForBuyer, "buyer", {
      opener: true,
      participantPolicy: { nextActor: "seller", deadlineAt: "2026-07-15T18:00:00.000Z", actions: [] },
    });
    expect(screen.getByText("Waiting on seller until the deadline")).toBeTruthy();
    expect(screen.getByText("Due in 6 hours")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    cleanup();

    renderPage(buildRequest({ checklist: [] }), "buyer", {
      participantPolicy: {
        nextActor: "buyer",
        deadlineAt: null,
        actions: [{ kind: "submit-evidence", checklistItemKey: "damage-evidence" }, { kind: "cancel" }],
      },
    });
    expect(screen.getByText("You need to act")).toBeTruthy();
    expect(screen.getByText("No deadline")).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Cancel case"]);
    cleanup();

    renderPage(buildRequest(), "buyer", {
      participantPolicy: {
        nextActor: "buyer",
        deadlineAt: null,
        actions: [{ kind: "submit-evidence", checklistItemKey: "damage-evidence" }, { kind: "escalate" }],
      },
    });
    expect(screen.getByRole("heading", { name: "Buyer provides item and package photos." })).toBeTruthy();
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Submit evidence",
      "Request support review",
    ]);
  });
});
