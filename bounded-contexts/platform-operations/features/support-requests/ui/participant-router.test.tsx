import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { CHASE_SETS_COMMIT_RECEIPT_HEADER, encodeCommitReceipt } from "@chase-sets/http/responses";
import { evidenceActor } from "../domain/evidence-access-policy.test-support";
import { t } from "@chase-sets/localization";

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@chase-sets/platform-runtime/auth", async () => ({
  ...(await vi.importActual("@chase-sets/platform-runtime/auth")),
  requireActorFromAuthApi: auth,
}));
import Route, { action, loader } from "../../../routes/marketplace/account-support-detail";

const actor = evidenceActor("viewer", ["support.view", "support.manage"]);
function detail() {
  return {
    support_request_id: "sup_router",
    display_reference: "SUP-ROUTER",
    order_id: "ord_router",
    buyer_account_id: actor.accountId,
    seller_account_id: "acc_seller",
    flow_type: "product-not-received",
    status: "waiting-on-buyer",
    priority: "normal",
    opened_by_account_id: actor.accountId,
    opened_by_role: "buyer",
    opened_at: "2026-10-12T12:00:00.000Z",
    updated_at: "2026-10-12T12:00:00.000Z",
    seller_response_due_at: null,
    support_review_due_at: null,
    seller_condition_attestation_due_at: null,
    order_return_context: [],
    affected_line_items: [],
    return_investigation: null,
    checklist: [
      {
        key: "attestation",
        label: "Confirm no delivery",
        ownerRole: "buyer",
        evidenceTypes: ["buyer-attestation"],
        required: true,
        satisfiedAt: null,
      },
    ],
    evidence: [],
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
  };
}
function mount() {
  const router = createMemoryRouter([{ path: "/account/support/:id", loader, action, element: <Route /> }], {
    initialEntries: ["/account/support/sup_router"],
  });
  render(<RouterProvider router={router} />);
  return router;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("real-router transition/accessibility/reload matrix", () => {
  it("actual submit disables busy, lost response announces/focuses ambiguity, check-status token drives second loader and authoritative timeline", async () => {
    auth.mockResolvedValue(actor);
    let release: (() => void) | undefined;
    let check = false;
    let reflected = false;
    const reads: string[] = [];
    const token = encodeCommitReceipt([
      { sourceContextName: "platform-operations", maxGlobalPosition: "42", eventIds: ["evt_first"] },
    ]);
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "POST") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        throw new Error("lost after dispatch");
      }
      if (String(url).includes("participant-attempts")) {
        if (!check) return new Response(JSON.stringify({ outcome: "not-recorded" }));
        reflected = true;
        return new Response(
          JSON.stringify({
            outcome: "confirming",
            actionKind: "submit-evidence",
            result: {
              id: "sup_router",
              version: 3,
              status: "evidence-submitted",
              evidenceId: "sev_first",
              responseId: null,
              offerId: null,
            },
          }),
          { headers: { [CHASE_SETS_COMMIT_RECEIPT_HEADER]: token, "Chase-Sets-Consistency": "eventual" } },
        );
      }
      reads.push(String(url));
      const request = detail();
      if (reflected) {
        request.checklist[0].satisfiedAt = "2026-10-12T12:01:00.000Z" as never;
        request.evidence = [
          {
            evidenceId: "sev_first",
            evidenceType: "buyer-attestation",
            summary: "No delivery recorded",
            submittedByRole: "buyer",
            submittedAt: "2026-10-12T12:01:00.000Z",
            attachments: [],
          },
        ] as never;
      }
      return new Response(JSON.stringify(request), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = mount();
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText(t("support.features.supportRequests.ui.supportRequestDetailPage.evidence.summary")),
      "No delivery recorded",
    );
    const submit = screen.getByRole("button", {
      name: t("support.features.supportRequests.ui.supportRequestDetailPage.evidence.submit"),
    });
    expect(reads).toHaveLength(1);
    expect(screen.queryByText("No delivery recorded")).toBeNull();
    await user.click(submit);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", {
            name: t("support.features.supportRequests.ui.supportRequestDetailPage.evidence.submit"),
          })
          .matches(":disabled"),
      ).toBe(true),
    );
    await waitFor(() => expect(release).toBeDefined());
    release!();
    const announcement = await screen.findByText(t("support.participantAttempt.checkBeforeRetry"));
    expect(announcement.getAttribute("role")).toBe("status");
    expect(announcement.getAttribute("aria-live")).toBe("polite");
    expect(announcement.textContent).toContain("Check status before retrying");
    await waitFor(() => expect(document.activeElement).toBe(announcement));
    expect(
      screen
        .getByRole("button", {
          name: t("support.features.supportRequests.ui.supportRequestDetailPage.evidence.submit"),
        })
        .matches(":disabled"),
    ).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(screen.queryByText("Evidence submitted", { exact: true })).toBeNull();
    check = true;
    await user.click(screen.getByRole("button", { name: "Check status" }));
    await screen.findByText("No delivery recorded");
    await waitFor(() => expect(screen.queryByText(t("support.participantAttempt.checkBeforeRetry"))).toBeNull());
    expect(reads.length).toBeGreaterThan(1);
    expect(router.state.location.search).toContain("afterWrite");
    expect(router.state.location.search).toContain("action=evidence");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST").length;
    router.revalidate();
    await waitFor(() => expect(router.state.revalidation).toBe("idle"));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(posts);
    expect(document.querySelector('[name="participantRecovery"]')).toBeNull();
    router.dispose();
  });
});
