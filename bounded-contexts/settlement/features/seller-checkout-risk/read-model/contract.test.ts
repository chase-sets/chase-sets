import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import matrix from "./authority-matrix.fixture.json" with { type: "json" };
import { readSellerCheckoutRisk, type SellerCheckoutRiskFactSource } from "./queries";
import { parseSellerCheckoutRiskResult, type SellerCheckoutRiskResult } from "../domain/contract";

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
const unavailable = {
  ...absent,
  status: "not-clear",
  reasonCode: "risk-not-clear",
  sourceRevision: null,
  rowState: "unavailable",
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

  it("registers every AC and enrolls revision persistence exactly once in DB, never Unit", () => {
    expect(Object.keys(matrix.acceptanceTests)).toEqual(["AC1", "AC2", "AC3", "AC4"]);
    expect(matrix.dbWriterCases).toHaveLength(10);
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    const fixture = "features/seller-checkout-risk/read-model/seller-checkout-risk-revision.db.test.ts";
    expect(pkg.scripts["test:db"].split(" ").filter((word: string) => word === fixture)).toHaveLength(1);
    expect(
      pkg.scripts["test:unit"].split("--exclude ").filter((word: string) => word.startsWith(fixture)),
    ).toHaveLength(1);
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

  it.each([
    { kind: "account", accountId: "anon_wrong" },
    { kind: "account", accountId: "acc_anonymous_sell_list" },
    { kind: "account", accountId: "acc_" },
    { kind: "account", accountId: "acc_invalid space" },
    { kind: "account", accountId: "acc_trailing\n" },
    { kind: "account", accountId: { value: account.accountId } },
    { ...account, extra: true },
    { kind: "anonymous", anonymousSellListId: "acc_wrong" },
    { kind: "anonymous", anonymousSellListId: "anon_" },
    { kind: "anonymous", anonymousSellListId: "anon_bad/id" },
    { kind: "anonymous", anonymousSellListId: "anon_trailing\n" },
    { kind: "anonymous", anonymousSellListId: { value: anonymous.anonymousSellListId } },
    { ...anonymous, extra: true },
    { ...anonymous, accountId: account.accountId },
  ])("rejects invalid owner %j without querying", async (owner) => {
    const source = vi.fn(async () => row);
    await expect(read(source, owner)).resolves.toEqual(unavailable);
    expect(source).not.toHaveBeenCalled();
  });

  it.each([
    ["overflow", { ...row, revision: Number.MAX_SAFE_INTEGER + 1 }],
    ["bigint overflow text", { ...row, revision: "9007199254740992" }],
    ["negative revision", { ...row, revision: -1 }],
    ["fractional revision", { ...row, revision: 1.5 }],
    ["nested revision", { ...row, revision: { value: 7 } }],
    ["nested timestamp", { ...row, updated_at: { value: row.updated_at } }],
    ["invalid Date", { ...row, updated_at: new Date(Number.NaN) }],
    ["malformed timestamp", { ...row, updated_at: "2026-10-29" }],
    ["wrong owner", { ...row, account_id: "acc_other" }],
    ["unknown field", { ...row, extra: true }],
  ])("blocks %s source rows instead of defaulting clear", async (_name, malformed) => {
    await expect(read(async () => malformed, account)).resolves.toEqual(unavailable);
  });

  it("turns a source failure into unavailable authority", async () => {
    await expect(read(async () => Promise.reject(new Error("db down")), account)).resolves.toEqual(unavailable);
  });

  it.each([0, Number.MAX_SAFE_INTEGER, "7", "9007199254740991"])(
    "preserves safe revision %s and UTC Date provenance",
    async (revision) => {
      await expect(
        read(async () => ({ ...row, revision, updated_at: new Date(row.updated_at) }), account),
      ).resolves.toEqual({
        ...absent,
        rowState: "present",
        sourceRevision: Number(revision),
        sourceTimestamp: row.updated_at,
      });
    },
  );

  it("validates the closed present pairs, reserved pairs and absent/unavailable stamps", () => {
    const present = { ...absent, rowState: "present", sourceRevision: 7, sourceTimestamp: row.updated_at };
    for (const result of [
      present,
      absent,
      unavailable,
      { ...present, status: "hold", reasonCode: "risk-hold" },
      { ...present, status: "block", reasonCode: "risk-block" },
    ])
      expect(parseSellerCheckoutRiskResult(result)).toEqual(result);
    const reserved: Pick<SellerCheckoutRiskResult, "status" | "reasonCode">[] = [
      { status: "hold", reasonCode: "risk-hold" },
      { status: "block", reasonCode: "risk-block" },
    ];
    expect(reserved).toHaveLength(2);
    for (const result of [
      { ...present, reasonCode: "risk-hold" },
      { ...present, status: "hold", reasonCode: "risk-block" },
      { ...present, status: "block", reasonCode: null },
      { ...present, status: "not-clear", reasonCode: "risk-not-clear" },
      { ...present, rowState: "unknown" },
      { ...present, sourceRevision: Number.MAX_SAFE_INTEGER + 1 },
      { ...present, sourceRevision: { value: 7 } },
      { ...present, sourceTimestamp: "2026-10-29" },
      { ...present, sourceTimestamp: { value: row.updated_at } },
      { ...present, extra: { status: "clear" } },
      { ...present, policyRevision: "other" },
      { ...absent, sourceRevision: 1 },
      { ...absent, sourceTimestamp: row.updated_at },
      { ...absent, status: "hold", reasonCode: "risk-hold" },
      { ...unavailable, sourceRevision: 0 },
      { ...unavailable, sourceTimestamp: row.updated_at },
      { ...unavailable, status: "clear", reasonCode: null },
    ])
      expect(parseSellerCheckoutRiskResult(result)).toBeNull();
  });
});
