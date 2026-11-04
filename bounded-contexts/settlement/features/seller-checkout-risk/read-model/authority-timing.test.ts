import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { SellerCheckoutRiskOwner, SellerCheckoutRiskResult } from "../domain/contract";
import { readSellerCheckoutRisk } from "./queries";

const probePath = fileURLToPath(
  new URL("../../../../../artifacts/11014/tests/authority-timing-probe.json", import.meta.url),
);
const owner: SellerCheckoutRiskOwner = { kind: "account", accountId: "acc_01JSELLER000000000000000000" };
const row = { account_id: owner.accountId, revision: 7, updated_at: "2026-10-29T14:00:00.000Z" };
type ProbeEntry = Readonly<{
  moment: "readiness" | "before-confirm";
  confirmationId: string;
  capturedAt: string;
  result: SellerCheckoutRiskResult;
}>;

describe("seller checkout risk authority timing", () => {
  it("captures changed facts/stamps and unavailable before-confirm authority for the same trusted owner", async () => {
    const scenarios = [];
    for (const failure of ["changed-facts", "failed-source", "undecodable-source"] as const) {
      const persisted = { ...row, manual_payout_review: false, stripe_fraud_signal_count: 0 };
      let acquisitions = 0;
      const source = vi.fn(async (_accountId: string) => {
        acquisitions++;
        if (acquisitions === 2 && failure === "failed-source") throw new Error("synthetic unavailable");
        return {
          account_id: persisted.account_id,
          revision: persisted.revision,
          updated_at:
            acquisitions === 2 && failure === "undecodable-source" ? new Date(Number.NaN) : persisted.updated_at,
        };
      });
      const entries: ProbeEntry[] = [];
      const confirmationId = `cnf_synthetic_${failure}`;
      for (const moment of ["readiness", "before-confirm"] as const) {
        entries.push({
          moment,
          confirmationId,
          capturedAt: new Date().toISOString(),
          result: await readSellerCheckoutRisk(source, owner),
        });
        persisted.revision = 8;
        persisted.updated_at = "2026-10-29T14:01:00.000Z";
        persisted.manual_payout_review = true;
        persisted.stripe_fraud_signal_count = 99;
      }
      expect(source.mock.calls).toEqual([[owner.accountId], [owner.accountId]]);
      expect(entries.map((entry) => entry.moment)).toEqual(["readiness", "before-confirm"]);
      expect(entries[0]?.result).toEqual({
        schemaVersion: "settlement.seller-checkout-risk.v1",
        status: "clear",
        reasonCode: null,
        policyRevision: "seller-checkout-risk-v1",
        sourceRevision: 7,
        sourceTimestamp: row.updated_at,
        rowState: "present",
      });
      expect(entries[1]?.result).toEqual(
        failure === "changed-facts"
          ? {
              ...entries[0]!.result,
              sourceRevision: 8,
              sourceTimestamp: persisted.updated_at,
            }
          : {
              schemaVersion: "settlement.seller-checkout-risk.v1",
              status: "not-clear",
              reasonCode: "risk-not-clear",
              policyRevision: "seller-checkout-risk-v1",
              sourceRevision: null,
              sourceTimestamp: null,
              rowState: "unavailable",
            },
      );
      for (const entry of entries) {
        expect(entry.confirmationId).toBe(confirmationId);
        expect(Number.isFinite(Date.parse(entry.capturedAt))).toBe(true);
      }
      scenarios.push({ scenario: failure, owner, entries });
    }
    const probe = {
      schemaVersion: "settlement.seller-checkout-risk-authority-timing.v1",
      evidence: "synthetic internal source; actual reader calls, not HTTP or consumer adapter proof",
      runId: randomUUID(),
      scenarios,
    };
    mkdirSync(path.dirname(probePath), { recursive: true });
    writeFileSync(probePath, `${JSON.stringify(probe, null, 2)}\n`);
    expect(JSON.parse(readFileSync(probePath, "utf8"))).toEqual(probe);
  });
});
