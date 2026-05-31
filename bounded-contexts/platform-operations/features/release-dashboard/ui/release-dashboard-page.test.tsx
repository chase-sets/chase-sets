import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReleaseDashboardSnapshot } from "../read-model/contracts";
import { ReleaseDashboardPage } from "./release-dashboard-page";

describe("ReleaseDashboardPage", () => {
  it("renders operator-facing release currency and health state", () => {
    render(<ReleaseDashboardPage data={snapshot()} />);

    expect(screen.getByRole("heading", { name: "Release Dashboard" })).toBeTruthy();
    expect(screen.getByText("Production is current with main and the latest production health passed.")).toBeTruthy();
    expect(screen.getAllByText("aaaaaaa1").length).toBeGreaterThan(0);
    expect(screen.getByText("promote")).toBeTruthy();
  });

  it("renders locked release state with failed deployment context", () => {
    render(
      <ReleaseDashboardPage
        data={snapshot({
          posture: "locked",
          explanation: "Production promotion is locked: payment provider incident.",
          releaseLock: {
            locked: true,
            reason: "payment provider incident",
            reference: "INC-1",
            environmentName: "production",
          },
          checks: {
            prRequired: "success",
            platformDeploy: "failure",
            stagingDeploy: "success",
            productionDeploy: "failure",
          },
          latestReleaseHealth: {
            releaseCommit: "aaaaaaa1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            workflowRunId: "26725326298",
            releaseMode: "normal",
            staging: "success",
            canary: "failure",
            canaryDecision: "abort",
            production: "failure",
            checkedAt: "2026-05-31T12:00:00.000Z",
          },
        })}
      />,
    );

    expect(screen.getByText("Production promotion is locked: payment provider incident.")).toBeTruthy();
    expect(screen.getByText("payment provider incident")).toBeTruthy();
    expect(screen.getByText("abort")).toBeTruthy();
  });
});

function snapshot(overrides: Partial<ReleaseDashboardSnapshot> = {}): ReleaseDashboardSnapshot {
  return {
    checkedAt: "2026-05-31T12:01:00.000Z",
    repository: "todd-skelton/chase-sets",
    posture: "current",
    explanation: "Production is current with main and the latest production health passed.",
    main: {
      sha: "aaaaaaa1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      shortSha: "aaaaaaa1",
      recordedAt: "2026-05-31T11:50:00.000Z",
    },
    productionMarker: {
      sha: "aaaaaaa1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      shortSha: "aaaaaaa1",
      recordedAt: "2026-05-31T12:00:00.000Z",
    },
    drift: {
      commits: 0,
      seconds: 0,
      label: "0 commits / 0s",
    },
    checks: {
      prRequired: "success",
      platformDeploy: "success",
      stagingDeploy: "success",
      productionDeploy: "success",
    },
    releaseLock: {
      locked: false,
      reason: "",
      reference: "",
      environmentName: "production",
    },
    latestReleaseHealth: {
      releaseCommit: "aaaaaaa1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      workflowRunId: "26725326298",
      releaseMode: "normal",
      staging: "success",
      canary: "success",
      canaryDecision: "promote",
      production: "success",
      checkedAt: "2026-05-31T12:00:00.000Z",
    },
    links: {
      latestPrRun: "https://github.com/todd-skelton/chase-sets/actions/runs/1",
      latestDeployRun: "https://github.com/todd-skelton/chase-sets/actions/runs/2",
      productionMarker: "https://github.com/todd-skelton/chase-sets/tree/production",
    },
    ...overrides,
  };
}
