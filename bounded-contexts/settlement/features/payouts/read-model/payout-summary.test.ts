import { describe, expect, it, vi } from "vitest";
import { moneyStatusDetails } from "@chase-sets/http/money-status";
import type { SettlementPayoutReadinessRow } from "../../payout-readiness/read-model/queries";
import type { SettlementWalletRow } from "../../wallets/read-model/queries";
import { listPayoutSummaryRows } from "./queries";
import {
  PAYOUT_SUMMARY_HARD_CAP,
  buildPayoutAvailability,
  buildPayoutSummary,
  selectBlockedPayoutSummaryRows,
  selectNextPayoutSummary,
} from "./payout-summary";
import type { SettlementPayoutRow } from "./queries";

const wallet: SettlementWalletRow = {
  account_id: "acct-1",
  currency_code: "usd",
  available_balance_amount: "25.00",
  pending_balance_amount: "0.00",
  total_credited_amount: "25.00",
  total_debited_amount: "0.00",
  negative_balance_status: "in-good-standing",
  negative_balance_started_at: null,
  collections_escalated_at: null,
  opened_at: null,
  updated_at: null,
};

const readiness: SettlementPayoutReadinessRow = {
  account_id: "acct-1",
  status: "ready",
  missing_requirements: [],
  advisory_requirements: [],
  disabled_reason: null,
  requirements_deadline: null,
  provider_reference: "provider-account",
  contact_email: null,
  onboarding_status: "complete",
  transfer_capability_status: "active",
  payout_capability_status: "active",
  payout_destination_status: "ready",
  payout_destination_fingerprint: null,
  payout_destination_changed_at: null,
  payout_account_dashboard: "none",
  losses_collector: "application",
  fees_collector: "application",
  requirements_collector: "application",
  updated_at: "2026-10-28T12:00:00.000Z",
};

function payout(overrides: Partial<SettlementPayoutRow> = {}): SettlementPayoutRow {
  return {
    payout_id: "pyo-1",
    account_id: "acct-1",
    amount: "10.00",
    requested_amount: "10.00",
    fee_amount: "0.32",
    net_amount: "9.68",
    currency_code: "usd",
    destination_reference: null,
    note: null,
    display_reference: "PYO-1",
    status: "requested",
    provider_transfer_reference: null,
    provider_payout_reference: null,
    provider_status: null,
    provider_failure_code: null,
    provider_failure_message: null,
    requested_at: "2026-10-28T10:00:00.000Z",
    updated_at: "2026-10-28T10:00:00.000Z",
    sent_at: null,
    completed_at: null,
    failed_at: null,
    failure_reason: null,
    last_provider_event_at: null,
    last_reconciled_at: null,
    retry_count: 0,
    next_retry_at: null,
    retry_reason: null,
    ...overrides,
  };
}

describe("Settlement payout summary", () => {
  it("answers next payout, all three blocked kinds, and arrival in UTC business days", () => {
    const items = [
      payout({
        payout_id: "failed",
        display_reference: "PYO-FAILED",
        status: "failed",
        failure_reason: "identity-verification-required",
        failed_at: "2026-10-28T11:00:00.000Z",
      }),
      payout({
        payout_id: "missing-provider",
        status: "in-transit",
        updated_at: "2026-10-28T11:30:00.000Z",
      }),
      payout({
        payout_id: "stale",
        updated_at: "2026-10-28T11:00:00.000Z",
      }),
      payout({
        payout_id: "next",
        status: "in-transit",
        sent_at: "2026-10-27T10:00:00.000Z",
        updated_at: "2026-10-28T12:00:00.000Z",
        provider_payout_reference: "po-next",
      }),
    ];

    expect(selectNextPayoutSummary(items)).toMatchObject({
      payout_id: "next",
      estimated_arrival_at: "2026-10-30T10:00:00.000Z",
    });
    expect(selectBlockedPayoutSummaryRows(items, "2026-10-28T12:00:00.000Z").map((row) => row.kind)).toEqual([
      "failed",
      "missing-provider-reference",
      "stale-requested",
    ]);
  });

  const closedMessage = "The bank account has been closed.";
  it.each([
    [
      "a coded failure_reason",
      {
        status: "failed",
        failure_reason: "identity-verification-required",
        provider_failure_code: "account_closed",
        provider_failure_message: closedMessage,
      },
      "identity-verification-required",
    ],
    [
      "a provider code and message",
      {
        status: "failed",
        failure_reason: null,
        provider_failure_code: "account_closed",
        provider_failure_message: closedMessage,
      },
      "account_closed",
    ],
    [
      "a provider code only",
      {
        status: "failed",
        failure_reason: null,
        provider_failure_code: "account_closed",
        provider_failure_message: null,
      },
      "account_closed",
    ],
    [
      "a provider message only",
      { status: "failed", failure_reason: null, provider_failure_code: null, provider_failure_message: closedMessage },
      "recent-payout-failure",
    ],
    [
      "no failure detail",
      { status: "failed", failure_reason: null, provider_failure_code: null, provider_failure_message: null },
      "recent-payout-failure",
    ],
    [
      "a stale request",
      { status: "requested", updated_at: "2026-10-28T11:00:00.000Z" },
      "payout-reconciliation-required",
    ],
    ["a missing provider reference", { status: "in-transit" }, "payout-reconciliation-required"],
  ] as const)("publishes the shared block_reason for %s", (_name, overrides, blockReason) => {
    const items = [payout({ payout_id: "blocked", failed_at: "2026-10-28T11:00:00.000Z", ...overrides })];
    const summary = buildPayoutSummary({
      items,
      total: 1,
      completeness: { kind: "complete", total: 1 },
      availability: buildPayoutAvailability({ wallet, readiness, canRequestPayouts: true }),
      evaluatedAt: "2026-10-28T12:00:00.000Z",
    });

    expect(selectBlockedPayoutSummaryRows(items, "2026-10-28T12:00:00.000Z").map((row) => row.block_reason)).toEqual([
      blockReason,
    ]);
    expect(summary.blocked_payouts.map((row) => [row.payout_id, row.block_reason])).toEqual([["blocked", blockReason]]);
  });

  it.each([
    ["not-ready", { ...readiness, status: "pending", provider_reference: null }, wallet, ["payout-setup-incomplete"]],
    ["missing updated_at", { ...readiness, updated_at: null }, wallet, ["payout-setup-refresh-required"]],
    [
      "open requirements",
      { ...readiness, missing_requirements: ["bank_account"] },
      wallet,
      ["provider-requirements-open"],
    ],
    ["zero wallet", readiness, { ...wallet, available_balance_amount: "0.00" }, ["no-available-wallet-balance"]],
    [
      "negative wallet",
      readiness,
      { ...wallet, available_balance_amount: "-1.00" },
      ["no-available-wallet-balance", "negative-balance-active"],
    ],
  ] as const)("preserves availability reason ordering for %s", (_name, row, candidateWallet, reasons) => {
    const result = buildPayoutAvailability({ wallet: candidateWallet, readiness: row, canRequestPayouts: true });
    expect(result.unavailable_reasons).toEqual(reasons);
    // The same code/message details, in order, that the payout request preview publishes.
    expect(result.unavailable_reason_details).toEqual(moneyStatusDetails(reasons));
    expect(result.can_request).toBe(false);
  });

  it("keeps request permission separate from read permission", () => {
    const result = buildPayoutAvailability({ wallet, readiness, canRequestPayouts: false });
    expect(result).toEqual({
      can_request: false,
      unavailable_reasons: ["payout-request-permission-required"],
      unavailable_reason_details: moneyStatusDetails(["payout-request-permission-required"]),
    });
  });

  it("fails closed when the independent total exceeds the hard cap", async () => {
    const query = vi.fn(async (sql: string) =>
      sql.includes("COUNT(*)")
        ? { rows: [{ count: String(PAYOUT_SUMMARY_HARD_CAP + 1) }] }
        : { rows: Array.from({ length: PAYOUT_SUMMARY_HARD_CAP + 1 }, () => payout()) },
    );
    const result = await listPayoutSummaryRows({ query } as never, "acct-1");
    const summary = buildPayoutSummary({
      ...result,
      availability: buildPayoutAvailability({ wallet, readiness, canRequestPayouts: true }),
      evaluatedAt: "2026-10-28T12:00:00.000Z",
    });

    expect(result.items).toHaveLength(PAYOUT_SUMMARY_HARD_CAP);
    expect(summary.completeness).toMatchObject({ kind: "bounded-incomplete", cap: PAYOUT_SUMMARY_HARD_CAP });
    expect(summary.next_payout).toBeNull();
    expect(summary.blocked_payouts).toEqual([]);
  });

  it("reads the actionable tail beyond the default page through the items-query limit", async () => {
    const rows = [
      ...Array.from({ length: 59 }, (_, index) =>
        payout({ payout_id: `requested-${index}`, updated_at: "2026-10-28T11:55:00.000Z" }),
      ),
      payout({
        payout_id: "failed-tail",
        status: "failed",
        failed_at: "2026-10-28T09:00:00.000Z",
        updated_at: "2026-10-28T09:00:00.000Z",
      }),
    ];
    // The count stays at 60, so only the items-query LIMIT decides whether the tail is read.
    const query = vi.fn(async (sql: string, params: readonly unknown[]) =>
      sql.includes("COUNT(*)") ? { rows: [{ count: "60" }] } : { rows: rows.slice(0, Number(params[1])) },
    );
    const result = await listPayoutSummaryRows({ query } as never, "acct-1");
    const summary = buildPayoutSummary({
      ...result,
      availability: buildPayoutAvailability({ wallet, readiness, canRequestPayouts: true }),
      evaluatedAt: "2026-10-28T12:00:00.000Z",
    });

    expect(query.mock.calls.map(([, params]) => params[0])).toEqual(["acct-1", "acct-1"]);
    expect(result.completeness).toEqual({ kind: "complete", total: 60 });
    expect(result.items).toHaveLength(60);
    expect(result.items[59]?.payout_id).toBe("failed-tail");
    expect(summary.blocked_payouts.map((row) => row.payout_id)).toEqual(["failed-tail"]);
  });
});
