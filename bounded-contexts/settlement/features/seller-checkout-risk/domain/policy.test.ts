import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createSellerCheckoutRiskReader } from "../read-model/queries";
import { evaluateSellerCheckoutRisk } from "./policy";

const facts = {
  account_created_at: "2026-10-29T00:00:00.000Z",
  trusted_seller: true,
  manual_payout_review: true,
  stripe_fraud_flag: true,
  stripe_fraud_flagged_at: "2026-10-29T00:00:00.000Z",
  stripe_fraud_signal_count: 99,
  stripe_review_open_count: 99,
  shared_instrument_cluster_count: 99,
  shared_address_cluster_count: 99,
  review_count: 99,
  average_rating: "1.00",
};
const holdFacts = { payout_review_hold: true, payout_review_hold_stream_version: 3 };

describe("seller checkout risk v1 policy", () => {
  it("enumerates boot facts and the ledger-only payout review hold facts", () => {
    const schema = readFileSync(
      new URL("../../wallets/integrations/account-risk-source/account-risk-source-schema.ts", import.meta.url),
      "utf8",
    );
    const columns = schema
      .match(/CREATE TABLE IF NOT EXISTS settlement_account_risk_sources \(([\s\S]*?)\n\);/)![1]!
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0]);
    expect(columns.sort()).toEqual(["account_id", "updated_at", ...Object.keys(facts)].sort());
    const ledgerFacts = [...schema.matchAll(/ADD COLUMN IF NOT EXISTS (revision|payout_review_hold\w*)\b/g)].map(
      ([, column]) => column,
    );
    expect(ledgerFacts).toEqual(["revision", ...Object.keys(holdFacts)]);
    expect(schema.match(/ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 0/g)).toHaveLength(1);
    expect(evaluateSellerCheckoutRisk()).toEqual({ status: "clear", reasonCode: null });
  });

  it.each(Object.keys({ ...facts, ...holdFacts }))(
    "keeps persisted %s private and both hold/block predicates disabled on the production read path",
    async (fact) => {
      const persisted: Record<string, unknown> = {
        ...facts,
        ...holdFacts,
        account_id: "acc_policy",
        revision: "17",
        updated_at: new Date("2026-10-29T14:00:00.000Z"),
      };
      // A synthetic DB projects the actual SELECT columns, not a policy-only test helper.
      const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
        expect(params).toEqual(["acc_policy"]);
        const columns = sql
          .match(/SELECT\s+([\s\S]*?)\s+FROM/)![1]!
          .split(",")
          .map((column) => column.trim());
        expect(columns).toEqual(["account_id", "revision", "updated_at"]);
        return { rows: [Object.fromEntries(columns.map((column) => [column, persisted[column]]))] };
      });
      const reader = createSellerCheckoutRiskReader({ query } as PgQueryable);
      const owner = { kind: "account", accountId: "acc_policy" } as const;
      const before = await reader(owner);
      const value = persisted[fact];
      persisted[fact] =
        typeof value === "boolean"
          ? !value
          : typeof value === "number"
            ? value + 1
            : fact.endsWith("_at")
              ? "2026-10-30T00:00:00.000Z"
              : "2.00";
      const after = await reader(owner);
      expect(before).toEqual({
        schemaVersion: "settlement.seller-checkout-risk.v1",
        status: "clear",
        reasonCode: null,
        policyRevision: "seller-checkout-risk-v1",
        sourceRevision: 17,
        sourceTimestamp: "2026-10-29T14:00:00.000Z",
        rowState: "present",
      });
      expect(after).toEqual(before);
      expect(query).toHaveBeenCalledTimes(2);
      expect(before).not.toHaveProperty(fact);
    },
  );
});
