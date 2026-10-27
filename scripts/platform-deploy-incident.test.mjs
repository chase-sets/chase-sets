import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEPLOY_ROOT_CAUSE_CODES,
  buildDeployIncidentBody,
  buildSupersededNoOpResolutionComment,
  classifyDeploymentRootCause,
  classifyPlatformDeployRun,
  classifySupersededNoOpIncident,
  parsePlatformDeployIncidentOptions,
  readDeployDiagnostics,
  redactDeployDiagnosticText,
  renderDeployRootCauseSummary,
} from "./platform-deploy-incident.mjs";
import * as platformDeployIncident from "./platform-deploy-incident.mjs";

const fixtureDirectory = resolve("scripts/fixtures/platform-deploy-incidents");
const rootCauseFixtures = readdirSync(fixtureDirectory)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(resolve(fixtureDirectory, name), "utf8")));

describe("platform deploy incident classification", () => {
  it("closes a superseded production run with successful dependencies", () => {
    expect(
      classifyPlatformDeployRun({
        resolveReleaseResult: "success",
        buildImageResult: "success",
        deployStagingResult: "success",
        deployProductionResult: "success",
        productionSuperseded: "true",
        recordStagingHealthResult: "success",
      }),
    ).toMatchObject({ action: "close", kind: "superseded-no-op", noOp: true });
  });

  it("closes a staging run that reports applied=false before production", () => {
    expect(
      classifyPlatformDeployRun({
        resolveReleaseResult: "success",
        buildImageResult: "success",
        deployStagingResult: "success",
        stagingApplied: "false",
        deployProductionResult: "skipped",
        recordStagingHealthResult: "success",
      }),
    ).toMatchObject({ action: "close", reason: "superseded-pre-mutation", noOp: true });
  });

  it("supports the pre-applied-signal workflow as a legacy no-op", () => {
    expect(
      classifyPlatformDeployRun({
        resolveReleaseResult: "success",
        buildImageResult: "success",
        deployStagingResult: "success",
        deployProductionResult: "skipped",
        recordStagingHealthResult: "success",
      }).noOp,
    ).toBe(true);
  });

  it("leaves a real staging failure open even when production was skipped", () => {
    expect(
      classifyPlatformDeployRun({
        resolveReleaseResult: "success",
        buildImageResult: "success",
        deployStagingResult: "failure",
        stagingApplied: "false",
        deployProductionResult: "skipped",
        recordStagingHealthResult: "success",
      }),
    ).toMatchObject({ action: "create-or-update", kind: "deploy-failure", noOp: false });
  });

  it("maps legacy staging bootstrap classifications into the stable public taxonomy", () => {
    expect(
      classifyPlatformDeployRun({
        resolveReleaseResult: "success",
        buildImageResult: "success",
        deployStagingResult: "failure",
        deployProductionResult: "skipped",
        recordStagingHealthResult: "success",
        stagingRootCauseCode: "staging-bootstrap-schema-lock-timeout",
      }),
    ).toMatchObject({
      action: "create-or-update",
      reason: "doks-bootstrap-or-migration",
      rootCauseCode: "doks-bootstrap-or-migration",
    });
  });

  it("leaves an applied successful run open only when another dependency failed", () => {
    expect(
      classifyPlatformDeployRun({
        resolveReleaseResult: "success",
        buildImageResult: "success",
        deployStagingResult: "success",
        stagingApplied: "true",
        deployProductionResult: "failure",
        productionSuperseded: "false",
        recordStagingHealthResult: "success",
      }).action,
    ).toBe("create-or-update");
  });

  it("recognizes historical superseded no-op incident issues", () => {
    expect(
      classifySupersededNoOpIncident({
        title: "Incident: Platform Deploy superseded before production for 54219d973a71",
        body: [
          "Automated production deploy incident signal.",
          "- Kind: production-superseded",
          "- Deploy Staging: success",
          "- Deploy Production: success",
          "- Superseded by commit: f0690eb170721742a7244d150318b2c411f201ef",
        ].join("\n"),
      }),
    ).toMatchObject({ action: "close", noOp: true });
  });

  it("does not classify a failed incident as a superseded no-op", () => {
    expect(
      classifySupersededNoOpIncident({
        title: "Incident: Platform Deploy failed for b7a7d831c859",
        body: "- Kind: production-deploy-failure\n- Deploy Staging: failure\n- Deploy Production: skipped",
      }),
    ).toMatchObject({ action: "leave-open", noOp: false });
  });

  it("builds an evidence-bearing resolution comment", () => {
    expect(
      buildSupersededNoOpResolutionComment({
        runUrl: "https://github.com/chase-sets/chase-sets/actions/runs/123",
        releaseCommit: "a".repeat(40),
        supersededByCommit: "b".repeat(40),
        reason: "staging-superseded-before-apply",
      }),
    ).toContain("The newer release owns the deploy lane");
    expect(
      buildSupersededNoOpResolutionComment({
        runUrl: "run",
        releaseCommit: "release",
        supersededByCommit: "replacement",
        reason: "reason",
      }),
    ).toMatch(/run[\s\S]*release[\s\S]*replacement[\s\S]*reason/);
  });

  it("reads classifier inputs from the workflow environment", () => {
    expect(
      parsePlatformDeployIncidentOptions([], {
        RESOLVE_RELEASE_RESULT: "success",
        DEPLOY_STAGING_RESULT: "success",
        STAGING_APPLIED: "false",
        STAGING_FAILURE_CLASSIFICATION: "staging-bootstrap-timeout",
      }),
    ).toMatchObject({
      command: "classify-run",
      resolveReleaseResult: "success",
      deployStagingResult: "success",
      stagingApplied: "false",
      stagingRootCauseCode: "staging-bootstrap-timeout",
    });
  });
});

describe("deployment root-cause taxonomy", () => {
  it("keeps the initial stable taxonomy in order", () => {
    const initial = [
      "doks-bootstrap-or-migration",
      "terraform-provider-or-state",
      "staging-dns",
      "staging-advisory-seed-or-e2e",
      "blocking-staging-verification",
      "production-verification",
      "superseded-pre-mutation",
      "unknown",
    ];
    expect(DEPLOY_ROOT_CAUSE_CODES.filter((code) => initial.includes(code))).toEqual(initial);
  });

  for (const fixture of rootCauseFixtures) {
    it(`classifies fixture: ${fixture.name}`, () => {
      expect(classifyDeploymentRootCause(fixture.input)).toMatchObject(fixture.expected);
    });
  }

  it("renders the same concise root cause into the artifact, summary, and incident body", () => {
    const fixture = rootCauseFixtures.find(({ expected }) => expected.rootCauseCode === "doks-bootstrap-or-migration");
    const artifact = classifyDeploymentRootCause(fixture.input);
    const summary = renderDeployRootCauseSummary(artifact);
    const body = buildDeployIncidentBody({
      ...artifact,
      rootCausePhase: artifact.phase,
      runUrl: "https://github.com/chase-sets/chase-sets/actions/runs/29333994354",
      releaseCommit: "a".repeat(40),
      artifactsUrl: "https://github.com/chase-sets/chase-sets/actions/runs/29333994354/artifacts",
    });

    expect(artifact).toMatchObject({
      schemaVersion: "platform-deploy-root-cause/v1",
      rootCauseCode: "doks-bootstrap-or-migration",
      affectedComponent: "platform-bootstrap",
      blocking: true,
    });
    for (const output of [summary, body]) {
      expect(output).toContain("doks-bootstrap-or-migration");
      expect(output).toContain(artifact.rootCauseSummary);
      expect(output).toContain(artifact.remediation);
    }
    expect(body).toContain("29333994354");
    expect(body).toContain(artifact.rootCauseSignature);
    expect(body).not.toContain("fixture-secret");
  });

  it("redacts tokens, connection strings, cookies, authorization headers, JSON secrets, and private keys", () => {
    const redacted = redactDeployDiagnosticText(
      [
        "Authorization: Bearer bearer-secret",
        "proxy-authorization: Basic basic-secret",
        "postgresql://user:password@db.example/marketplace",
        "redis://default:password@cache.example/0",
        "cookie=session-cookie",
        "Set-Cookie: auth=cookie-value",
        "Cookie: session=first-cookie-secret; refresh=second-cookie-secret",
        "https://deploy-user:generic-url-password@provider.example/path",
        "Pwd=connection-password",
        "DATABASE_URL_MARKETPLACE=opaque-environment-secret",
        '{"token":"json-secret","database_url":"postgres://hidden"}',
        'escaped={\\"token\\":\\"escaped-json-secret\\"}',
        "dop_v1_provider_token",
        "-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----",
        "Missing DATABASE_URL_MARKETPLACE",
      ].join("\n"),
    );

    for (const secret of [
      "bearer-secret",
      "basic-secret",
      "user:password",
      "default:password",
      "session-cookie",
      "cookie-value",
      "first-cookie-secret",
      "second-cookie-secret",
      "deploy-user",
      "generic-url-password",
      "connection-password",
      "opaque-environment-secret",
      "json-secret",
      "escaped-json-secret",
      "provider_token",
      "private-material",
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain("Missing DATABASE_URL_MARKETPLACE");
  });

  it("reads raw Terraform stderr diagnostics and lets text evidence outrank a production phase", () => {
    const directory = mkdtempSync(join(tmpdir(), "platform-deploy-diagnostics-"));
    const diagnosticsPath = join(directory, "terraform-stderr.txt");
    try {
      writeFileSync(diagnosticsPath, "Error acquiring the state lock: conditional request failed\n");
      const diagnostics = readDeployDiagnostics([diagnosticsPath]);

      expect(classifyDeploymentRootCause({ phase: "production-verification", diagnostics })).toMatchObject({
        rootCauseCode: "terraform-provider-or-state",
        providerReason: "Error acquiring the state lock: conditional request failed",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("matches staging DNS failure text without case sensitivity", () => {
    expect(
      classifyDeploymentRootCause({
        phase: "staging-deploy",
        steps: [
          {
            name: "domain-attachment",
            phase: "ERROR",
            reasonCode: "ProviderFailure",
            message: "Domain name already exists on another app",
          },
        ],
      }),
    ).toMatchObject({ rootCauseCode: "staging-dns" });
  });

  it("uses normalized provider reasons to distinguish unknown-failure signatures", () => {
    const classifyUnknown = (message) =>
      classifyDeploymentRootCause({
        phase: "staging-deploy",
        steps: [{ name: "provider", phase: "ERROR", reasonCode: "ProviderFailure", message }],
      });

    const first = classifyUnknown("Unexpected upstream response");
    const equivalent = classifyUnknown("  unexpected   UPSTREAM response  ");
    const unrelated = classifyUnknown("Provider quota was exhausted");

    expect(first.rootCauseSignature).toBe(equivalent.rootCauseSignature);
    expect(unrelated.rootCauseSignature).not.toBe(first.rootCauseSignature);
  });

  it("takes providerReason from the step that drove a multi-failure classification", () => {
    const result = classifyDeploymentRootCause({
      phase: "staging-deploy",
      steps: [
        {
          name: "terraform",
          componentName: "terraform",
          phase: "ERROR",
          reasonCode: "StateLockFailure",
          message: "Error acquiring the state lock",
        },
        {
          name: "platform-bootstrap",
          componentName: "platform-bootstrap",
          phase: "ERROR",
          reasonCode: "DeployContainerExitNonZero",
          message: "Bootstrap process exited unsuccessfully",
        },
      ],
    });

    expect(result).toMatchObject({
      rootCauseCode: "terraform-provider-or-state",
      affectedComponent: "terraform",
    });
    expect(result.providerReason).toContain("state lock");
  });
});

// Helm's stderr line 248 of Platform Deploy run 38672454609, job "Deploy Production" (2026-10-15).
const admissionNoAgentCall =
  'cannot patch "chase-sets-platform-doks-tls" with kind Certificate: Internal error occurred: failed calling webhook "webhook.cert-manager.io": failed to call webhook: Post "https://cert-manager-webhook.cert-manager.svc:443/validate?timeout=30s": No agent available';
const productionAdmissionTransientLine = `Error: UPGRADE FAILED: an error occurred while rolling back the release. original upgrade error: ${admissionNoAgentCall}: ${admissionNoAgentCall}`;
// Synthetic: the same original upgrade error after Helm's atomic rollback succeeded.
const syntheticRolledBackAdmissionTransientLine = `Error: UPGRADE FAILED: release chase-sets-platform failed, and has been rolled back due to atomic being set: ${admissionNoAgentCall}`;

describe("admission transient matcher", () => {
  it("returns the bounded redacted helm line for the verbatim production failure", () => {
    const line = platformDeployIncident.classifyAdmissionWebhookTransient(
      `Release "chase-sets-platform" has been upgraded.\n${productionAdmissionTransientLine}\n`,
    );
    expect(line).toBe(productionAdmissionTransientLine.slice("Error: ".length, "Error: ".length + 500));
    expect(line.length).toBeLessThanOrEqual(500);
    expect(line).toContain("No agent available");
    // The same line as GitHub's job log renders it, behind the step and timestamp columns.
    expect(
      platformDeployIncident.classifyAdmissionWebhookTransient(
        `Deploy Production\tDeploy production Kubernetes release\t2026-10-15T02:58:16.8734535Z ${productionAdmissionTransientLine}`,
      ),
    ).toBe(line);
  });

  it("matches the synthetic successful-rollback rendition and redacts what it returns", () => {
    expect(platformDeployIncident.classifyAdmissionWebhookTransient(syntheticRolledBackAdmissionTransientLine)).toBe(
      syntheticRolledBackAdmissionTransientLine.slice("Error: ".length),
    );
    const withCredential = syntheticRolledBackAdmissionTransientLine.replace(
      "?timeout=30s",
      "?timeout=30s&token=planted-admission-credential",
    );
    const redacted = platformDeployIncident.classifyAdmissionWebhookTransient(withCredential);
    expect(redacted).toContain("No agent available");
    expect(redacted).not.toContain("planted-admission-credential");
  });

  it.each([
    [
      "kubectl logs no-agent",
      'Error from server: Get "https://10.108.0.4:10250/containerLogs/chase-sets-platform/api-0/api": No agent available',
    ],
    [
      "webhook connection refused",
      productionAdmissionTransientLine.replaceAll(
        "No agent available",
        "dial tcp 10.108.83.28:443: connect: connection refused",
      ),
    ],
    [
      "webhook context deadline exceeded",
      syntheticRolledBackAdmissionTransientLine.replace("No agent available", "context deadline exceeded"),
    ],
    [
      "timed out waiting for the condition",
      "Error: UPGRADE FAILED: release chase-sets-platform failed, and has been rolled back due to atomic being set: timed out waiting for the condition",
    ],
    [
      "pre-upgrade hook failure",
      `Error: UPGRADE FAILED: release chase-sets-platform failed, and has been rolled back due to atomic being set: pre-upgrade hooks failed: 1 error occurred:\n\t* ${admissionNoAgentCall}`,
    ],
    [
      "post-upgrade hook failure carrying the admission call",
      `Error: UPGRADE FAILED: an error occurred while rolling back the release. original upgrade error: post-upgrade hooks failed: ${admissionNoAgentCall}: ${admissionNoAgentCall}`,
    ],
    [
      "no-agent rollback error behind a different original upgrade error",
      `Error: UPGRADE FAILED: an error occurred while rolling back the release. original upgrade error: timed out waiting for the condition: ${admissionNoAgentCall}`,
    ],
    ["admission call outside helm UPGRADE FAILED", `Error: ${admissionNoAgentCall}`],
    ["empty stderr", ""],
  ])("returns null for %s", (_name, text) => {
    expect(platformDeployIncident.classifyAdmissionWebhookTransient(text)).toBeNull();
  });
});

function deployAttemptsRecord(attempts) {
  const performed = attempts.length === 2;
  return {
    schemaVersion: "platform-kubernetes-deploy-attempts/v1",
    release: "chase-sets-platform",
    namespace: "chase-sets-platform",
    result: attempts.at(-1).result,
    retry: performed ? "performed" : "refused",
    refusal: performed ? null : "probe-deadline",
    attempts,
    probeSamples: [
      { outcome: "success", elapsedMs: 900 },
      { outcome: performed ? "success" : "failure", elapsedMs: 10_900 },
    ],
    recovery: performed ? { sourceRevision: 692, resultingRevision: 695, rolledBack: true } : null,
    preRetryHistory: performed
      ? [
          {
            revision: 695,
            status: "deployed",
            // SHA-256 of "Rollback to 692": the record never carries a Helm description itself.
            descriptionSha256: "sha256:4c8dd2a754b6178a1e0b18fd3ccbda4b144635b3da140b76dffd50586950f3d4",
          },
        ]
      : null,
  };
}

describe("admission webhook root cause", () => {
  // The record carries the matcher's bounded line, asserted against the same text above.
  const transientLine = productionAdmissionTransientLine.slice("Error: ".length, "Error: ".length + 500);
  const transient = (attempt) => ({
    attempt,
    result: "failure",
    admissionWebhookTransient: transientLine,
    admissionWebhookTransientCode: "doks-admission-webhook-unreachable",
  });
  const untagged = (attempt, result = "failure") => ({
    attempt,
    result,
    admissionWebhookTransient: null,
    admissionWebhookTransientCode: null,
  });

  it("keeps closed staging-browser-install and doks-admission codes ahead of unknown", () => {
    expect(DEPLOY_ROOT_CAUSE_CODES.indexOf("staging-browser-install")).toBe(
      DEPLOY_ROOT_CAUSE_CODES.indexOf("unknown") - 1,
    );
    expect(DEPLOY_ROOT_CAUSE_CODES.indexOf("doks-admission-webhook-unreachable")).toBeLessThan(
      DEPLOY_ROOT_CAUSE_CODES.indexOf("unknown"),
    );
  });

  it.each([
    ["a refused retry", [transient(1)]],
    ["a failed retry", [transient(1), transient(2)]],
  ])("maps the attempts record of %s whose last attempt is transient", (_name, attempts) => {
    const result = classifyDeploymentRootCause({
      phase: "production-deploy",
      diagnostics: [
        { schemaVersion: "platform-kubernetes-diagnostics/v1", commands: [] },
        deployAttemptsRecord(attempts),
      ],
    });
    expect(result).toMatchObject({
      rootCauseCode: "doks-admission-webhook-unreachable",
      affectedComponent: "doks-control-plane",
      phase: "production-deploy",
      providerReason: transientLine,
      blocking: true,
    });
    expect(
      classifyPlatformDeployRun({ deployProductionResult: "failure", productionRootCauseCode: result.rootCauseCode }),
    ).toMatchObject({ reason: "doks-admission-webhook-unreachable", action: "create-or-update" });
  });

  it("trusts the recorded code for a bounded line cut before `No agent available`", () => {
    // Synthetic: a webhook path long enough that the 500-character bound drops the suffix.
    const longLine = platformDeployIncident.classifyAdmissionWebhookTransient(
      productionAdmissionTransientLine.replaceAll("/validate", `/synthetic-${"x".repeat(250)}`),
    );
    expect(longLine).toHaveLength(500);
    expect(longLine).not.toContain("No agent available");
    expect(platformDeployIncident.classifyAdmissionWebhookTransient(longLine)).toBeNull();
    const attempts = [1, 2].map((attempt) => ({ ...transient(attempt), admissionWebhookTransient: longLine }));
    expect(
      classifyDeploymentRootCause({ phase: "production-deploy", diagnostics: [deployAttemptsRecord(attempts)] }),
    ).toMatchObject({ rootCauseCode: "doks-admission-webhook-unreachable", providerReason: longLine });
  });

  // The existing invalid line: neither its text nor an unknown code is recognition.
  const invalidLine = "UPGRADE FAILED: timed out waiting for the condition";
  const longInvalidLine = `${invalidLine}: ${"synthetic-".repeat(60)}`.slice(0, 500);

  it.each([
    ["a non-transient last attempt", [untagged(1)]],
    ["a transient first attempt followed by a non-transient retry failure", [transient(1), untagged(2)]],
    ["a recovered retry", [transient(1), untagged(2, "success")]],
    ["an invalid line without a code", [{ ...untagged(1), admissionWebhookTransient: invalidLine }]],
    ["a long invalid line without a code", [{ ...untagged(1), admissionWebhookTransient: longInvalidLine }]],
    [
      "an untagged attempt carrying a transient line",
      [{ attempt: 1, result: "failure", admissionWebhookTransient: transientLine }],
    ],
    ["an unknown code", [{ ...transient(1), admissionWebhookTransientCode: "unknown" }]],
    ["another root-cause code", [{ ...transient(1), admissionWebhookTransientCode: "production-verification" }]],
    ["a code without its line", [{ ...transient(1), admissionWebhookTransient: null }]],
    ["a code with an empty line", [{ ...transient(1), admissionWebhookTransient: "" }]],
    ["a code with an unbounded line", [{ ...transient(1), admissionWebhookTransient: "x".repeat(501) }]],
    ["a code on a successful last attempt", [transient(1), { ...transient(2), result: "success" }]],
    ["an unknown attempt field", [{ ...transient(1), message: transientLine }]],
  ])("leaves %s to the existing classification", (_name, attempts) => {
    expect(
      classifyDeploymentRootCause({ phase: "production-deploy", diagnostics: [deployAttemptsRecord(attempts)] })
        .rootCauseCode,
    ).toBe("unknown");
  });

  it.each([
    ["a terminal result that is not its last attempt's", (record) => Object.assign(record, { result: "success" })],
    ["a third attempt", (record) => record.attempts.push(transient(3))],
    ["a misnumbered attempt", (record) => Object.assign(record.attempts[0], { attempt: 2 })],
    [
      "another schema version",
      (record) => Object.assign(record, { schemaVersion: "platform-kubernetes-deploy-attempts/v2" }),
    ],
  ])("rejects a record with %s", (_name, mutate) => {
    const record = deployAttemptsRecord([transient(1), transient(2)]);
    mutate(record);
    expect(classifyDeploymentRootCause({ phase: "production-deploy", diagnostics: [record] }).rootCauseCode).toBe(
      "unknown",
    );
  });

  it("reads the attempts record file the production classify step passes", () => {
    const directory = mkdtempSync(join(tmpdir(), "platform-deploy-attempts-"));
    const attemptsPath = join(directory, "production-kubernetes-deploy-attempts.json");
    try {
      writeFileSync(attemptsPath, `${JSON.stringify(deployAttemptsRecord([transient(1)]))}\n`);
      expect(
        classifyDeploymentRootCause({
          phase: "production-deploy",
          diagnostics: readDeployDiagnostics([join(directory, "absent-terraform.txt"), attemptsPath]),
        }).rootCauseCode,
      ).toBe("doks-admission-webhook-unreachable");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Agent Grant revocation activation root cause", () => {
  const status = (refusal) => ({ schemaVersion: "agent-grant-revocation-status/v1", result: "refused", refusal });

  it("classifies an activation refusal ahead of unrelated diagnostic text, carrying only its bounded code", () => {
    const result = classifyDeploymentRootCause({
      phase: "agent-grant-revocation-activation",
      diagnostics: ["lock_timeout during migration failed", status("revocation_membership_changed")],
    });
    expect(result).toMatchObject({
      rootCauseCode: "agent-grant-revocation-activation-refused",
      affectedComponent: "agent-grant-revocation",
      phase: "agent-grant-revocation-activation",
      providerReason: "revocation_membership_changed",
      blocking: true,
    });
    expect(result.remediation).toContain("do not retry a non-transient refusal");
  });

  it("falls back to a fixed code when no bounded refusal was recorded", () => {
    for (const diagnostics of [[], [status("synthetic raw failure postgres://user:secret@db")], [status(null)]])
      expect(
        classifyDeploymentRootCause({ phase: "agent-grant-revocation-activation", diagnostics }).providerReason,
      ).toBe("revocation_release_refused");
  });

  it("never classifies an ordinary deploy failure as an activation refusal", () => {
    for (const phase of ["production-deploy", "staging-deploy"])
      expect(
        classifyDeploymentRootCause({ phase, diagnostics: [status("revocation_membership_changed")] }).rootCauseCode,
      ).not.toBe("agent-grant-revocation-activation-refused");
  });

  it("keeps the code stable through the run-level incident classification", () => {
    expect(
      classifyPlatformDeployRun({
        resolveReleaseResult: "success",
        buildImageResult: "success",
        deployStagingResult: "failure",
        stagingRootCauseCode: "agent-grant-revocation-activation-refused",
      }),
    ).toMatchObject({ action: "create-or-update", reason: "agent-grant-revocation-activation-refused" });
  });
});
