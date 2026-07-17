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
  it("publishes the complete initial stable taxonomy", () => {
    expect(DEPLOY_ROOT_CAUSE_CODES).toEqual([
      "app-platform-bootstrap-config",
      "app-platform-bootstrap-runtime",
      "doks-bootstrap-or-migration",
      "terraform-provider-or-state",
      "staging-dns",
      "staging-advisory-seed-or-e2e",
      "blocking-staging-verification",
      "production-verification",
      "superseded-pre-mutation",
      "unknown",
    ]);
  });

  for (const fixture of rootCauseFixtures) {
    it(`classifies fixture: ${fixture.name}`, () => {
      expect(classifyDeploymentRootCause(fixture.input)).toMatchObject(fixture.expected);
    });
  }

  it("renders the same concise root cause into the artifact, summary, and incident body", () => {
    const fixture = rootCauseFixtures.find(
      ({ expected }) => expected.rootCauseCode === "app-platform-bootstrap-config",
    );
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
      rootCauseCode: "app-platform-bootstrap-config",
      affectedComponent: "platform-bootstrap",
      blocking: true,
    });
    for (const output of [summary, body]) {
      expect(output).toContain("app-platform-bootstrap-config");
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
      rootCauseCode: "app-platform-bootstrap-runtime",
      affectedComponent: "platform-bootstrap",
      providerReason: "DeployContainerExitNonZero: Bootstrap process exited unsuccessfully",
    });
    expect(result.providerReason).not.toContain("state lock");
  });
});
