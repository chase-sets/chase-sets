import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import matrix from "./authority-matrix.fixture.json" with { type: "json" };
import { readSellerCheckoutRisk, type SellerCheckoutRiskFactSource } from "./queries";

const account = { kind: "account", accountId: "acc_01JSELLER000000000000000000" } as const;
const anonymous = { kind: "anonymous", anonymousSellListId: "anon_01JGUEST00000000000000000" } as const;
const row = { account_id: account.accountId, revision: 7, updated_at: "2026-10-29T14:00:00.000Z" };
const absent = {
  schemaVersion: "settlement.seller-checkout-risk.v1",
  status: "clear",
  reasonCode: null,
  policyRevision: "seller-checkout-risk-v1",
  sourceRevision: 0,
  sourceTimestamp: null,
  rowState: "absent",
};

function read(source: SellerCheckoutRiskFactSource, owner: unknown) {
  return readSellerCheckoutRisk(source, owner as never);
}

describe("seller checkout risk authority contract", () => {
  it("keeps the owner contract and read at the Settlement boundary", () => {
    const root = fileURLToPath(new URL("../../../../../", import.meta.url));
    const source = (relative: string) => readFileSync(path.join(root, relative), "utf8");
    for (const symbol of matrix.authority.contractSymbols) {
      expect(source(matrix.authority.contract)).toMatch(new RegExp(`export (?:type|const) ${symbol}\\b`));
    }
    for (const symbol of matrix.authority.readSymbols) {
      expect(source(matrix.authority.read)).toMatch(new RegExp(`export (?:type|function|async function) ${symbol}\\b`));
    }
  });

  it("reads an account once and preserves the real revision and timestamp", async () => {
    const source = vi.fn(async () => row);
    await expect(read(source, account)).resolves.toEqual({
      ...absent,
      sourceRevision: 7,
      sourceTimestamp: row.updated_at,
      rowState: "present",
    });
    expect(source).toHaveBeenCalledTimes(1);
    expect(source).toHaveBeenCalledWith(account.accountId);
  });

  it("returns a distinct absent result for a missing account row", async () => {
    await expect(read(async () => null, account)).resolves.toEqual(absent);
  });

  it("does not query Settlement for an anonymous owner", async () => {
    const source = vi.fn(async () => row);
    await expect(read(source, anonymous)).resolves.toEqual(absent);
    expect(source).not.toHaveBeenCalled();
  });

  it("rejects invalid owners without querying", async () => {
    const source = vi.fn(async () => row);
    await expect(read(source, { kind: "account", accountId: "anon_wrong" })).resolves.toMatchObject({
      status: "not-clear",
      reasonCode: "risk-not-clear",
      rowState: "unavailable",
    });
    expect(source).not.toHaveBeenCalled();
  });

  it.each([
    ["overflow", { ...row, revision: Number.MAX_SAFE_INTEGER + 1 }],
    ["malformed timestamp", { ...row, updated_at: "2026-10-29" }],
    ["wrong owner", { ...row, account_id: "acc_other" }],
    ["unknown field", { ...row, extra: true }],
  ])("blocks %s source rows instead of defaulting clear", async (_name, malformed) => {
    await expect(read(async () => malformed, account)).resolves.toMatchObject({
      status: "not-clear",
      reasonCode: "risk-not-clear",
      rowState: "unavailable",
      sourceRevision: 0,
      sourceTimestamp: null,
    });
  });

  it("turns a source failure into unavailable authority", async () => {
    await expect(read(async () => Promise.reject(new Error("db down")), account)).resolves.toMatchObject({
      status: "not-clear",
      reasonCode: "risk-not-clear",
      rowState: "unavailable",
    });
  });
});
