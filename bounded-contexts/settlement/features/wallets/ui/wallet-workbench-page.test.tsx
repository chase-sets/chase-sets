// @vitest-environment jsdom

import { NumericValue } from "@chase-sets/design-system";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { SettlementLedgerEntryRow, SettlementWalletRow } from "../read-model/queries";
import type { SettlementWalletAdjustmentRow } from "../read-model/wallet-adjustment-queries";
import { SettlementWalletWorkbenchPage, type SettlementWalletWorkbenchPageProps } from "./wallet-workbench-page";

function wallet(overrides: Partial<SettlementWalletRow> = {}): SettlementWalletRow {
  return {
    account_id: "acc_test",
    currency_code: "usd",
    pending_balance_amount: "0.00",
    available_balance_amount: "0.00",
    total_credited_amount: "0.00",
    total_debited_amount: "0.00",
    negative_balance_status: "in-good-standing",
    negative_balance_started_at: null,
    collections_escalated_at: null,
    opened_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function adjustment(overrides: Partial<SettlementWalletAdjustmentRow> = {}): SettlementWalletAdjustmentRow {
  return {
    adjustment_id: "wad_test",
    status: "requested",
    target_account_id: "acc_test",
    display_reference: "WAD-B2C3D4E5",
    direction: "credit",
    amount: "10.00",
    currency_code: "usd",
    reason_code: "support-resolution",
    explanation: null,
    evidence_references: [],
    reversal_of_adjustment_id: null,
    reversed_by_adjustment_id: null,
    requested_by: "usr_operator",
    requested_at: "2026-06-01T00:00:00.000Z",
    self_benefiting: false,
    approved_by: null,
    approved_at: null,
    elevation_required: false,
    elevation_reasons: [],
    elevation_approved_by: null,
    creates_or_increases_negative_balance: false,
    reversal_after_funds_settled: false,
    high_value_credit_threshold_amount: null,
    high_value_debit_threshold_amount: null,
    recent_auth_max_age_minutes: null,
    rejected_by: null,
    rejected_at: null,
    rejection_reason: null,
    posted_ledger_entry_id: null,
    posted_at: null,
    available_balance_before: null,
    available_balance_after: null,
    reversed_at: null,
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

const baseAdjustmentsFilters = { limit: 20, offset: 0 };
const baseLedgerFilters = { limit: 20, offset: 0 };

function renderWorkbench(props: Partial<SettlementWalletWorkbenchPageProps> = {}) {
  const router = createMemoryRouter(
    [
      {
        path: "/commerce/wallet-workbench/:accountId",
        element: (
          <SettlementWalletWorkbenchPage
            accountId="acc_test"
            status="ok"
            adjustments={{ items: [], total: 0 }}
            adjustmentsFilters={baseAdjustmentsFilters}
            ledger={{ items: [], total: 0 }}
            ledgerFilters={baseLedgerFilters}
            actorPermissions={[]}
            currentActorUserId="usr_actor"
            {...props}
          />
        ),
        action: async () => null,
      },
    ],
    { initialEntries: ["/commerce/wallet-workbench/acc_test"] },
  );

  render(<RouterProvider router={router} />);
}

describe("SettlementWalletWorkbenchPage", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a permission-denied state without leaking wallet data", () => {
    renderWorkbench({ status: "permission-denied" });

    expect(screen.getAllByText(/permission/i).length).toBeGreaterThan(0);
    expect(screen.queryByText("Available")).toBeNull();
  });

  it("renders a not-found state for an unopened wallet", () => {
    renderWorkbench({ accountId: "acc_missing", status: "not-found" });

    expect(screen.getByText(/not found/i)).toBeTruthy();
    expect(screen.getByText(/acc_missing/)).toBeTruthy();
  });

  it("renders an unavailable state on upstream failure", () => {
    renderWorkbench({ status: "unavailable" });

    expect(screen.getByText(/unavailable/i)).toBeTruthy();
  });

  it("renders an empty wallet and flattens balance-summary furniture", () => {
    renderWorkbench({ wallet: wallet(), actorPermissions: ["wallet-adjustments.view"] });

    expect(screen.getAllByText("$0.00").length).toBeGreaterThan(0);
    expect(screen.getByText(/No adjustments/)).toBeTruthy();
    expect(screen.getByText(/No ledger/)).toBeTruthy();
    const balanceSection = screen.getByTestId("wallet-balance-summary-furniture");
    expect(balanceSection.querySelector(".ds-glass")).toBeNull();
  });

  it("surfaces negative-balance and collections consequences without implying promotional credit", () => {
    renderWorkbench({
      wallet: wallet({ negative_balance_status: "collections", available_balance_amount: "-42.00" }),
      actorPermissions: ["wallet-adjustments.view"],
    });

    expect(screen.getAllByText("Collections").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/restricted/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/bonus/i)).toBeNull();
    expect(screen.queryByText(/free credit/i)).toBeNull();
  });

  it("renders approve/reject entry points only for a pending adjustment and matching permission", () => {
    const pending = adjustment({ requested_by: "usr_someone_else" });

    renderWorkbench({
      wallet: wallet(),
      adjustments: { items: [pending], total: 1 },
      actorPermissions: ["wallet-adjustments.view", "wallet-adjustments.approve"],
    });
    expect(screen.getAllByRole("button", { name: "Approve" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Reject" }).length).toBeGreaterThan(0);
    cleanup();

    renderWorkbench({
      wallet: wallet(),
      adjustments: { items: [pending], total: 1 },
      actorPermissions: ["wallet-adjustments.view"],
    });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("blocks the requester from approving their own pending request in the UI", () => {
    const pending = adjustment({ requested_by: "usr_actor" });

    renderWorkbench({
      wallet: wallet(),
      adjustments: { items: [pending], total: 1 },
      actorPermissions: ["wallet-adjustments.view", "wallet-adjustments.approve"],
    });

    expect(screen.getAllByText("You requested this adjustment").length).toBeGreaterThan(0);
    for (const button of screen.getAllByRole("button", { name: "Approve" })) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("does not render the create-adjustment form without the create permission", () => {
    renderWorkbench({ wallet: wallet(), actorPermissions: ["wallet-adjustments.view"] });

    expect(screen.queryByRole("button", { name: "Request preview" })).toBeNull();
  });

  it("renders the guided create form with the request-preview entry point when the operator can create", () => {
    renderWorkbench({ wallet: wallet(), actorPermissions: ["wallet-adjustments.view", "wallet-adjustments.create"] });

    expect(screen.getByRole("button", { name: "Request preview" })).toBeTruthy();
  });

  it("renders a posted adjustment and its reversal linkage for a reversed pair", () => {
    const posted = adjustment({
      adjustment_id: "wad_original",
      status: "reversed",
      posted_at: "2026-06-01T00:00:00.000Z",
      reversed_by_adjustment_id: "wad_reversal",
      available_balance_after: "10.00",
    });
    const reversal = adjustment({
      adjustment_id: "wad_reversal",
      status: "posted",
      reversal_of_adjustment_id: "wad_original",
      posted_at: "2026-06-02T00:00:00.000Z",
    });

    renderWorkbench({
      wallet: wallet(),
      adjustments: { items: [posted, reversal], total: 2 },
      actorPermissions: ["wallet-adjustments.view", "wallet-adjustments.reverse"],
    });

    expect(screen.getAllByText("wad_reversal").length).toBeGreaterThan(0);
    expect(screen.getAllByText("wad_original").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Reversed").length).toBeGreaterThan(0);
  });

  it("renders a reverse entry point for a posted adjustment with the reverse permission", () => {
    const posted = adjustment({ status: "posted", posted_at: "2026-06-01T00:00:00.000Z" });

    renderWorkbench({
      wallet: wallet(),
      adjustments: { items: [posted], total: 1 },
      actorPermissions: ["wallet-adjustments.view", "wallet-adjustments.reverse"],
    });

    expect(screen.getAllByRole("button", { name: "Reverse" }).length).toBeGreaterThan(0);
  });

  it("shows a stale-projection recovery notice when a just-submitted adjustment has not converged into the list yet", () => {
    const freshSnapshot = adjustment({ adjustment_id: "wad_fresh", status: "requested" });

    renderWorkbench({
      wallet: wallet(),
      actorPermissions: ["wallet-adjustments.view", "wallet-adjustments.create"],
      lastAction: { intent: "request-adjustment", snapshot: freshSnapshot },
    });

    expect(screen.getAllByText("wad_fresh").length).toBeGreaterThan(0);
    expect(screen.getByText(/catching up/i)).toBeTruthy();
  });

  it("renders the balance-impact preview once the operator requests one", () => {
    renderWorkbench({
      wallet: wallet({ available_balance_amount: "100.00" }),
      actorPermissions: ["wallet-adjustments.view", "wallet-adjustments.create"],
      lastAction: {
        intent: "preview-adjustment",
        values: {
          direction: "credit",
          amount: "25.00",
          reasonCode: "goodwill-cash-credit",
          explanation: "",
          evidenceReferences: [],
        },
        preview: {
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
        },
      },
    });

    expect(screen.getByText("$125.00")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm & submit" })).toBeTruthy();
  });

  it("preserves safe input after a stale preview and requires a new preview", () => {
    renderWorkbench({
      wallet: wallet({ available_balance_amount: "100.00" }),
      actorPermissions: ["wallet-adjustments.view", "wallet-adjustments.create"],
      lastAction: {
        intent: "request-adjustment",
        values: {
          direction: "debit",
          amount: "15.00",
          reasonCode: "other-with-required-detail",
          explanation: "Correct duplicate settlement credit",
          evidenceReferences: ["SUP-B2C3D4E5"],
        },
        error: {
          kind: "stale-preview",
          message: "Wallet balance changed since preview; request a new preview.",
          fieldErrors: [],
        },
      },
    });

    expect((screen.getByRole("spinbutton", { name: "Amount" }) as HTMLInputElement).value).toBe("15.00");
    expect((screen.getByLabelText("Explanation (required)") as HTMLTextAreaElement).value).toBe(
      "Correct duplicate settlement credit",
    );
    expect(screen.getByText("Balance changed since preview")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request preview" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm & submit" })).toBeNull();
  });

  it("reveals the elevated-approver field when approval requires a second, elevated approval", () => {
    const pending = adjustment({ adjustment_id: "wad_elevated", requested_by: "usr_someone_else" });

    renderWorkbench({
      wallet: wallet(),
      adjustments: { items: [pending], total: 1 },
      actorPermissions: ["wallet-adjustments.view", "wallet-adjustments.approve"],
      lastAction: {
        intent: "approve-adjustment",
        adjustmentId: "wad_elevated",
        error: {
          kind: "requires-elevated-approval",
          message: "This Wallet Adjustment requires a second, elevated approval.",
          fieldErrors: [],
        },
      },
    });

    expect(screen.getAllByText("Second approval required").length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText("Elevated approver user id").length).toBeGreaterThan(0);
  });

  it("surfaces a classified action-conflict error without discarding the loaded data", () => {
    const pending = adjustment({ requested_by: "usr_someone_else" });

    renderWorkbench({
      wallet: wallet(),
      adjustments: { items: [pending], total: 1 },
      actorPermissions: ["wallet-adjustments.view", "wallet-adjustments.approve"],
      lastAction: {
        intent: "approve-adjustment",
        adjustmentId: pending.adjustment_id,
        error: { kind: "conflict", message: "Wallet balance changed since preview.", fieldErrors: [] },
      },
    });

    expect(screen.getAllByText("Wallet balance changed since preview.").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Approve" }).length).toBeGreaterThan(0);
  });
});

/**
 * The role class is derived from a bare design-system render, never written
 * here, so this suite cannot drift from the primitive it observes.
 */
const numericValueClassName = renderToStaticMarkup(<NumericValue>0</NumericValue>).match(/class="([^"]*)"/)?.[1] ?? "";
const moneyPattern = /^-?\$[\d,]+\.\d{2}$/;

function numericValues(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll("span")].filter((span) => span.className === numericValueClassName);
}

function textsOf(elements: readonly HTMLElement[]): string[] {
  return elements.map((element) => element.textContent ?? "").sort();
}

const ledgerEntry: SettlementLedgerEntryRow = {
  ledger_entry_id: "led_workbench_1",
  account_id: "acc_test",
  kind: "sale-proceeds",
  direction: "credit",
  amount: "5.25",
  currency_code: "usd",
  funds_status: "available",
  order_id: null,
  payment_id: null,
  payout_id: null,
  description: "Sale proceeds",
  posted_at: "2026-06-01T00:00:00.000Z",
  available_at: "2026-06-01T00:00:00.000Z",
  updated_at: "2026-06-01T00:00:00.000Z",
};

describe("SettlementWalletWorkbenchPage mono market-data role carriers", () => {
  afterEach(() => {
    cleanup();
  });

  it("derives the role class from the design system", () => {
    expect(numericValueClassName).not.toBe("");
  });

  it("roles the balance summary, adjustment amounts, resulting balances, and ledger amounts, and nothing else", () => {
    const posted = adjustment({
      adjustment_id: "wad_posted",
      status: "posted",
      posted_at: "2026-06-01T00:00:00.000Z",
      available_balance_before: "25.00",
      available_balance_after: "35.00",
    });
    const pending = adjustment({ adjustment_id: "wad_pending", amount: "7.50" });

    renderWorkbench({
      wallet: wallet({
        available_balance_amount: "125.00",
        pending_balance_amount: "30.00",
        total_credited_amount: "300.00",
        total_debited_amount: "145.00",
      }),
      adjustments: { items: [posted, pending], total: 2 },
      ledger: { items: [ledgerEntry], total: 1 },
      actorPermissions: ["wallet-adjustments.view"],
    });

    const carriers = numericValues(document.body);
    const balanceSection = screen.getByTestId("wallet-balance-summary-furniture");
    const balanceCarriers = numericValues(balanceSection);

    // Four balances, then each table amount twice (desktop cell + mobile card):
    // posted amount, pending amount, posted resulting balance, ledger amount.
    expect(textsOf(carriers)).toEqual(
      [
        "$125.00",
        "$30.00",
        "$300.00",
        "$145.00",
        "$10.00",
        "$10.00",
        "$7.50",
        "$7.50",
        "$35.00",
        "$35.00",
        "$5.25",
        "$5.25",
      ].sort(),
    );
    expect(textsOf(balanceCarriers)).toEqual(["$125.00", "$145.00", "$30.00", "$300.00"]);
    for (const carrier of balanceCarriers) {
      expect(carrier.parentElement?.textContent).toBe(carrier.textContent);
    }
    for (const carrier of carriers) {
      expect(carrier.tagName).toBe("SPAN");
      expect(carrier.textContent).toMatch(moneyPattern);
    }
    const resultingBalances = carriers.filter((carrier) => carrier.textContent === "$35.00");
    expect(resultingBalances.map((carrier) => carrier.parentElement?.tagName).sort()).toEqual(["DD", "TD"]);

    // The pending adjustment has no resulting balance yet: the em dash stays unroled.
    const emDashes = screen.getAllByText("—");
    expect(emDashes.length).toBeGreaterThan(0);
    for (const emDash of emDashes) {
      expect(emDash.className).not.toBe(numericValueClassName);
      expect(numericValues(emDash)).toHaveLength(0);
    }
  });
});
