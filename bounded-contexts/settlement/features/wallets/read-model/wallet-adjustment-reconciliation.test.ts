import { describe, expect, it } from "vitest";
import {
  evaluateWalletAdjustmentReconciliation,
  WALLET_ADJUSTMENT_RECONCILIATION_DEFAULT_THRESHOLDS,
  type WalletAdjustmentLinkedRow,
  type WalletAdjustmentReconciliationContext,
  type WalletAdjustmentReconciliationRow,
} from "./wallet-adjustment-reconciliation";

const NOW = "2026-07-13T12:00:00.000Z";

function row(overrides: Partial<WalletAdjustmentReconciliationRow> = {}): WalletAdjustmentReconciliationRow {
  return {
    adjustment_id: "wad_1",
    status: "posted",
    target_account_id: "acc_target",
    direction: "credit",
    amount: "40.00",
    currency_code: "usd",
    requested_at: "2026-07-13T00:00:00.000Z",
    approved_at: "2026-07-13T00:05:00.000Z",
    posted_ledger_entry_id: "led_1",
    posted_at: "2026-07-13T00:06:00.000Z",
    available_balance_before: "10.00",
    available_balance_after: "50.00",
    reversal_of_adjustment_id: null,
    reversed_by_adjustment_id: null,
    ...overrides,
  };
}

function emptyContext(
  overrides: Partial<WalletAdjustmentReconciliationContext> = {},
): WalletAdjustmentReconciliationContext {
  return {
    existingLedgerEntryIds: new Set(),
    duplicatedLedgerEntryIds: new Set(),
    duplicatedReversalTargets: new Set(),
    linkedRows: new Map(),
    ...overrides,
  };
}

describe("evaluateWalletAdjustmentReconciliation", () => {
  it("finds nothing for a clean posted adjustment with a matching ledger entry", () => {
    const findings = evaluateWalletAdjustmentReconciliation(
      [row()],
      emptyContext({ existingLedgerEntryIds: new Set(["led_1"]) }),
      NOW,
    );
    expect(findings).toEqual([]);
  });

  it("flags approved-not-posted once the staleness threshold is exceeded", () => {
    const findings = evaluateWalletAdjustmentReconciliation(
      [
        row({
          status: "approved",
          approved_at: "2026-07-13T11:00:00.000Z",
          posted_ledger_entry_id: null,
          posted_at: null,
          available_balance_before: null,
          available_balance_after: null,
        }),
      ],
      emptyContext(),
      NOW,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("approved-not-posted");
    expect(findings[0]?.severity).toBe("high");
  });

  it("does not flag an approval still within the staleness grace window", () => {
    const findings = evaluateWalletAdjustmentReconciliation(
      [
        row({
          status: "approved",
          approved_at: "2026-07-13T11:50:00.000Z",
          posted_ledger_entry_id: null,
          posted_at: null,
          available_balance_before: null,
          available_balance_after: null,
        }),
      ],
      emptyContext(),
      NOW,
    );
    expect(findings).toEqual([]);
  });

  it("flags stale-pending-approval once the pending threshold is exceeded", () => {
    const findings = evaluateWalletAdjustmentReconciliation(
      [
        row({
          status: "requested",
          requested_at: "2026-07-10T00:00:00.000Z",
          approved_at: null,
          posted_ledger_entry_id: null,
          posted_at: null,
          available_balance_before: null,
          available_balance_after: null,
        }),
      ],
      emptyContext(),
      NOW,
    );
    expect(findings.map((f) => f.code)).toEqual(["stale-pending-approval"]);
    expect(findings[0]?.severity).toBe("medium");
  });

  it("flags posted-without-ledger-entry when the ledger entry does not exist", () => {
    const findings = evaluateWalletAdjustmentReconciliation([row()], emptyContext(), NOW);
    expect(findings.map((f) => f.code)).toContain("posted-without-ledger-entry");
    expect(findings.find((f) => f.code === "posted-without-ledger-entry")?.severity).toBe("critical");
  });

  it("flags duplicate-ledger-linkage when the ledger entry is shared", () => {
    const findings = evaluateWalletAdjustmentReconciliation(
      [row()],
      emptyContext({ existingLedgerEntryIds: new Set(["led_1"]), duplicatedLedgerEntryIds: new Set(["led_1"]) }),
      NOW,
    );
    expect(findings.map((f) => f.code)).toEqual(["duplicate-ledger-linkage"]);
  });

  it("flags unexpected-balance-delta when before/after does not match direction and amount", () => {
    const findings = evaluateWalletAdjustmentReconciliation(
      [row({ available_balance_before: "10.00", available_balance_after: "40.00" })],
      emptyContext({ existingLedgerEntryIds: new Set(["led_1"]) }),
      NOW,
    );
    expect(findings.map((f) => f.code)).toEqual(["unexpected-balance-delta"]);
  });

  it("does not flag a debit's negative delta when it correctly matches", () => {
    const findings = evaluateWalletAdjustmentReconciliation(
      [
        row({
          direction: "debit",
          amount: "15.00",
          available_balance_before: "25.00",
          available_balance_after: "10.00",
        }),
      ],
      emptyContext({ existingLedgerEntryIds: new Set(["led_1"]) }),
      NOW,
    );
    expect(findings).toEqual([]);
  });

  it("flags reversal-mismatch when a reversed adjustment's linked reversal is missing", () => {
    const findings = evaluateWalletAdjustmentReconciliation(
      [row({ status: "reversed", reversed_by_adjustment_id: "wad_2" })],
      emptyContext({ existingLedgerEntryIds: new Set(["led_1"]) }),
      NOW,
    );
    expect(findings.map((f) => f.code)).toEqual(["reversal-mismatch"]);
  });

  it("does not flag a correctly-linked reversal pair", () => {
    const original = row({ status: "reversed", reversed_by_adjustment_id: "wad_2" });
    const reversalLinked: WalletAdjustmentLinkedRow = {
      adjustment_id: "wad_2",
      status: "posted",
      direction: "debit",
      amount: "40.00",
      currency_code: "usd",
      reversal_of_adjustment_id: "wad_1",
      reversed_by_adjustment_id: null,
    };
    const reversalRow = row({
      adjustment_id: "wad_2",
      direction: "debit",
      reversal_of_adjustment_id: "wad_1",
      reversed_by_adjustment_id: null,
      posted_ledger_entry_id: "led_2",
      available_balance_before: "50.00",
      available_balance_after: "10.00",
    });

    const findings = evaluateWalletAdjustmentReconciliation(
      [original, reversalRow],
      emptyContext({
        existingLedgerEntryIds: new Set(["led_1", "led_2"]),
        linkedRows: new Map([
          ["wad_2", reversalLinked],
          [
            "wad_1",
            {
              adjustment_id: "wad_1",
              status: "reversed",
              direction: "credit",
              amount: "40.00",
              currency_code: "usd",
              reversal_of_adjustment_id: null,
              reversed_by_adjustment_id: "wad_2",
            },
          ],
        ]),
      }),
      NOW,
    );
    expect(findings).toEqual([]);
  });

  it("flags reversal-mismatch when the reversal's amount does not match the original", () => {
    const reversalLinked: WalletAdjustmentLinkedRow = {
      adjustment_id: "wad_2",
      status: "posted",
      direction: "debit",
      amount: "39.00",
      currency_code: "usd",
      reversal_of_adjustment_id: "wad_1",
      reversed_by_adjustment_id: null,
    };
    const findings = evaluateWalletAdjustmentReconciliation(
      [row({ status: "reversed", reversed_by_adjustment_id: "wad_2" })],
      emptyContext({
        existingLedgerEntryIds: new Set(["led_1"]),
        linkedRows: new Map([["wad_2", reversalLinked]]),
      }),
      NOW,
    );
    expect(findings.map((f) => f.code)).toEqual(["reversal-mismatch"]);
  });

  it("flags reversal-mismatch when the original is claimed by more than one reversal", () => {
    const original: WalletAdjustmentLinkedRow = {
      adjustment_id: "wad_1",
      status: "reversed",
      direction: "credit",
      amount: "40.00",
      currency_code: "usd",
      reversal_of_adjustment_id: null,
      reversed_by_adjustment_id: "wad_2",
    };
    const findings = evaluateWalletAdjustmentReconciliation(
      [row({ adjustment_id: "wad_3", reversal_of_adjustment_id: "wad_1", posted_ledger_entry_id: "led_3" })],
      emptyContext({
        existingLedgerEntryIds: new Set(["led_3"]),
        duplicatedReversalTargets: new Set(["wad_1"]),
        linkedRows: new Map([["wad_1", original]]),
      }),
      NOW,
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.every((f) => f.code === "reversal-mismatch")).toBe(true);
  });

  it("uses the default thresholds when none are supplied", () => {
    expect(WALLET_ADJUSTMENT_RECONCILIATION_DEFAULT_THRESHOLDS).toEqual({
      staleApprovalMinutes: 30,
      stalePendingHours: 48,
    });
  });
});
