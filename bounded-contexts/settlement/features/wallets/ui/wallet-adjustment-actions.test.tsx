// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, type ActionFunctionArgs } from "react-router";
import type { SettlementWalletAdjustment, SettlementWalletAdjustmentPreview } from "../../../client";
import { WalletAdjustmentApprovalActions } from "./wallet-adjustment-approval-actions";
import { WalletAdjustmentGuidedFlowForm } from "./wallet-adjustment-guided-flow";
import { WalletAdjustmentReversalActions } from "./wallet-adjustment-reversal-actions";
import { walletAdjustmentReauthenticationHref } from "./wallet-adjustment-reauthentication-link";

const preview: SettlementWalletAdjustmentPreview = {
  target_account_id: "acc_test",
  direction: "credit",
  amount: "25.00",
  currency_code: "usd",
  reason_code: "goodwill-cash-credit",
  balance_revision: "wbr_1",
  available_balance_before: "100.00",
  available_balance_after: "125.00",
  pending_balance_amount: "0.00",
  cash_equivalent: true,
  spendable: true,
  payoutable: true,
  negative_balance_status: "in-good-standing",
  creates_or_increases_negative_balance: false,
  high_value: false,
  self_benefiting: false,
  blocked_reason: null,
  requires_second_approval: false,
  elevation_reasons: [],
  controls: {
    high_value_credit_threshold_amount: "500.00",
    high_value_debit_threshold_amount: "500.00",
    recent_auth_max_age_minutes: 15,
  },
};

function adjustment(overrides: Partial<SettlementWalletAdjustment> = {}): SettlementWalletAdjustment {
  return {
    adjustment_id: "wad_test",
    status: "requested",
    target_account_id: "acc_test",
    display_reference: "WAD-B2C3D4E5",
    direction: "credit",
    amount: "25.00",
    currency_code: "usd",
    reason_code: "goodwill-cash-credit",
    explanation: "Service recovery",
    evidence_references: ["SUP-B2C3D4E5"],
    reversal_of_adjustment_id: null,
    reversed_by_adjustment_id: null,
    requested_by: "usr_requester",
    requested_at: "2026-07-14T00:00:00.000Z",
    self_benefiting: false,
    approved_by: null,
    approved_at: null,
    elevation_required: false,
    elevation_reasons: [],
    elevation_approved_by: null,
    creates_or_increases_negative_balance: false,
    reversal_after_funds_settled: false,
    high_value_credit_threshold_amount: "500.00",
    high_value_debit_threshold_amount: "500.00",
    recent_auth_max_age_minutes: 15,
    rejected_by: null,
    rejected_at: null,
    rejection_reason: null,
    posted_ledger_entry_id: null,
    posted_at: null,
    available_balance_before: null,
    available_balance_after: null,
    reversed_at: null,
    updated_at: "2026-07-14T00:00:00.000Z",
    ...overrides,
  };
}

function renderWithAction(element: React.ReactNode) {
  const submissions: FormData[] = [];
  const action = vi.fn(async ({ request }: ActionFunctionArgs) => {
    submissions.push(await request.formData());
    return null;
  });
  const router = createMemoryRouter([{ path: "/", element, action }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
  return { action, submissions };
}

describe("wallet adjustment action forms", () => {
  afterEach(cleanup);

  it("submits the guided flow with tinted form furniture and an elevated preview entity", async () => {
    const user = userEvent.setup();
    const { action, submissions } = renderWithAction(
      <WalletAdjustmentGuidedFlowForm
        targetAccountId="acc_test"
        targetAccountLabel="Test Account"
        currencyCode="usd"
        preview={preview}
        flowError={null}
        defaultValues={{
          direction: "credit",
          amount: "25.00",
          reasonCode: "goodwill-cash-credit",
          explanation: "Service recovery",
          evidenceReferences: ["SUP-B2C3D4E5"],
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Request preview" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(submissions[0]?.get("intent")).toBe("preview-adjustment");

    await user.click(screen.getByRole("button", { name: "Confirm & submit" }));
    await user.click(screen.getByRole("button", { name: "Submit adjustment" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(submissions[1]?.get("intent")).toBe("request-adjustment");
    expect(submissions[1]?.get("expectedBalanceRevision")).toBe("wbr_1");
    expect(screen.getByTestId("wallet-adjustment-form-furniture").className).toBe(
      "rounded-tokenLg overflow-hidden bg-surface-2 p-4",
    );
    expect(screen.getByTestId("wallet-adjustment-preview-entity").className).toBe(
      "ds-glass rounded-tokenLg border border-muted shadow-tokenSm overflow-hidden p-4",
    );
  });

  it("submits approve and reject intents only after explicit confirmation", async () => {
    const user = userEvent.setup();
    const { action, submissions } = renderWithAction(
      <WalletAdjustmentApprovalActions
        adjustment={adjustment()}
        targetAccountLabel="Test Account"
        returnTo="/commerce/wallet-workbench/acc_test"
        currentActorUserId="usr_approver"
        flowError={null}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(action).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Approve & post" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(submissions[0]?.get("intent")).toBe("approve-adjustment");

    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.type(screen.getByLabelText("Rejection reason (optional)"), "Duplicate request");
    await user.click(screen.getByRole("button", { name: "Reject adjustment" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(submissions[1]?.get("intent")).toBe("reject-adjustment");
    expect(submissions[1]?.get("rejectionReason")).toBe("Duplicate request");
  });

  it("submits reversal approvers and explanation through the reversal intent", async () => {
    const user = userEvent.setup();
    const { action, submissions } = renderWithAction(
      <WalletAdjustmentReversalActions
        adjustment={adjustment({ status: "posted", posted_at: "2026-07-14T00:01:00.000Z" })}
        targetAccountLabel="Test Account"
        returnTo="/commerce/wallet-workbench/acc_test"
        flowError={null}
      />,
    );

    await user.type(screen.getByLabelText("Approver user id"), "usr_approver");
    await user.type(screen.getByLabelText("Elevated approver user id"), "usr_elevated");
    await user.type(screen.getByLabelText("Reversal reason (optional)"), "Correction requested");
    await user.click(screen.getByRole("button", { name: "Reverse" }));
    expect(action).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Reverse adjustment" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries(submissions[0]!.entries())).toMatchObject({
      intent: "reverse-adjustment",
      approvedByUserId: "usr_approver",
      elevationApprovedByUserId: "usr_elevated",
      explanation: "Correction requested",
    });
  });

  it("offers a safe reauthentication handoff that preserves the current page in its original tab", () => {
    renderWithAction(
      <WalletAdjustmentGuidedFlowForm
        targetAccountId="acc_test"
        targetAccountLabel="Test Account"
        currencyCode="usd"
        preview={null}
        flowError={{ kind: "step-up-required", message: "Confirm it is you.", fieldErrors: [] }}
      />,
    );

    const link = screen.getByRole("link", { name: "Sign in again in a new tab" });
    expect(link.getAttribute("href")).toBe(walletAdjustmentReauthenticationHref("/commerce/wallet-workbench/acc_test"));
    expect(link.getAttribute("target")).toBe("_blank");
  });
});
