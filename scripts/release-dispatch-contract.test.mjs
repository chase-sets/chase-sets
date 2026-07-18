import { describe, expect, it } from "vitest";
import { parseReleaseDispatchContractArgs, validateReleaseDispatchContract } from "./release-dispatch-contract.mjs";

const releaseCommit = "a".repeat(40);

describe("release dispatch contract", () => {
  it("accepts automatic provenance metadata", () => {
    expect(
      validateReleaseDispatchContract({
        releaseCommit,
        source: "automatic",
        dispatchRunId: "123",
        dispatchAttempt: "2",
      }),
    ).toEqual({
      errors: [],
      contract: {
        releaseCommit,
        source: "automatic",
        dispatchRunId: "123",
        dispatchAttempt: "2",
        reason: null,
      },
    });
  });

  it.each(["manual", "recovery"])("requires an audited reason for %s releases", (source) => {
    expect(validateReleaseDispatchContract({ releaseCommit, source }).errors).toContain(
      "reason is required for manual, recovery, and emergency releases.",
    );
    expect(validateReleaseDispatchContract({ releaseCommit, source, reason: "operator retry" }).errors).toEqual([]);
  });

  it("keeps emergency source, flag, and reference aligned", () => {
    expect(
      validateReleaseDispatchContract({
        releaseCommit,
        source: "emergency",
        reason: "fix forward",
        emergencyRelease: "true",
        emergencyReference: "INC-123",
      }).errors,
    ).toEqual([]);
    expect(
      validateReleaseDispatchContract({ releaseCommit, source: "emergency", reason: "fix forward" }).errors,
    ).toEqual([
      "emergency_release must be true when dispatch_source is emergency.",
      "emergency_reference is required for emergency releases.",
    ]);
  });

  it("rejects malformed or misplaced automatic metadata", () => {
    expect(
      validateReleaseDispatchContract({
        releaseCommit: "main",
        source: "automatic",
        dispatchRunId: "0",
        dispatchAttempt: "nope",
      }).errors,
    ).toEqual([
      "release_commit must resolve to a 40-character Git commit SHA.",
      "dispatch_run_id is required and must be a positive integer for automatic releases.",
      "dispatch_attempt is required and must be a positive integer for automatic releases.",
    ]);
    expect(
      validateReleaseDispatchContract({
        releaseCommit,
        source: "manual",
        reason: "operator request",
        dispatchRunId: "123",
      }).errors,
    ).toContain("dispatch_run_id and dispatch_attempt are only valid for automatic releases.");
  });

  it("parses CLI and workflow environment inputs", () => {
    expect(
      parseReleaseDispatchContractArgs(["--source", "recovery", "--reason", "retry"], {
        RELEASE_COMMIT: releaseCommit,
        DISPATCH_RUN_ID: "",
        DISPATCH_ATTEMPT: "",
        EMERGENCY_RELEASE: "false",
      }),
    ).toMatchObject({ releaseCommit, source: "recovery", reason: "retry", emergencyRelease: "false" });
  });
});
