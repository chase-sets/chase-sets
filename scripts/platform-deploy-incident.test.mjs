import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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
      "doks-bootstrap-or-migration",
      "terraform-provider-or-state",
      "staging-dns",
      "staging-advisory-seed-or-e2e",
      "blocking-staging-verification",
      "production-verification",
      "superseded-pre-mutation",
      "cluster-node-readiness-taint",
      "registry-image-pull-authorization",
      "unknown",
    ]);
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

  it("deduplicates byte-equivalent node-readiness records across volatile run and workload identities", () => {
    const first = classifyDeploymentRootCause({
      phase: "staging-deploy",
      diagnostics: [
        {
          capturedAt: "2026-07-26T13:27:13.967Z",
          release: "chase-sets-staging-a",
          namespace: "chase-sets-staging-a",
          runId: 30202917958,
          runUrl: "https://github.com/chase-sets/chase-sets/actions/runs/30202917958",
          workloads: [
            {
              pod: "marketplace-api-6ff7f59b68-bn8vx",
              node: "pool-platform-7a9d",
              event:
                "Warning FailedScheduling 50m (x8 over 39m) default-scheduler 0/5 nodes are available: 1 node(s) were unschedulable, 4 node(s) had untolerated taint(s).",
              taint: "readiness.k8s.io/DOKSCriticalComponentsReady=pending:NoSchedule",
            },
          ],
        },
      ],
    });
    const second = classifyDeploymentRootCause({
      phase: "staging-deploy",
      diagnostics: [
        {
          runUrl: "https://github.com/chase-sets/chase-sets/actions/runs/30525227116/attempts/2",
          runId: 30525227116,
          namespace: "chase-sets-staging-b",
          release: "chase-sets-staging-b",
          capturedAt: "2026-07-31T22:48:59.001Z",
          workloads: [
            {
              taint: "readiness.k8s.io/DOKSCriticalComponentsReady=pending:NoSchedule",
              event:
                "Warning FailedScheduling 4m19s (x2 over 3m) default-scheduler 0/2 nodes are available: 2 node(s) had untolerated taint(s).",
              node: "pool-platform-f48c",
              pod: "marketplace-api-7cc8d6f579-q2k7m",
            },
          ],
        },
      ],
    });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    const registryRenditions = [
      {
        namespace: "chase-sets-staging-a",
        pod: "marketplace-worker-0",
        message:
          "ErrImagePull: Failed to pull image registry.digitalocean.com/example/worker@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: failed to authorize: 401 Unauthorized",
      },
      {
        message:
          "ErrImagePull: Failed to pull image registry.digitalocean.com/example/worker@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb: failed to authorize: 401 Unauthorized",
        pod: "marketplace-worker-7",
        namespace: "chase-sets-staging-b",
      },
    ].map((diagnostic) => classifyDeploymentRootCause({ phase: "staging-deploy", diagnostics: [diagnostic] }));

    expect(JSON.stringify(registryRenditions[1])).toBe(JSON.stringify(registryRenditions[0]));
  });

  it("keeps five distinct actionable causes in five recurrence identities", () => {
    const classifyUnknown = (message) =>
      classifyDeploymentRootCause({
        phase: "staging-deploy",
        steps: [{ name: "provider", phase: "ERROR", reasonCode: "ProviderFailure", message }],
      });
    const records = [
      classifyDeploymentRootCause({
        diagnostics: ["readiness.k8s.io/DOKSCriticalComponentsReady=pending:NoSchedule"],
      }),
      classifyDeploymentRootCause({
        diagnostics: ["ErrImagePull: failed to authorize image pull: 401 Unauthorized"],
      }),
      classifyDeploymentRootCause({ diagnostics: ["Error acquiring the state lock"] }),
      classifyUnknown("Provider rejected operation with code E1042"),
      classifyUnknown("Provider rejected operation with code E1043"),
    ];

    expect(records.map(({ rootCauseCode }) => rootCauseCode)).toEqual([
      "cluster-node-readiness-taint",
      "registry-image-pull-authorization",
      "terraform-provider-or-state",
      "unknown",
      "unknown",
    ]);
    expect(new Set(records.map(({ rootCauseSignature }) => rootCauseSignature)).size).toBe(5);

    expect(
      classifyDeploymentRootCause({
        diagnostics: ["ImagePullBackOff: Failed to pull image registry.example/api: dial tcp: i/o timeout"],
      }).rootCauseCode,
    ).toBe("unknown");
    expect(
      classifyDeploymentRootCause({
        diagnostics: [
          "ImagePullBackOff: Failed to pull image registry.example/api: dial tcp: i/o timeout",
          "Unrelated API authorization denied",
        ],
      }).rootCauseCode,
    ).toBe("unknown");
  });

  it("selects a deterministic bounded cause from unknown diagnostic fallbacks without masking codes", () => {
    const classifyUnknownDiagnostics = (diagnostics) =>
      classifyDeploymentRootCause({ phase: "staging-deploy", diagnostics });
    const first = classifyUnknownDiagnostics([
      { capturedAt: "2026-07-26T13:27:13.967Z" },
      { provider: "example", detail: "Provider rejected operation with code E1042" },
    ]);
    const reordered = classifyUnknownDiagnostics([
      { detail: "Provider rejected operation with code E1042", provider: "other-rendition" },
      { capturedAt: "2026-07-31T22:48:59.001Z" },
    ]);
    const distinct = classifyUnknownDiagnostics([{ detail: "Provider rejected operation with code E1043" }]);

    expect(first).toMatchObject({
      rootCauseCode: "unknown",
      providerReason: "Provider rejected operation with code E1042",
    });
    expect(reordered.rootCauseSignature).toBe(first.rootCauseSignature);
    expect(distinct.rootCauseSignature).not.toBe(first.rootCauseSignature);
  });

  it("lets node-readiness evidence outrank bootstrap timeout text without shadowing bootstrap alone", () => {
    const bootstrap = "Schema bootstrap command timed out before migration completed";
    expect(
      classifyDeploymentRootCause({
        diagnostics: [bootstrap, "readiness.k8s.io/DOKSCriticalComponentsReady=pending:NoSchedule"],
      }).rootCauseCode,
    ).toBe("cluster-node-readiness-taint");
    expect(classifyDeploymentRootCause({ diagnostics: [bootstrap] }).rootCauseCode).toBe("doks-bootstrap-or-migration");
    expect(
      classifyDeploymentRootCause({
        diagnostics: [
          "Warning FailedScheduling: 0/2 nodes are available: 2 node(s) had untolerated taint(s)",
          "workload.example/reserved=true:NoSchedule",
        ],
      }).rootCauseCode,
    ).toBe("unknown");
  });

  it("is invariant to diagnostic ordering and absent optional sources", () => {
    const cause = "readiness.k8s.io/DOKSCriticalComponentsReady=pending:NoSchedule";
    const event =
      "Warning FailedScheduling 4m25s (x8 over 39m) default-scheduler 0/2 nodes are available: 2 node(s) had untolerated taint(s).";
    const variants = [
      { diagnostics: [{ capturedAt: "2026-07-26T13:27:13.967Z" }, cause, event], logs: [] },
      { diagnostics: [event, cause, { capturedAt: "2026-07-31T22:48:59.001Z" }] },
      { diagnostics: [cause], logs: [{ output: event }] },
    ].map((input) => classifyDeploymentRootCause({ phase: "staging-deploy", ...input }));

    expect(new Set(variants.map(({ rootCauseSignature }) => rootCauseSignature)).size).toBe(1);
    expect(new Set(variants.map(({ providerReason }) => providerReason))).toEqual(
      new Set(["Pods are unschedulable behind the DOKS critical-readiness taint."]),
    );
  });

  it("selects one bounded cause line instead of retaining the diagnostics provider body", () => {
    const rootCause = classifyDeploymentRootCause({
      phase: "staging-deploy",
      diagnostics: [
        {
          artifact: "platform-kubernetes-diagnostics",
          capturedAt: "2026-07-26T13:27:13.967Z",
          commands: [
            {
              output:
                "Warning FailedScheduling 4m25s default-scheduler 0/2 nodes are available: 2 node(s) had untolerated taint(s).",
            },
          ],
          taint: "readiness.k8s.io/DOKSCriticalComponentsReady=pending:NoSchedule",
        },
      ],
    });
    const summary = renderDeployRootCauseSummary(rootCause);
    const body = buildDeployIncidentBody({ ...rootCause, rootCausePhase: rootCause.phase });

    expect(rootCause.providerReason).toBe("Pods are unschedulable behind the DOKS critical-readiness taint.");
    expect(rootCause.providerReason.length).toBeLessThanOrEqual(500);
    for (const output of [summary, body]) expect(output).not.toContain("platform-kubernetes-diagnostics");
  });

  it("excludes adversarial secrets from classification, renders, and the CLI output artifact", () => {
    const directory = mkdtempSync(join(tmpdir(), "platform-deploy-secret-control-"));
    const diagnosticsPath = join(directory, "diagnostics.json");
    const outputPath = join(directory, "root-cause.json");
    const secretMarker = "issue-6156-secret-marker";
    const cleanInput = {
      phase: "staging-deploy",
      diagnostics: ["readiness.k8s.io/DOKSCriticalComponentsReady=pending:NoSchedule"],
    };
    const adversarialInput = {
      ...cleanInput,
      diagnostics: [...cleanInput.diagnostics, `token=${secretMarker}`],
    };

    try {
      const clean = classifyDeploymentRootCause(cleanInput);
      const adversarial = classifyDeploymentRootCause(adversarialInput);
      const summary = renderDeployRootCauseSummary(adversarial);
      const body = buildDeployIncidentBody({ ...adversarial, rootCausePhase: adversarial.phase });
      writeFileSync(
        diagnosticsPath,
        JSON.stringify({
          taint: cleanInput.diagnostics[0],
          credentials: `token=${secretMarker}`,
        }),
      );
      const cli = spawnSync(
        process.execPath,
        [
          resolve("scripts/platform-deploy-incident.mjs"),
          "--command",
          "classify-root-cause",
          "--phase",
          "staging-deploy",
          "--diagnostics",
          diagnosticsPath,
          "--out",
          outputPath,
        ],
        { encoding: "utf8" },
      );

      expect(cli.status, cli.stderr).toBe(0);
      expect(adversarial.rootCauseCode).toBe("cluster-node-readiness-taint");
      expect(adversarial.rootCauseSignature).toBe(clean.rootCauseSignature);
      for (const output of [JSON.stringify(adversarial), summary, body, readFileSync(outputPath, "utf8")]) {
        expect(output).not.toContain(secretMarker);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reproduces the canonical signature through the workflow's two-stage derivation for every code", () => {
    for (const fixture of rootCauseFixtures) {
      const firstStage = classifyDeploymentRootCause(fixture.input);
      expect(firstStage).toMatchObject(fixture.expected);
      const shared = {
        rootCauseSummary: firstStage.rootCauseSummary,
        affectedComponent: firstStage.affectedComponent,
        rootCausePhase: firstStage.phase,
        remediation: firstStage.remediation,
        providerReason: firstStage.providerReason,
      };
      const secondStage =
        firstStage.rootCauseCode === "superseded-pre-mutation"
          ? classifyPlatformDeployRun({
              resolveReleaseResult: "success",
              buildImageResult: "success",
              deployStagingResult: "success",
              deployProductionResult: "skipped",
              recordStagingHealthResult: "success",
              stagingApplied: "false",
              ...shared,
            })
          : firstStage.rootCauseCode === "production-verification"
            ? classifyPlatformDeployRun({
                deployStagingResult: "success",
                deployProductionResult: "failure",
                productionRootCauseCode: firstStage.rootCauseCode,
                ...shared,
              })
            : classifyPlatformDeployRun({
                deployStagingResult: "failure",
                deployProductionResult: "skipped",
                stagingRootCauseCode: firstStage.rootCauseCode,
                ...shared,
              });

      expect(secondStage.rootCauseSignature, firstStage.rootCauseCode).toBe(firstStage.rootCauseSignature);
      const body = buildDeployIncidentBody({
        ...secondStage,
        ...(firstStage.rootCauseCode === "unknown"
          ? {}
          : { affectedComponent: "forged-component", rootCausePhase: "forged-phase" }),
        rootCauseSignature: "forged-fallback-signature",
      });
      expect(body).toContain(`\`${firstStage.rootCauseSignature}\``);
      expect(body).toContain(`- Affected component: ${firstStage.affectedComponent}`);
      expect(body).toContain(`- Phase: ${firstStage.phase}`);
      expect(body).not.toContain("forged-fallback-signature");
      if (firstStage.rootCauseCode !== "unknown") expect(body).not.toContain("forged-");
    }
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
