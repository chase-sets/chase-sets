import { describe, expect, it } from "vitest";
import {
  PRODUCT_RESOLUTION_JOB_ID,
  PRODUCT_RESOLUTION_UNIT_ID,
  PRODUCT_RESOLUTION_RECEIPT_ID,
  readProductResolutionProgress,
  readProductResolutionReceipt,
  type ProductResolutionProgress,
} from "./product-resolution-maintenance";

const state: ProductResolutionProgress = {
  validatorVersion: 1,
  highWatermark: { createdAt: "2026-10-01T00:00:00.000002Z", rowId: "row_2" },
  finalCursor: { createdAt: "2026-10-01T00:00:00.000001Z", rowId: "row_1" },
  scannedCount: 1,
  normalizedCount: 1,
  normalizedProviderCount: 1,
  alreadyConvergedCount: 0,
  skippedConcurrentCount: 0,
  startedAt: "2026-10-06T00:00:00Z",
  poison: null,
  recoveryRowId: null,
};
const { poison, recoveryRowId, ...receiptState } = state;
const receipt = {
  ...receiptState,
  receiptId: PRODUCT_RESOLUTION_RECEIPT_ID,
  jobId: PRODUCT_RESOLUTION_JOB_ID,
  unitId: PRODUCT_RESOLUTION_UNIT_ID,
  complete: true,
  completedAt: "2026-10-06T00:01:00Z",
};

describe("closed bounded maintenance state and v1 receipt", () => {
  it("accepts retained microsecond cursors and the deliberate slash receipt identity", () => {
    expect(readProductResolutionProgress(state)).toEqual(state);
    expect(readProductResolutionReceipt(receipt)).toEqual(receipt);
    expect(poison).toBeNull();
    expect(recoveryRowId).toBeNull();
  });
  it.each([
    { extra: true },
    { validatorVersion: 0 },
    { validatorVersion: 2_147_483_648 },
    { validatorVersion: 1.5 },
    { scannedCount: -1 },
    { scannedCount: Number.MAX_SAFE_INTEGER + 1 },
    { normalizedCount: 2 },
    { normalizedProviderCount: 2 },
    { alreadyConvergedCount: 1 },
    { highWatermark: null },
    { finalCursor: { createdAt: "2026-10-02T00:00:00Z", rowId: "later" } },
    { finalCursor: { createdAt: "2026-10-01T00:00:00.000003Z", rowId: "row_1" } },
    { highWatermark: { ...state.highWatermark, extra: true } },
    { finalCursor: { createdAt: "2026-10-01T00:00:00", rowId: "row_1" } },
    { startedAt: "2026-02-30T00:00:00Z" },
    { startedAt: "2026-10-06" },
    { recoveryRowId: "x".repeat(201) },
    { poison: { rowId: "row_1", cursor: null, errorClass: "raw-secret", attempts: 1 } },
    { poison: { rowId: "row_1", cursor: null, errorClass: ["row-state"], attempts: 1 } },
    { poison: { rowId: "row_1", cursor: null, errorClass: "row-state", attempts: 4 } },
    { poison: { rowId: "row_1", cursor: { createdAt: "bad", rowId: "row_1" }, errorClass: "row-state", attempts: 1 } },
    { poison: { rowId: "row_1", cursor: null, errorClass: "row-state", attempts: 1, extra: true } },
  ])("rejects malformed/extra/nested progress %j", (override) => {
    expect(() => readProductResolutionProgress({ ...state, ...override })).toThrow(
      "Invalid Product resolution maintenance progress",
    );
  });
  it.each([
    { extra: true },
    { complete: false },
    { jobId: "sibling-v2" },
    { unitId: "sibling-v2" },
    { receiptId: "wrong.identity.v1" },
    { completedAt: "2026-10-05T00:00:00Z" },
    { completedAt: "2026-10-06T00:01:00" },
    { completedAt: "2026-02-30T00:00:00Z" },
    { poison: null },
    { finalCursor: { ...state.finalCursor, extra: true } },
  ])("rejects malformed receipts %j", (override) => {
    expect(() => readProductResolutionReceipt({ ...receipt, ...override })).toThrow(
      "Invalid Product resolution maintenance receipt",
    );
  });
});
