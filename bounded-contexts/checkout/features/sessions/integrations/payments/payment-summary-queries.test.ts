import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { getCheckoutPaymentSummary } from "./payment-summary-queries";

describe("checkout payment summary query", () => {
  it("requires payment id and buyer account in the summary lookup", async () => {
    const summary = { payment_id: "pay_owned", amount: "27.29", currency_code: "usd", status: "captured" };
    const rows = [
      { ...summary, buyer_account_id: "acc_buyer" },
      { ...summary, payment_id: "pay_unowned", buyer_account_id: null },
    ];
    const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      expect(normalized).toBe(
        "SELECT payment_id, amount, currency_code, status FROM checkout_payment_summary_pages WHERE payment_id = $1 AND buyer_account_id = $2",
      );
      const matches = rows.filter((row) => row.payment_id === values[0] && row.buyer_account_id === values[1]);
      return {
        rows: matches.map(({ buyer_account_id: _buyer, ...row }) => row),
        rowCount: matches.length,
      };
    });
    const db = { query } as unknown as PgQueryable;
    await expect(getCheckoutPaymentSummary(db, "pay_owned", "acc_buyer")).resolves.toEqual(summary);
    await expect(getCheckoutPaymentSummary(db, "pay_owned", "acc_other")).resolves.toBeNull();
    await expect(getCheckoutPaymentSummary(db, "pay_unowned", "acc_buyer")).resolves.toBeNull();
    await expect(getCheckoutPaymentSummary(db, "pay_missing", "acc_buyer")).resolves.toBeNull();
    expect(query.mock.calls.map(([, values]) => values)).toEqual([
      ["pay_owned", "acc_buyer"],
      ["pay_owned", "acc_other"],
      ["pay_unowned", "acc_buyer"],
      ["pay_missing", "acc_buyer"],
    ]);
    expect(query).toHaveBeenCalledTimes(4);
  });
});
