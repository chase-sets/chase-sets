// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SettlementWalletRow } from "../read-model/queries";
import type { SettlementWalletAdjustmentRow } from "../read-model/wallet-adjustment-queries";
import { SettlementWalletWorkbenchPage } from "./wallet-workbench-page";

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

describe("SettlementWalletWorkbenchPage", () => {
  it("renders a permission-denied state without leaking wallet data", () => {
    const html = renderToStaticMarkup(
      <SettlementWalletWorkbenchPage
        accountId="acc_test"
        status="permission-denied"
        adjustments={{ items: [], total: 0 }}
        adjustmentsFilters={baseAdjustmentsFilters}
        ledger={{ items: [], total: 0 }}
        ledgerFilters={baseLedgerFilters}
        actorPermissions={[]}
      />,
    );

    expect(html).toContain("permission");
    expect(html).not.toContain("Available");
  });

  it("renders a not-found state for an unopened wallet", () => {
    const html = renderToStaticMarkup(
      <SettlementWalletWorkbenchPage
        accountId="acc_missing"
        status="not-found"
        adjustments={{ items: [], total: 0 }}
        adjustmentsFilters={baseAdjustmentsFilters}
        ledger={{ items: [], total: 0 }}
        ledgerFilters={baseLedgerFilters}
        actorPermissions={[]}
      />,
    );

    expect(html).toContain("not found");
    expect(html).toContain("acc_missing");
  });

  it("renders an unavailable state on upstream failure", () => {
    const html = renderToStaticMarkup(
      <SettlementWalletWorkbenchPage
        accountId="acc_test"
        status="unavailable"
        adjustments={{ items: [], total: 0 }}
        adjustmentsFilters={baseAdjustmentsFilters}
        ledger={{ items: [], total: 0 }}
        ledgerFilters={baseLedgerFilters}
        actorPermissions={[]}
      />,
    );

    expect(html).toContain("unavailable");
  });

  it("renders an empty wallet with zero balances and empty tables", () => {
    const html = renderToStaticMarkup(
      <SettlementWalletWorkbenchPage
        accountId="acc_test"
        status="ok"
        wallet={wallet()}
        adjustments={{ items: [], total: 0 }}
        adjustmentsFilters={baseAdjustmentsFilters}
        ledger={{ items: [], total: 0 }}
        ledgerFilters={baseLedgerFilters}
        actorPermissions={["wallet-adjustments.view"]}
      />,
    );

    expect(html).toContain("$0.00");
    expect(html).toContain("No adjustments");
    expect(html).toContain("No ledger");
  });

  it("surfaces negative-balance and collections consequences without implying promotional credit", () => {
    const html = renderToStaticMarkup(
      <SettlementWalletWorkbenchPage
        accountId="acc_test"
        status="ok"
        wallet={wallet({ negative_balance_status: "collections", available_balance_amount: "-42.00" })}
        adjustments={{ items: [], total: 0 }}
        adjustmentsFilters={baseAdjustmentsFilters}
        ledger={{ items: [], total: 0 }}
        ledgerFilters={baseLedgerFilters}
        actorPermissions={["wallet-adjustments.view"]}
      />,
    );

    expect(html).toContain("Collections");
    expect(html).toContain("restricted");
    expect(html).not.toContain("bonus");
    expect(html).not.toContain("free credit");
  });

  it("renders approve/reject entry points only for a pending adjustment and matching permission", () => {
    const pending = adjustment({ status: "requested" });

    const withPermission = renderToStaticMarkup(
      <SettlementWalletWorkbenchPage
        accountId="acc_test"
        status="ok"
        wallet={wallet()}
        adjustments={{ items: [pending], total: 1 }}
        adjustmentsFilters={baseAdjustmentsFilters}
        ledger={{ items: [], total: 0 }}
        ledgerFilters={baseLedgerFilters}
        actorPermissions={["wallet-adjustments.view", "wallet-adjustments.approve"]}
      />,
    );
    expect(withPermission).toContain("Approve");
    expect(withPermission).toContain("Reject");

    const withoutPermission = renderToStaticMarkup(
      <SettlementWalletWorkbenchPage
        accountId="acc_test"
        status="ok"
        wallet={wallet()}
        adjustments={{ items: [pending], total: 1 }}
        adjustmentsFilters={baseAdjustmentsFilters}
        ledger={{ items: [], total: 0 }}
        ledgerFilters={baseLedgerFilters}
        actorPermissions={["wallet-adjustments.view"]}
      />,
    );
    expect(withoutPermission).not.toContain(">Approve<");
    expect(withoutPermission).not.toContain(">Reject<");
  });

  it("does not render the create-adjustment form without the create permission", () => {
    const html = renderToStaticMarkup(
      <SettlementWalletWorkbenchPage
        accountId="acc_test"
        status="ok"
        wallet={wallet()}
        adjustments={{ items: [], total: 0 }}
        adjustmentsFilters={baseAdjustmentsFilters}
        ledger={{ items: [], total: 0 }}
        ledgerFilters={baseLedgerFilters}
        actorPermissions={["wallet-adjustments.view"]}
      />,
    );

    expect(html).not.toContain("request-adjustment");
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

    const html = renderToStaticMarkup(
      <SettlementWalletWorkbenchPage
        accountId="acc_test"
        status="ok"
        wallet={wallet()}
        adjustments={{ items: [posted, reversal], total: 2 }}
        adjustmentsFilters={baseAdjustmentsFilters}
        ledger={{ items: [], total: 0 }}
        ledgerFilters={baseLedgerFilters}
        actorPermissions={["wallet-adjustments.view", "wallet-adjustments.reverse"]}
      />,
    );

    expect(html).toContain("wad_reversal");
    expect(html).toContain("wad_original");
    expect(html).toContain("Reversed");
  });

  it("shows a stale-projection recovery notice when a just-submitted adjustment has not converged into the list yet", () => {
    const freshSnapshot = adjustment({ adjustment_id: "wad_fresh", status: "requested" });

    const html = renderToStaticMarkup(
      <SettlementWalletWorkbenchPage
        accountId="acc_test"
        status="ok"
        wallet={wallet()}
        adjustments={{ items: [], total: 0 }}
        adjustmentsFilters={baseAdjustmentsFilters}
        ledger={{ items: [], total: 0 }}
        ledgerFilters={baseLedgerFilters}
        actorPermissions={["wallet-adjustments.view", "wallet-adjustments.create"]}
        lastAction={{ intent: "request-adjustment", snapshot: freshSnapshot }}
      />,
    );

    expect(html).toContain("wad_fresh");
    expect(html).toContain("catching up");
  });

  it("surfaces an action error banner without discarding the loaded data", () => {
    const html = renderToStaticMarkup(
      <SettlementWalletWorkbenchPage
        accountId="acc_test"
        status="ok"
        wallet={wallet()}
        adjustments={{ items: [], total: 0 }}
        adjustmentsFilters={baseAdjustmentsFilters}
        ledger={{ items: [], total: 0 }}
        ledgerFilters={baseLedgerFilters}
        actorPermissions={["wallet-adjustments.view"]}
        lastAction={{ intent: "approve-adjustment", errorMessage: "Wallet balance changed since preview." }}
      />,
    );

    expect(html).toContain("Wallet balance changed since preview.");
  });
});
