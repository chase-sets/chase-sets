import { describe, expect, it } from "vitest";
import {
  READ_CONSISTENCY_ROUTE_MATRIX_DEPLOY_WINDOW_VERSION,
  buildRouteMatrixDeployWindowReport,
  normalizeRouteMatrixDeployWindow,
  parseReadConsistencyRouteMatrixDeployWindowArgs,
} from "./read-consistency-route-matrix-deploy-window.mjs";

describe("read consistency route matrix deploy window", () => {
  it("parses support-safe deploy-window inputs", () => {
    expect(
      parseReadConsistencyRouteMatrixDeployWindowArgs(
        ["--github-runs-file", "runs.json", "--argo-rollouts-file", "rollouts.json", "--out", "window.json"],
        {},
      ),
    ).toMatchObject({
      githubRunsPath: "runs.json",
      argoRolloutsPath: "rollouts.json",
      outPath: "window.json",
    });
  });

  it("treats active GitHub deploys and Argo Rollouts as one active deployment window", () => {
    const report = buildRouteMatrixDeployWindowReport({
      environment: "staging",
      checkedAt: "2026-07-12T20:00:00.000Z",
      githubRunsAvailable: true,
      argoRolloutsAvailable: true,
      githubRuns: {
        workflow_runs: [{ status: "in_progress", started_at: "2026-07-12T19:55:00.000Z" }],
      },
      argoRollouts: {
        items: [{ status: { phase: "Healthy" } }, { status: { phase: "Progressing" } }],
      },
    });

    expect(report).toMatchObject({
      schemaVersion: READ_CONSISTENCY_ROUTE_MATRIX_DEPLOY_WINDOW_VERSION,
      status: "active",
      source: "github-actions+argo-rollouts",
      activeRunCount: 1,
      activeRolloutCount: 1,
      activeSince: "2026-07-12T19:55:00.000Z",
    });
    expect(report.redaction).toMatchObject({ runIds: "not-written", rolloutNames: "not-written" });
  });

  it("reports settled, unknown, and normalized states without trusting raw fields", () => {
    expect(
      buildRouteMatrixDeployWindowReport({ githubRunsAvailable: true, githubRuns: { workflow_runs: [] } }),
    ).toMatchObject({ status: "settled", activeRunCount: 0 });
    expect(buildRouteMatrixDeployWindowReport()).toMatchObject({ status: "unknown", source: "unavailable" });
    expect(
      normalizeRouteMatrixDeployWindow({
        status: "active",
        source: "github-actions+argo-rollouts",
        activeRunCount: "2",
        activeRolloutCount: "1",
        activeSince: "2026-07-12T19:55:00.000Z",
        secret: "must-not-copy",
      }),
    ).toEqual({
      schemaVersion: READ_CONSISTENCY_ROUTE_MATRIX_DEPLOY_WINDOW_VERSION,
      status: "active",
      source: "github-actions+argo-rollouts",
      activeRunCount: 2,
      activeRolloutCount: 1,
      activeSince: "2026-07-12T19:55:00.000Z",
    });
  });
});
