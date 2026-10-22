import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { classifyReleaseHealthArtifacts } from "./release-health-report.mjs";
import {
  evaluateReleaseLock,
  evaluateReleaseLockWithResolution,
  normalizeEmergencyReference,
  parseReleaseLockOptions,
  validateLockExitRoute,
  validateLockCreationDeadline,
  releaseLockRefusal,
} from "./release-lock.mjs";

const exitRoute = JSON.stringify({
  kind: "host-revert",
  reference: "https://github.com/chase-sets/chase-sets/issues/10391",
});
const deadline = "2099-05-31T12:00:00Z";

describe("five-field lock lifecycle", () => {
  it("keeps versioned historical artifacts readable without fabricating current lock authority", () => {
    const fixture = JSON.parse(readFileSync("scripts/fixtures/release-lock/historical-v1.json", "utf8"));
    expect(classifyReleaseHealthArtifacts([{ file: "old.json", record: fixture.health }]).releaseRecords).toEqual([
      fixture.health,
    ]);
    expect(fixture.health.releaseLock).not.toHaveProperty("exitRoute");
    expect(fixture.check).not.toHaveProperty("lockDeadline");
    expect(
      evaluateReleaseLock({ releaseLocked: "true", lockReason: fixture.check.lockReason, emergencyBypass: "false" })
        .lockState,
    ).toBe("invalid");
  });

  it("names route, deadline and host escalation without telling the caller to bypass", () => {
    const text = releaseLockRefusal(
      evaluateReleaseLock({
        releaseLocked: "true",
        lockReason: "hold",
        lockExitRoute: exitRoute,
        lockDeadline: deadline,
      }),
    );
    expect(text).toContain(`Exit route: ${exitRoute}`);
    expect(text).toContain(`Deadline: ${deadline}`);
    expect(text).toContain("Host/orchestrator");
    expect(text).not.toContain("Set EMERGENCY_RELEASE_BYPASS");
  });
  it("ignores false stale malformed fields instead of retaining stale reference authority", () => {
    const result = evaluateReleaseLock({
      releaseLocked: "false",
      lockReason: "stale",
      lockReference: "stale",
      lockExitRoute: "not json",
      lockDeadline: "yesterday",
      emergencyBypass: "false",
    });
    expect(result).toMatchObject({
      deploymentAllowed: true,
      releaseLocked: false,
      lockReason: null,
      lockReference: null,
      lockExitRoute: null,
      lockDeadline: null,
    });
    expect(result.errors).toBeUndefined();
  });

  it("refuses legacy true locks and requires host escalation without granting bypass", () => {
    const result = evaluateReleaseLock({ releaseLocked: "true", lockReason: "legacy", emergencyBypass: "false" });
    expect(result.deploymentAllowed).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        "PRODUCTION_RELEASE_LOCK_EXIT_ROUTE is required when PRODUCTION_RELEASE_LOCKED=true.",
        "PRODUCTION_RELEASE_LOCK_DEADLINE is required when PRODUCTION_RELEASE_LOCKED=true.",
      ]),
    );
  });

  it.each([
    {},
    { kind: "production-workflow", reference: "https://github.com/chase-sets/chase-sets/issues/10391" },
    { kind: "host-revert", reference: { url: "https://github.com/chase-sets/chase-sets/issues/10391" } },
    { kind: "host-revert", reference: "https://github.com/chase-sets/chase-sets/pull/10391" },
    { kind: "host-revert", reference: "https://github.com/other/repo/issues/10391" },
    { kind: "host-revert", reference: "https://github.com/chase-sets/chase-sets/issues/not-a-number" },
    { kind: "host-revert", reference: "https://github.com/chase-sets/chase-sets/issues/0" },
    { kind: "host-revert", reference: "https://github.com/chase-sets/chase-sets/issues/10391", extra: {} },
    {
      kind: "staging-workflow",
      workflow: "platform-production.yml",
      reference: "https://github.com/chase-sets/chase-sets/issues/10391",
    },
  ])("rejects closed route schema and issue URL violations %j", (route) => {
    expect(validateLockExitRoute(JSON.stringify(route)).errors.length).toBeGreaterThan(0);
  });

  it("bounds routes and accepts only the independent staging workflow or host revert offline", () => {
    expect(validateLockExitRoute("x".repeat(2049)).errors).toContain(
      "PRODUCTION_RELEASE_LOCK_EXIT_ROUTE must be at most 2048 bytes.",
    );
    expect(validateLockExitRoute(exitRoute).errors).toEqual([]);
    const padded = " ".repeat(2048) + exitRoute;
    const effective = parseReleaseLockOptions([], {
      PRODUCTION_RELEASE_LOCKED: "true",
      PRODUCTION_RELEASE_LOCK_REASON: "hold",
      PRODUCTION_RELEASE_LOCK_EXIT_ROUTE: padded,
      PRODUCTION_RELEASE_LOCK_DEADLINE: deadline,
    });
    expect(evaluateReleaseLock(effective).errors).toContain(
      "PRODUCTION_RELEASE_LOCK_EXIT_ROUTE must be at most 2048 bytes.",
    );
    expect(
      validateLockExitRoute(
        JSON.stringify({
          kind: "staging-workflow",
          workflow: "platform-staging-cluster-addons.yml",
          reference: "https://github.com/chase-sets/chase-sets/issues/10391",
        }),
      ).errors,
    ).toEqual([]);
  });

  it.each(["null", "[]", "false", "{malformed", '"host-revert"'])("refuses non-object route data %s", (value) => {
    expect(validateLockExitRoute(value).errors.length).toBeGreaterThan(0);
  });

  it("accepts timezone-qualified creation at the seven-day boundary, never beyond it", () => {
    const now = "2026-10-22T12:00:00Z";
    expect(validateLockCreationDeadline("2026-10-29T07:00:00-05:00", { now }).errors).toEqual([]);
    expect(validateLockCreationDeadline("2026-10-29T12:00:00.001Z", { now }).errors.length).toBeGreaterThan(0);
  });

  it.each([
    "",
    "2026-10-22",
    "2026-10-22T12:00:00",
    "2026-10-20T12:00:00Z",
    "2026-10-30T12:00:00Z",
    "2026-02-30T12:00:00Z",
    "2026-10-22T24:00:00Z",
  ])("rejects invalid creation deadline %s", (value) => {
    expect(validateLockCreationDeadline(value, { now: "2026-10-22T12:00:00Z" }).errors.length).toBeGreaterThan(0);
  });

  it("refuses an overdue normal lock but preserves separately audited emergency reporting", () => {
    const input = {
      releaseLocked: "true",
      lockReason: "hold",
      lockReference: "lock incident",
      lockExitRoute: exitRoute,
      lockDeadline: "2026-10-22T12:00:00Z",
      checkedAt: "2026-10-22T12:01:00Z",
    };
    expect(evaluateReleaseLock({ ...input, emergencyBypass: "false" })).toMatchObject({
      deploymentAllowed: false,
      lockDeadlineOverdue: true,
    });
    expect(evaluateReleaseLock({ ...input, emergencyBypass: "true", emergencyReference: "INC-123" })).toMatchObject({
      deploymentAllowed: true,
      lockReference: "lock incident",
      emergencyReference: "INC-123",
      releaseMode: "emergency",
    });
  });

  it("pins the production lock ahead of configuration and every named production mutation", () => {
    const workflow = parse(readFileSync(".github/workflows/platform-production.yml", "utf8"));
    const job = workflow.jobs["deploy-production"];
    const names = job.steps.map((step) => step.name);
    const gate = names.indexOf("Evaluate production release lock");
    expect(gate).toBeGreaterThan(-1);
    const inventory = [
      "Validate production configuration",
      "Initialize production environment DNS",
      "Plan production environment DNS",
      "Apply production environment DNS",
      "Terraform init",
      "Terraform plan",
      "Clean up expired restore-point forks",
      "Create production database restore point",
      "Configure production Kubernetes context",
      "Install production DOKS ingress and certificate add-ons",
      "Capture production rollback target",
      "Terraform apply",
      "Apply production Kubernetes runtime secrets",
      "Reconcile production managed Postgres CA trust",
      "Deploy production Kubernetes release",
      "Promote production Argo Rollouts",
      "Abort production Argo Rollouts",
      "Roll back production Kubernetes release",
      "Mark production release",
    ];
    for (const name of inventory) {
      expect(names.indexOf(name), name).toBeGreaterThan(gate);
    }
    const respectsOrder = (steps) =>
      inventory.every((name) => steps.indexOf(name) > steps.indexOf("Evaluate production release lock"));
    expect(respectsOrder(names)).toBe(true);
    const mutant = names.filter((name) => name !== "Evaluate production release lock");
    mutant.splice(mutant.indexOf("Validate production configuration") + 1, 0, "Evaluate production release lock");
    expect(respectsOrder(mutant)).toBe(false);
    for (const field of [
      "PRODUCTION_RELEASE_LOCKED",
      "PRODUCTION_RELEASE_LOCK_REASON",
      "PRODUCTION_RELEASE_LOCK_REFERENCE",
      "PRODUCTION_RELEASE_LOCK_EXIT_ROUTE",
      "PRODUCTION_RELEASE_LOCK_DEADLINE",
    ]) {
      expect(job.env[field]).toContain(`vars.${field}`);
    }
  });

  it("keeps both runbooks on five-field create/clear order, host readback and non-release escalation", () => {
    const primary = readFileSync("docs/runbooks/release-process-evolution.md", "utf8");
    const operations = readFileSync("docs/runbooks/doks-platform-operations.md", "utf8");
    for (const field of [
      "PRODUCTION_RELEASE_LOCKED",
      "PRODUCTION_RELEASE_LOCK_REASON",
      "PRODUCTION_RELEASE_LOCK_REFERENCE",
      "PRODUCTION_RELEASE_LOCK_EXIT_ROUTE",
      "PRODUCTION_RELEASE_LOCK_DEADLINE",
    ])
      expect(primary).toContain(field);
    for (const doc of [primary, operations]) {
      expect(doc).toMatch(/release-lock:commands --action lock[^\r\n]+--exit-route \$exitRoute --deadline \$deadline/);
      expect(doc).toContain("release-lock:commands --action unlock");
      expect(doc).toMatch(/TRUE LAST|LOCKED=true` \*\*last\*\*/i);
      expect(doc).toMatch(/FALSE FIRST|LOCKED=false` \*\*first\*\*/i);
      expect(doc).toContain("platform-production-lock-monitor.yml --ref main");
      expect(doc).toContain("protection/branch policy");
      expect(doc).toMatch(/legacy\/invalid/);
      expect(doc).toContain("unknown");
    }
  });
});

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
      lockExitRoute: exitRoute,
      lockDeadline: deadline,
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
      lockExitRoute: exitRoute,
      lockDeadline: deadline,
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
      lockExitRoute: exitRoute,
      lockDeadline: deadline,
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
        lockExitRoute: exitRoute,
        lockDeadline: deadline,
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
        lockExitRoute: exitRoute,
        lockDeadline: deadline,
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
        lockExitRoute: exitRoute,
        lockDeadline: deadline,
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
      lockExitRoute: exitRoute,
      lockDeadline: deadline,
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
      PRODUCTION_RELEASE_LOCK_EXIT_ROUTE: exitRoute,
      PRODUCTION_RELEASE_LOCK_DEADLINE: deadline,
      EMERGENCY_RELEASE_BYPASS: "FALSE",
    });

    expect(options).toMatchObject({
      environmentName: "production",
      releaseCommit: "f".repeat(40),
      releaseLocked: "true",
      lockReason: "maintenance",
      lockExitRoute: exitRoute,
      lockDeadline: deadline,
      emergencyBypass: "false",
    });
  });
});
