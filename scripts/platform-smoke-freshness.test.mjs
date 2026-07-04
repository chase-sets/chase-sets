import { describe, expect, it } from "vitest";
import { createReadAfterWriteReceiptFromCommitReceipt, decodeCommitReceipt } from "./platform-smoke-freshness.mjs";

const commitSources = [
  {
    sourceContextName: "public-presence",
    maxGlobalPosition: "42",
    eventIds: ["evt_waitlist"],
  },
];

function commitReceiptFor(value) {
  return encodeURIComponent(JSON.stringify(value));
}

function decodeFreshWriteReceipt(value) {
  return JSON.parse(decodeURIComponent(value));
}

describe("platform smoke freshness receipts", () => {
  it("decodes bounded source commit positions", () => {
    expect(decodeCommitReceipt(commitReceiptFor(commitSources))).toEqual(commitSources);
    expect(decodeCommitReceipt(commitReceiptFor([{ sourceContextName: "public-presence" }]))).toEqual([]);
    expect(decodeCommitReceipt("not-json")).toEqual([]);
  });

  it("re-materializes a fresh read-after-write receipt from a stable commit receipt", () => {
    const commitReceipt = commitReceiptFor(commitSources);
    const first = createReadAfterWriteReceiptFromCommitReceipt(commitReceipt, 1000);
    const second = createReadAfterWriteReceiptFromCommitReceipt(commitReceipt, 2000);

    expect(decodeFreshWriteReceipt(first)).toEqual({
      observedAtMs: 1000,
      sources: commitSources,
    });
    expect(decodeFreshWriteReceipt(second)).toEqual({
      observedAtMs: 2000,
      sources: commitSources,
    });
  });

  it("rejects missing or malformed commit receipts", () => {
    expect(createReadAfterWriteReceiptFromCommitReceipt(null)).toBeNull();
    expect(createReadAfterWriteReceiptFromCommitReceipt("not-json")).toBeNull();
    expect(createReadAfterWriteReceiptFromCommitReceipt(commitReceiptFor([]))).toBeNull();
  });
});
