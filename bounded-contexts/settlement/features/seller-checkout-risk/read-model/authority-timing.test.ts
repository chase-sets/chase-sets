import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
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
  let probe!: { runId: string; owner: SellerCheckoutRiskOwner; entries: readonly ProbeEntry[] };

  beforeAll(async () => {
    const entries: ProbeEntry[] = [];
    const source = async () => row;
    for (const moment of ["readiness", "before-confirm"] as const) {
      entries.push({
        moment,
        confirmationId: "cnf_01JCONFIRMATION00000000000",
        capturedAt: new Date().toISOString(),
        result: await readSellerCheckoutRisk(source, owner),
      });
    }
    probe = { runId: randomUUID(), owner, entries };
    mkdirSync(path.dirname(probePath), { recursive: true });
    writeFileSync(
      probePath,
      `${JSON.stringify({ schemaVersion: "settlement.seller-checkout-risk-authority-timing.v1", ...probe }, null, 2)}\n`,
    );
  });

  it("captures readiness and before-confirm reads of the same trusted owner", () => {
    expect(probe.entries.map((entry) => entry.moment)).toEqual(["readiness", "before-confirm"]);
    expect(probe.entries[0]?.result).toEqual(probe.entries[1]?.result);
    expect(probe.entries[0]).toMatchObject({
      confirmationId: "cnf_01JCONFIRMATION00000000000",
      result: {
        status: "clear",
        policyRevision: "seller-checkout-risk-v1",
        sourceRevision: 7,
        sourceTimestamp: "2026-10-29T14:00:00.000Z",
        rowState: "present",
      },
    });
  });

  it("asserts the file contains this run's observed calls", () => {
    const written = JSON.parse(readFileSync(probePath, "utf8")) as typeof probe;
    expect(written.runId).toBe(probe.runId);
    expect(written.entries).toEqual(JSON.parse(JSON.stringify(probe.entries)));
  });
});
