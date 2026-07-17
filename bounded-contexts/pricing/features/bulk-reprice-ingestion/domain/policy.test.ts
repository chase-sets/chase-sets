import { describe, expect, it } from "vitest";
import {
  BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE,
  BulkRepriceIngestionPolicyError,
  decodeBulkRepriceIngestionPolicyValue,
} from "./policy";

describe("decodeBulkRepriceIngestionPolicyValue", () => {
  it("round-trips the launch default", () => {
    expect(decodeBulkRepriceIngestionPolicyValue(BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE)).toEqual(
      BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE,
    );
  });

  it("rejects a non-object value", () => {
    expect(() => decodeBulkRepriceIngestionPolicyValue("nope" as never)).toThrow(BulkRepriceIngestionPolicyError);
  });

  it("rejects a missing enabled flag", () => {
    expect(() =>
      decodeBulkRepriceIngestionPolicyValue({
        ...BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE,
        enabled: "yes" as never,
      }),
    ).toThrow(/enabled must be a boolean/);
  });

  it("rejects chunkSize out of bounds", () => {
    expect(() =>
      decodeBulkRepriceIngestionPolicyValue({ ...BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE, chunkSize: 0 }),
    ).toThrow(/chunkSize/);
    expect(() =>
      decodeBulkRepriceIngestionPolicyValue({ ...BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE, chunkSize: 501 }),
    ).toThrow(/chunkSize/);
  });

  it("rejects maxActiveJobsPerAccount out of bounds", () => {
    expect(() =>
      decodeBulkRepriceIngestionPolicyValue({
        ...BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE,
        maxActiveJobsPerAccount: 0,
      }),
    ).toThrow(/maxActiveJobsPerAccount/);
    expect(() =>
      decodeBulkRepriceIngestionPolicyValue({
        ...BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE,
        maxActiveJobsPerAccount: 2,
      }),
    ).toThrow(/maxActiveJobsPerAccount/);
  });

  it("defaults the pre-launch feature gate closed", () => {
    expect(BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE.enabled).toBe(false);
  });

  it("rejects a non-integer value", () => {
    expect(() =>
      decodeBulkRepriceIngestionPolicyValue({ ...BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE, chunkSize: 1.5 }),
    ).toThrow(/chunkSize/);
  });

  it("rejects create-job rate-limit dials out of bounds", () => {
    expect(() =>
      decodeBulkRepriceIngestionPolicyValue({
        ...BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE,
        createJobRateLimitMax: 0,
      }),
    ).toThrow(/createJobRateLimitMax/);
    expect(() =>
      decodeBulkRepriceIngestionPolicyValue({
        ...BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE,
        createJobRateLimitWindowMs: 999,
      }),
    ).toThrow(/createJobRateLimitWindowMs/);
  });

  it("adds rate-limit defaults to policy documents authored before those dials existed", () => {
    const previousDocument = {
      enabled: false,
      chunkSize: 200,
      yieldIntervalMs: 25,
      maxActiveJobsPerAccount: 1,
      maxRowsPerUpload: 250_000,
    };

    expect(decodeBulkRepriceIngestionPolicyValue(previousDocument)).toEqual(BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE);
  });
});
