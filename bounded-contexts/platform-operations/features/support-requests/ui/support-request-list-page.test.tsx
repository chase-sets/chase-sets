import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { getSupportFlowDefinition, supportFlowCatalog } from "../domain/flow-catalog";
import { SupportRequestListPage } from "./support-request-list-page";
import { File as NodeFile } from "node:buffer";
import MarketplaceAccountSupportRoute, { action, loader } from "../../../routes/marketplace/account-support";
import AccountSupportDetailRoute, { loader as detailLoader } from "../../../routes/marketplace/account-support-detail";
import { supportParticipantDetailFixture, withParticipantPolicy } from "./participant-router.test-data";
import { multipartRequest, nativeFormData } from "../tests/attachment-intake.test-support";
import { formatDateTime } from "@chase-sets/localization";

vi.mock("@chase-sets/platform-runtime/auth", () => ({
  requireActorFromAuthApi: vi.fn(async () => ({ accountId: "acc_buyer", tenantId: "tnt_identity" })),
}));
const BrowserFile = File;

function renderPage(
  supportOrder: Parameters<typeof SupportRequestListPage>[0]["supportOrder"] = null,
  buyerRequests: Parameters<typeof SupportRequestListPage>[0]["buyerRequests"] = [],
  sellerRequests: Parameters<typeof SupportRequestListPage>[0]["sellerRequests"] = [],
) {
  const router = createMemoryRouter(
    [
      {
        path: "/account/support",
        element: (
          <SupportRequestListPage
            flows={supportFlowCatalog}
            buyerRequests={buyerRequests}
            sellerRequests={sellerRequests}
            supportOrder={supportOrder}
          />
        ),
      },
    ],
    { initialEntries: ["/account/support"] },
  );

  render(<RouterProvider router={router} />);
}

// Resolves on the router's own completion event instead of a findBy*/waitFor polling window. Support
// actions hash through WebCrypto, which settles off the JS thread, so the action outlives act() and
// a loaded host can exceed the default 1000 ms window (#9533).
function navigationSettled(router: ReturnType<typeof createMemoryRouter>) {
  let busy = router.state.navigation.state !== "idle";
  return new Promise<void>((resolve) => {
    const unsubscribe = router.subscribe((state) => {
      if (state.navigation.state !== "idle") busy = true;
      else if (busy) {
        unsubscribe();
        resolve();
      }
    });
  });
}

const buyerOrder = {
  orderId: "ord_1",
  openedByRole: "buyer" as const,
  status: "ready-for-fulfillment",
  totalAmount: "35.00",
  lines: [
    {
      lineId: "line_1",
      itemTitle: "Charizard",
      productSummary: "Near mint",
      quantity: 1,
      amount: "20.00",
      currencyCode: "USD",
    },
    {
      lineId: "line_2",
      itemTitle: "Pikachu",
      productSummary: null,
      quantity: 2,
      amount: "15.00",
      currencyCode: "USD",
    },
  ],
};

describe("SupportRequestListPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  for (const failure of ["ambiguous", "denied", "rejected", "conflict", "submit-conflict"] as const) {
    it(`participant form busies only its own submission: ${failure} retains one batch and changes it only explicitly`, async () => {
      vi.stubGlobal("File", NodeFile);
      const user = userEvent.setup();
      const uploadIds: string[] = [];
      let opened = false;
      let failing = true;
      let releaseUpload: (() => void) | undefined;
      const pause = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });
      let markUploadDispatched: (() => void) | undefined;
      const uploadDispatched = new Promise<void>((resolve) => {
        markUploadDispatched = resolve;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const json = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
          if (url.endsWith("/flows")) return json({ items: supportFlowCatalog });
          if (url.endsWith("/purchases") || url.endsWith("/sales")) return json({ items: [] });
          if (url.endsWith("/support-requests/sup_1"))
            return json(
              withParticipantPolicy(
                {
                  ...supportParticipantDetailFixture(),
                  support_request_id: "sup_1",
                  order_id: "ord_1",
                  display_reference: "SUP-OPENED",
                  flow_type: "product-damaged",
                  flow: getSupportFlowDefinition("product-damaged"),
                  status: "waiting-on-seller",
                  checklist: [],
                  evidence: [
                    {
                      evidenceId: "sev_opening",
                      evidenceType: "photo",
                      summary: "Opening photos recorded",
                      submittedByRole: "buyer",
                      submittedAt: "2026-10-12T12:01:00.000Z",
                      attachments: [],
                    },
                  ],
                },
                "acc_buyer",
              ),
            );
          if (url.endsWith("/orders/ord_1"))
            return json({
              ...buyerOrder,
              existingOpenRequest: opened
                ? { supportRequestId: "sup_1", flowType: "product-damaged", status: "awaiting-evidence" }
                : null,
            });
          if (url.endsWith("/support-requests")) {
            if (failing && failure === "submit-conflict") return json({ error: { message: "Submit conflict" } }, 409);
            opened = true;
            return json({ id: "sup_1" }, 201);
          }
          if (url.endsWith("/attachments")) {
            uploadIds.push(new Headers(init?.headers).get("x-support-attachment-operation-id")!);
            if (uploadIds.length === 1) {
              markUploadDispatched!();
              await pause;
            }
            if (failing && failure === "ambiguous") throw new Error("Connection lost after upload");
            if (failing && failure !== "submit-conflict")
              return json(
                { error: { message: failure } },
                failure === "denied" ? 403 : failure === "rejected" ? 413 : 409,
              );
            return json({ attachments: [{ reference: `support-attachment:v1:sea_original:${"a".repeat(64)}:jpg` }] });
          }
          if (url.includes("/participant-attempts/")) return json({ outcome: "not-recorded" });
          if (url.endsWith("/evidence"))
            return failing ? json({ error: { message: "Submit conflict" } }, 409) : json({ id: "sup_1" });
          throw new Error(`Unexpected fixture URL ${url}`);
        }),
      );
      const snapshot: { form: FormData | null } = { form: null };
      const capture = (event: Event) => {
        const form = event.target as HTMLFormElement;
        snapshot.form = new FormData(form);
        // userEvent's FileList is visible on the input, but not in jsdom's internal form encoder.
        const input = form.querySelector<HTMLInputElement>('input[type="file"]');
        snapshot.form.delete("attachments");
        for (const file of input?.files ?? []) snapshot.form.append(input!.name, file);
      };
      document.addEventListener("submit", capture, true);
      const router = createMemoryRouter(
        [
          {
            path: "/account/support",
            element: <MarketplaceAccountSupportRoute />,
            loader,
            action: async (args) => {
              // Adapt jsdom's browser form to native HTTP ingress, retaining every actual form field.
              const native = await nativeFormData();
              for (const [key, value] of snapshot.form!.entries()) {
                if (typeof value === "string") native.append(key, value);
                else {
                  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result as ArrayBuffer);
                    reader.onerror = reject;
                    reader.readAsArrayBuffer(value);
                  });
                  native.append(key, new File([bytes], value.name, { type: value.type }));
                }
              }
              return action({ ...args, request: await multipartRequest(args.request.url, native) });
            },
          },
          { path: "/account/support/:id", loader: detailLoader, element: <AccountSupportDetailRoute /> },
        ],
        { initialEntries: ["/account/support?orderId=ord_1"] },
      );
      try {
        render(<RouterProvider router={router} />);
        await screen.findByRole("heading", { name: "Support" });
        await user.click(screen.getByRole("checkbox", { name: /Charizard/ }));
        await user.click(screen.getByRole("button", { name: "Continue" }));
        await user.click(screen.getByRole("radio", { name: /Product arrived damaged/ }));
        await user.click(screen.getByRole("button", { name: "Continue" }));
        const field = () => document.querySelector<HTMLInputElement>('input[name="attachmentOperationId"]')!;
        const originalId = field().value;
        expect(originalId).toMatch(/^sao_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
        const photo = new BrowserFile(["original"], "photo.jpg", { type: "image/jpeg" });
        await user.upload(screen.getByLabelText("Add evidence photos"), photo);
        expect((screen.getByLabelText("Add evidence photos") as HTMLInputElement).files?.length).toBe(1);
        expect(screen.getByLabelText("Add evidence photos").hasAttribute("required")).toBe(true);
        // jsdom does not recognize userEvent's FileList for native required-file validation.
        fireEvent.submit(screen.getByRole("button", { name: "Open case" }).closest("form")!);
        expect(snapshot.form?.get("attachments")).toMatchObject({ name: "photo.jpg" });
        expect(router.state.errors).toBeNull();
        await act(() => uploadDispatched);
        expect(uploadIds).toEqual([originalId]);
        expect(document.querySelector("form")?.getAttribute("aria-busy")).toBe("true");
        expect(screen.getByRole("button", { name: "Open case" }).matches(":disabled")).toBe(false);
        fireEvent.submit(screen.getByRole("button", { name: "Open case" }).closest("form")!);
        expect(uploadIds).toEqual([originalId]);
        const released = navigationSettled(router);
        await act(async () => {
          releaseUpload!();
          await released;
        });
        // Discriminating control, read once the action has settled: visible retry guidance, the
        // retained batch id and exactly one dispatched upload. The new-batch action renders only for a
        // recovered id; without it the field would fall back to the panel's initial id, which is also
        // originalId.
        expect(
          screen.getByText("Retry the same photos (re-select the same files if needed), or start a new photo batch."),
        ).toBeTruthy();
        expect(screen.getByRole("button", { name: "Start a new photo batch" })).toBeTruthy();
        expect(field().value).toBe(originalId);
        expect(uploadIds).toEqual([originalId]);
        expect(document.querySelector("form")?.getAttribute("aria-busy")).toBeNull();
        expect(document.querySelector<HTMLInputElement>('input[name="supportRequestId"]')).toBeNull();
        expect(screen.queryByText("You already have an open case for this order")).toBeNull();
        if (failure === "submit-conflict") {
          const status = screen.getByRole("heading", {
            name: "Check status before retrying this support action.",
          });
          expect(status.textContent).toContain("Check status before retrying");
          expect(screen.getByRole("button", { name: "Open case" }).matches(":disabled")).toBe(true);
          expect(screen.getByRole("button", { name: "Start a new photo batch" }).matches(":disabled")).toBe(true);
          const checked = navigationSettled(router);
          await user.click(screen.getByRole("button", { name: "Check status" }));
          await act(() => checked);
          expect(uploadIds).toEqual([originalId]);
          expect(
            screen
              .getByRole("heading", { name: "Check status before retrying this support action." })
              .closest('[role="status"]')
              ?.getAttribute("aria-live"),
          ).toBe("polite");
          return;
        }
        // Re-selection and retry preserve the id. Ambiguity never dispatches again.
        await user.upload(screen.getByLabelText("Add evidence photos"), photo);
        const retried = navigationSettled(router);
        fireEvent.submit(screen.getByRole("button", { name: "Open case" }).closest("form")!);
        await act(() => retried);
        expect(document.querySelector("form")?.getAttribute("aria-busy")).toBeNull();
        expect(field().value).toBe(originalId);
        expect(uploadIds).toEqual(failure === "ambiguous" ? [originalId] : [originalId, originalId]);
        await user.click(screen.getByRole("button", { name: "Start a new photo batch" }));
        const freshId = field().value;
        expect(freshId).not.toBe(originalId);
        expect(document.querySelector<HTMLInputElement>('input[name="supportRequestId"]')).toBeNull();
        expect(document.querySelector('input[name="uploadedAttachmentReferences"]')).toBeNull();
        expect(document.querySelector<HTMLInputElement>('input[name="uploadUncertain"]')?.value).toBe("false");
        failing = false;
        await user.upload(
          screen.getByLabelText("Add evidence photos"),
          new BrowserFile(["changed"], "changed.jpg", { type: "image/jpeg" }),
        );
        const submitted = navigationSettled(router);
        fireEvent.submit(screen.getByRole("button", { name: "Open case" }).closest("form")!);
        await act(() => submitted);
        expect(router.state.location.pathname).toBe("/account/support/sup_1");
        expect(uploadIds.at(-1)).toBe(freshId);
        expect(screen.getByText("Opening photos recorded")).toBeTruthy();
        expect(document.querySelector('[name="participantRecovery"]')).toBeNull();
      } finally {
        document.removeEventListener("submit", capture, true);
        router.dispose();
      }
    });
  }

  it("removes raw order and role lookup from marketplace support", () => {
    renderPage();

    expect(screen.queryByLabelText("Order ID")).toBeNull();
    expect(screen.queryByLabelText("Opening as")).toBeNull();
    expect(screen.queryByRole("button", { name: "Find order" })).toBeNull();
    expect(screen.getByRole("link", { name: "View purchases" }).getAttribute("href")).toBe("/account/purchases");
    expect(screen.getByRole("link", { name: "View sales" }).getAttribute("href")).toBe("/account/sales");
  });

  it("guides a buyer through affected lines, plain-language issue selection, and outcome preview", async () => {
    const user = userEvent.setup();
    renderPage(buyerOrder);

    expect(screen.getAllByText("Choose items")).toHaveLength(2);
    expect(screen.queryByText("buyer")).toBeNull();
    expect(document.querySelector('input[name="openedByRole"]')).toBeNull();

    await user.click(screen.getByRole("checkbox", { name: /Charizard/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await user.click(screen.getByRole("radio", { name: /Product not as described/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    const submit = screen.getByRole("button", { name: "Open case" });
    const form = submit.closest("form");
    expect(form).toBeTruthy();
    const intake = within(form!);
    expect(intake.getAllByText("Review outcome")).toHaveLength(2);
    expect(intake.getByText("Product not as described")).toBeTruthy();
    expect(intake.getByText("Return for refund")).toBeTruthy();
    expect(intake.getByText("48 hours")).toBeTruthy();
    expect(intake.getByText(/If the seller does not respond by the deadline/)).toBeTruthy();
    expect(intake.getByLabelText("Add evidence photos")).toBeTruthy();
    expect(intake.getByLabelText("Add evidence photos").hasAttribute("required")).toBe(true);
    expect(form?.getAttribute("enctype")).toBe("multipart/form-data");
    expect(intake.getByText("Report item problems within 30 days of delivery.")).toBeTruthy();
    expect(intake.getByRole("link", { name: "Read Order Protection terms" }).getAttribute("href")).toBe(
      "/help/buying/order-protection",
    );
    expect(
      Array.from(document.querySelectorAll<HTMLInputElement>('input[name="affectedLineIds"]')).map(
        (input) => input.value,
      ),
    ).toEqual(["line_1"]);
  });

  it("offers seller-cannot-fulfill from a sale-owned order without a role control", async () => {
    const user = userEvent.setup();
    renderPage({
      ...buyerOrder,
      openedByRole: "seller",
      lines: [buyerOrder.lines[0]],
    });

    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("radio", { name: /Seller cannot fulfill/ })).toBeTruthy();
    expect(screen.queryByLabelText("Opening as")).toBeNull();
  });

  it("blocks another case for the order and links to the existing case summary", () => {
    renderPage({
      ...buyerOrder,
      existingOpenRequest: {
        supportRequestId: "sup_existing",
        displayReference: "SUP-EXISTING",
        flowType: "product-damaged",
        status: "waiting-on-seller",
      },
    });

    expect(screen.getByText("A case is already open for this order")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View existing case" }).getAttribute("href")).toBe(
      "#existing-support-request",
    );
    expect(screen.getByText("SUP-EXISTING")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open case" })).toBeNull();
  });

  it("links buyer and seller rows to the participant-scoped case detail page", () => {
    const request = {
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
      updated_at: "2026-07-15T08:00:00.000Z",
      seller_response_due_at: "2026-07-17T08:00:00.000Z",
      support_review_due_at: "2026-07-16T08:00:00.000Z",
      seller_condition_attestation_due_at: null,
      order_return_context: null,
      affected_line_items: [],
      return_investigation: null,
      checklist: [],
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
      case_presentation: "decision-pending" as const,
      closure_eligible: false,
      closure_blocking_reasons: [],
      next_remedy_action: null,
      remedy_repair_guidance: [],
      customerRemedyStatus: null,
      nextDeadline: "2026-07-17T08:00:00.000Z",
    };

    const projection = {
      state: "completed" as const,
      terminal: true,
      role: "buyer" as const,
      outcome: "fullRefund" as const,
      coverage: "full" as const,
      noFaultFinding: false,
      returnDirective: "no-return" as const,
      refundTrigger: "immediate" as const,
      nextAction: null,
      amount: "5.00",
      currencyCode: "usd",
      sellerAmount: "0.00",
      platformAmount: "5.00",
      allocationCurrencyCode: "usd",
    };
    const nextDeadline = "2026-07-30T08:00:00.000Z";
    renderPage(
      null,
      [{ ...request, nextDeadline, customerRemedyStatus: projection }],
      [
        {
          ...request,
          nextDeadline,
          customerRemedyStatus: {
            ...projection,
            role: "seller",
            outcome: "completedCovered",
            coverage: null,
            noFaultFinding: true,
          },
        },
      ],
    );

    const links = screen.getAllByRole("link", { name: "SUP-CASEDETA" });
    expect(links).toHaveLength(4);
    expect(links.every((link) => link.getAttribute("href") === "/account/support/sup_case_detail")).toBe(true);
    expect(screen.getAllByText("Full refund of $5.00 approved.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Seller charge: $0.00. Chase Sets covered $5.00.").length).toBeGreaterThan(0);
    expect(screen.getAllByText(formatDateTime(nextDeadline, { preset: "short" })).length).toBeGreaterThan(0);
  });
});
