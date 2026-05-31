import { describe, expect, it } from "vitest";
import { evaluateReleaseLock, parseReleaseLockOptions } from "./release-lock.mjs";

describe("release lock check", () => {
  it("allows normal production deployment when no lock is active", () => {
    const result = evaluateReleaseLock({
      environmentName: "production",
      releaseCommit: "a".repeat(40),
      releaseLocked: "false",
      lockReason: "",
      lockReference: "",
      emergencyBypass: "false",
      emergencyReference: "",
    });

    expect(result).toMatchObject({
      deploymentAllowed: true,
      releaseLocked: false,
      releaseMode: "normal",
    });
  });

  it("blocks production deployment when the release lock is active", () => {
    const result = evaluateReleaseLock({
      environmentName: "production",
      releaseCommit: "b".repeat(40),
      releaseLocked: "true",
      lockReason: "Investigating payment provider incident",
      lockReference: "INC-2026-05-31-001",
      emergencyBypass: "false",
      emergencyReference: "",
    });

    expect(result).toMatchObject({
      deploymentAllowed: false,
      releaseLocked: true,
      releaseMode: "normal",
      lockReason: "Investigating payment provider incident",
      lockReference: "INC-2026-05-31-001",
    });
  });

  it("allows an audited emergency release through an active lock", () => {
    const result = evaluateReleaseLock({
      environmentName: "production",
      releaseCommit: "c".repeat(40),
      releaseLocked: "true",
      lockReason: "Checkout incident mitigation",
      lockReference: "INC-2026-05-31-002",
      emergencyBypass: "true",
      emergencyReference: "FIX-FORWARD-PR-123",
    });

    expect(result).toMatchObject({
      deploymentAllowed: true,
      releaseLocked: true,
      releaseMode: "emergency",
      emergencyReference: "FIX-FORWARD-PR-123",
    });
  });

  it("requires an incident reason for active locks", () => {
    const result = evaluateReleaseLock({
      environmentName: "production",
      releaseCommit: "d".repeat(40),
      releaseLocked: "true",
      lockReason: "",
      lockReference: "",
      emergencyBypass: "false",
      emergencyReference: "",
    });

    expect(result.deploymentAllowed).toBe(false);
    expect(result.errors).toContain("PRODUCTION_RELEASE_LOCK_REASON is required when PRODUCTION_RELEASE_LOCKED=true.");
  });

  it("requires a reference before emergency bypass can deploy", () => {
    const result = evaluateReleaseLock({
      environmentName: "production",
      releaseCommit: "e".repeat(40),
      releaseLocked: "true",
      lockReason: "Incident",
      lockReference: "INC-1",
      emergencyBypass: "true",
      emergencyReference: "",
    });

    expect(result.deploymentAllowed).toBe(false);
    expect(result.errors).toContain("EMERGENCY_RELEASE_REFERENCE is required when EMERGENCY_RELEASE_BYPASS=true.");
  });

  it("normalizes GitHub workflow environment values", () => {
    const options = parseReleaseLockOptions([], {
      RELEASE_ENVIRONMENT: "production",
      RELEASE_COMMIT: "f".repeat(40),
      PRODUCTION_RELEASE_LOCKED: "TRUE",
      PRODUCTION_RELEASE_LOCK_REASON: "maintenance",
      EMERGENCY_RELEASE_BYPASS: "FALSE",
    });

    expect(options).toMatchObject({
      environmentName: "production",
      releaseCommit: "f".repeat(40),
      releaseLocked: "true",
      lockReason: "maintenance",
      emergencyBypass: "false",
    });
  });
});
