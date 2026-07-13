import { describe, expect, it } from "vitest";
import {
  buildSupersededNoOpResolutionComment,
  classifyPlatformDeployRun,
  classifySupersededNoOpIncident,
  parsePlatformDeployIncidentOptions,
} from "./platform-deploy-incident.mjs";

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
    ).toMatchObject({ action: "close", reason: "staging-superseded-before-apply", noOp: true });
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

  it("preserves a bounded bootstrap failure classification for staging incidents", () => {
    expect(
      classifyPlatformDeployRun({
        resolveReleaseResult: "success",
        buildImageResult: "success",
        deployStagingResult: "failure",
        deployProductionResult: "skipped",
        recordStagingHealthResult: "success",
        stagingFailureClassification: "staging-bootstrap-schema-lock-timeout",
      }),
    ).toMatchObject({
      action: "create-or-update",
      reason: "staging-bootstrap-schema-lock-timeout",
      stagingFailureClassification: "staging-bootstrap-schema-lock-timeout",
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
      stagingFailureClassification: "staging-bootstrap-timeout",
    });
  });
});
