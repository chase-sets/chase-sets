import { describe, expect, it } from "vitest";
import {
  evaluateReleaseLock,
  evaluateReleaseLockWithResolution,
  normalizeEmergencyReference,
  parseReleaseLockOptions,
} from "./release-lock.mjs";

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
      emergencyReference: "INC-2026-05-31-123",
    });

    expect(result).toMatchObject({
      deploymentAllowed: true,
      releaseLocked: true,
      releaseMode: "emergency",
      emergencyReference: "INC-2026-05-31-123",
      emergencyReferenceKind: "incident",
      validatedEmergencyReference: "INC-2026-05-31-123",
    });
  });

  it("rejects malformed and free-text emergency bypass references", () => {
    const result = evaluateReleaseLock({
      environmentName: "production",
      releaseCommit: "c".repeat(40),
      releaseLocked: "true",
      lockReason: "Checkout incident mitigation",
      lockReference: "INC-2026-05-31-002",
      emergencyBypass: "true",
      emergencyReference: "fix forward please",
    });

    expect(result.deploymentAllowed).toBe(false);
    expect(result.errors).toContain(
      "EMERGENCY_RELEASE_REFERENCE must be an incident reference or a GitHub issue/PR reference when EMERGENCY_RELEASE_BYPASS=true.",
    );
    expect(normalizeEmergencyReference("fix forward ISSUE-6265 please")).toBeNull();
    expect(normalizeEmergencyReference("chase-sets/chase-sets#not-a-number")).toBeNull();
    expect(normalizeEmergencyReference("https://github.com/chase-sets/chase-sets/discussions/6265")).toBeNull();
  });

  it("normalizes incident, full GitHub URL, canonical GitHub, and local GitHub references", () => {
    expect(normalizeEmergencyReference("inc-2026-05-31-123")).toEqual({
      kind: "incident",
      reference: "INC-2026-05-31-123",
    });
    expect(normalizeEmergencyReference("https://github.com/chase-sets/chase-sets/issues/6265")).toEqual({
      kind: "github",
      owner: "chase-sets",
      repo: "chase-sets",
      number: 6265,
      reference: "chase-sets/chase-sets#6265",
    });
    expect(normalizeEmergencyReference("chase-sets/chase-sets#6265")).toEqual({
      kind: "github",
      owner: "chase-sets",
      repo: "chase-sets",
      number: 6265,
      reference: "chase-sets/chase-sets#6265",
    });
    expect(normalizeEmergencyReference("#2797")).toEqual({
      kind: "github",
      number: 2797,
      reference: "#2797",
    });
    expect(normalizeEmergencyReference("https://github.com/chase-sets/chase-sets/pull/2865")).toEqual({
      kind: "github",
      owner: "chase-sets",
      repo: "chase-sets",
      number: 2865,
      reference: "chase-sets/chase-sets#2865",
    });
  });

  it("resolves the full issue URL rejected by Platform Deploy run 30410644170", async () => {
    const fetch = async (url, init) => {
      expect(url).toBe("https://api.github.test/repos/chase-sets/chase-sets/issues/6265");
      expect(init.headers.authorization).toBe("Bearer token");
      return {
        ok: true,
        status: 200,
        json: async () => ({ html_url: "https://github.com/chase-sets/chase-sets/issues/6265" }),
      };
    };

    const result = await evaluateReleaseLockWithResolution(
      {
        environmentName: "production",
        releaseCommit: "1fa28b8f485b9ffe13c07bf3839896c1ac0ed06f",
        releaseLocked: "true",
        lockReason: "DOKS production compute recovery for live/marker identity mismatch",
        lockReference: "https://github.com/chase-sets/chase-sets/issues/6265",
        emergencyBypass: "true",
        emergencyReference: "https://github.com/chase-sets/chase-sets/issues/6265",
        githubRepository: "chase-sets/chase-sets",
        githubToken: "token",
        githubApiUrl: "https://api.github.test",
      },
      { fetch },
    );

    expect(result).toMatchObject({
      deploymentAllowed: true,
      emergencyReferenceKind: "github",
      validatedEmergencyReference: "chase-sets/chase-sets#6265",
      emergencyReferenceUrl: "https://github.com/chase-sets/chase-sets/issues/6265",
    });
  });

  it("fails closed when a GitHub emergency reference does not resolve", async () => {
    const result = await evaluateReleaseLockWithResolution(
      {
        environmentName: "production",
        releaseCommit: "c".repeat(40),
        releaseLocked: "true",
        lockReason: "Checkout incident mitigation",
        lockReference: "INC-2026-05-31-002",
        emergencyBypass: "true",
        emergencyReference: "#404",
        githubRepository: "chase-sets/chase-sets",
        githubToken: "token",
        githubApiUrl: "https://api.github.test",
      },
      {
        fetch: async () => ({ ok: false, status: 404 }),
      },
    );

    expect(result.deploymentAllowed).toBe(false);
    expect(result.errors).toContain("EMERGENCY_RELEASE_REFERENCE #404 did not resolve to an existing issue or PR.");
  });

  it("allows emergency bypass when a GitHub reference resolves", async () => {
    const result = await evaluateReleaseLockWithResolution(
      {
        environmentName: "production",
        releaseCommit: "c".repeat(40),
        releaseLocked: "true",
        lockReason: "Checkout incident mitigation",
        lockReference: "INC-2026-05-31-002",
        emergencyBypass: "true",
        emergencyReference: "PR-2797",
        githubRepository: "chase-sets/chase-sets",
        githubToken: "token",
        githubApiUrl: "https://api.github.test",
      },
      {
        fetch: async (url, init) => {
          expect(url).toBe("https://api.github.test/repos/chase-sets/chase-sets/issues/2797");
          expect(init.headers.authorization).toBe("Bearer token");
          return {
            ok: true,
            status: 200,
            json: async () => ({ html_url: "https://github.com/chase-sets/chase-sets/pull/2797" }),
          };
        },
      },
    );

    expect(result).toMatchObject({
      deploymentAllowed: true,
      emergencyReferenceKind: "github",
      validatedEmergencyReference: "chase-sets/chase-sets#2797",
      emergencyReferenceUrl: "https://github.com/chase-sets/chase-sets/pull/2797",
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
