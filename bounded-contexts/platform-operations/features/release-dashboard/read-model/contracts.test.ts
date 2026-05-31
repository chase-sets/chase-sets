import { describe, expect, it } from "vitest";
import { buildReleaseDashboardSnapshot, readReleaseDashboardSource } from "./contracts";

const mainSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const productionSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("release dashboard read model", () => {
  it("reports current production when release health is green and drift is zero", () => {
    const snapshot = buildReleaseDashboardSnapshot(
      readReleaseDashboardSource({
        RELEASE_DASHBOARD_MAIN_SHA: mainSha,
        RELEASE_DASHBOARD_PRODUCTION_MARKER_SHA: mainSha,
        RELEASE_DASHBOARD_PR_REQUIRED_RESULT: "success",
        RELEASE_DASHBOARD_PLATFORM_DEPLOY_RESULT: "success",
        RELEASE_DASHBOARD_RELEASE_HEALTH_JSON: JSON.stringify({
          releaseCommit: mainSha,
          workflowRunId: "26725326298",
          releaseMode: "normal",
          checkedAt: "2026-05-31T12:00:00.000Z",
          mainToProductionDrift: { commits: 0, seconds: 0 },
          staging: { result: "success" },
          canary: { result: "success", promotionDecision: "promote" },
          production: { result: "success" },
        }),
      }),
      {
        locked: false,
        reason: "",
        reference: "",
        environmentName: "production",
      },
      "2026-05-31T12:01:00.000Z",
    );

    expect(snapshot.posture).toBe("current");
    expect(snapshot.explanation).toBe("Production is current with main and the latest production health passed.");
    expect(snapshot.latestReleaseHealth.canaryDecision).toBe("promote");
  });

  it("prioritizes active release locks over healthy deploy state", () => {
    const snapshot = buildReleaseDashboardSnapshot(
      readReleaseDashboardSource({
        RELEASE_DASHBOARD_MAIN_SHA: mainSha,
        RELEASE_DASHBOARD_PRODUCTION_MARKER_SHA: mainSha,
        RELEASE_DASHBOARD_RELEASE_HEALTH_JSON: JSON.stringify({
          mainToProductionDrift: { commits: 0 },
          staging: { result: "success" },
          production: { result: "success" },
        }),
      }),
      {
        locked: true,
        reason: "payment provider incident",
        reference: "INC-1",
        environmentName: "production",
      },
      "2026-05-31T12:01:00.000Z",
    );

    expect(snapshot.posture).toBe("locked");
    expect(snapshot.explanation).toContain("payment provider incident");
  });

  it("surfaces failed deploy health before drift", () => {
    const snapshot = buildReleaseDashboardSnapshot(
      readReleaseDashboardSource({
        RELEASE_DASHBOARD_MAIN_SHA: mainSha,
        RELEASE_DASHBOARD_PRODUCTION_MARKER_SHA: productionSha,
        RELEASE_DASHBOARD_RELEASE_HEALTH_JSON: JSON.stringify({
          mainToProductionDrift: { commits: 3, seconds: 900 },
          staging: { result: "success" },
          production: { result: "failure" },
        }),
      }),
      {
        locked: false,
        reason: "",
        reference: "",
        environmentName: "production",
      },
      "2026-05-31T12:01:00.000Z",
    );

    expect(snapshot.posture).toBe("failed");
    expect(snapshot.drift.label).toBe("3 commits / 15m");
  });

  it("explains why production is behind main", () => {
    const snapshot = buildReleaseDashboardSnapshot(
      readReleaseDashboardSource({
        RELEASE_DASHBOARD_MAIN_SHA: mainSha,
        RELEASE_DASHBOARD_PRODUCTION_MARKER_SHA: productionSha,
        RELEASE_DASHBOARD_RELEASE_HEALTH_JSON: JSON.stringify({
          mainToProductionDrift: { commits: 1, seconds: 30 },
          staging: { result: "success" },
          production: { result: "success" },
        }),
      }),
      {
        locked: false,
        reason: "",
        reference: "",
        environmentName: "production",
      },
      "2026-05-31T12:01:00.000Z",
    );

    expect(snapshot.posture).toBe("drift");
    expect(snapshot.explanation).toBe("Production is 1 commit behind main.");
  });
});
