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
  });

  it("rejects a non-integer value", () => {
    expect(() =>
      decodeBulkRepriceIngestionPolicyValue({ ...BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE, chunkSize: 1.5 }),
    ).toThrow(/chunkSize/);
  });
});
