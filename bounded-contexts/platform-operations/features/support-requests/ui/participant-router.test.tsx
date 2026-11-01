import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { CHASE_SETS_COMMIT_RECEIPT_HEADER, encodeCommitReceipt } from "@chase-sets/http/responses";
import { evidenceActor } from "../domain/evidence-access-policy.test-support";
import { t } from "@chase-sets/localization";
import { getSupportFlowDefinition } from "../domain/flow-catalog";

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@chase-sets/platform-runtime/auth", async () => ({
  ...(await vi.importActual("@chase-sets/platform-runtime/auth")),
  requireActorFromAuthApi: auth,
}));
import Route, { action, loader } from "../../../routes/marketplace/account-support-detail";

const actor = evidenceActor("viewer", ["support.view", "support.manage"]);
import { supportParticipantDetailFixture as detail, withParticipantPolicy } from "./participant-router.test-data";
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
  it("actual seller CurrencyInput form sends one normalized partial-refund attempt and redirects with its receipt", async () => {
    auth.mockResolvedValue({ ...actor, accountId: "acc_seller" });
    let reflected = false;
    const token = encodeCommitReceipt([
      { sourceContextName: "platform-operations", maxGlobalPosition: "42", eventIds: ["evt_offer"] },
    ]);
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "POST") {
        reflected = true;
        return new Response(JSON.stringify({ id: "sup_router", version: 3, status: "response-recorded" }), {
          headers: { [CHASE_SETS_COMMIT_RECEIPT_HEADER]: token, "Chase-Sets-Consistency": "eventual" },
        });
      }
      return new Response(
        JSON.stringify(
          withParticipantPolicy(
            {
              ...detail(),
              checklist: [],
              flow_type: "product-damaged",
              flow: getSupportFlowDefinition("product-damaged"),
              status: reflected ? "waiting-on-buyer" : "waiting-on-seller",
            },
            "acc_seller",
          ),
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const router = mount();
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByLabelText(t("support.features.supportRequests.ui.supportRequestDetailPage.response.type")),
      "offer-partial-refund",
    );
    const amount = await screen.findByLabelText(
      t("support.features.supportRequests.ui.supportRequestDetailPage.response.refundAmount"),
    );
    await user.clear(amount);
    await user.type(amount, "5.00");
    await user.type(
      screen.getByLabelText(t("support.features.supportRequests.ui.supportRequestDetailPage.response.summary")),
      "Keep the item and receive a partial refund.",
    );
    expect(new FormData(amount.closest("form")!).get("refundAmount")).toBe("5");
    await user.click(
      screen.getByRole("button", {
        name: t("support.features.supportRequests.ui.supportRequestDetailPage.response.submit"),
      }),
    );
    await waitFor(() => expect(router.state.location.search).toContain("action=response"));
    expect(router.state.location.search).toContain("afterWrite");
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    router.dispose();
  });
  it("participant form busies only its own submission without disabling, suppresses a second submit, and recovers ambiguity", async () => {
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
      return new Response(JSON.stringify(withParticipantPolicy(request, "acc_buyer")), {
        headers: { "content-type": "application/json" },
      });
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
    const pendingSubmit = screen.getByRole("button", {
      name: t("support.features.supportRequests.ui.supportRequestDetailPage.evidence.submit"),
    });
    await waitFor(() => {
      expect(pendingSubmit.closest("form")?.getAttribute("aria-busy")).toBe("true");
      expect(pendingSubmit.matches(":disabled")).toBe(false);
    });
    await user.click(pendingSubmit);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    await waitFor(() => expect(release).toBeDefined());
    release!();
    const announcement = await screen.findByRole("heading", { name: t("support.participantAttempt.checkBeforeRetry") });
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
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
    await router.revalidate();
    await waitFor(() => expect(router.state.revalidation).toBe("idle"));
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(posts);
    expect(document.querySelector('[name="participantRecovery"]')).toBeNull();
    router.dispose();
  });
});
