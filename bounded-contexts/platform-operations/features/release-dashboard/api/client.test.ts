import { describe, expect, it } from "vitest";
import { loadReleaseDashboardSnapshot } from "./client";

describe("release dashboard API client", () => {
  it("uses read-only GitHub facts when explicit env values are absent", async () => {
    const snapshot = await loadReleaseDashboardSnapshot({
      env: {
        RELEASE_DASHBOARD_REPOSITORY: "todd-skelton/chase-sets",
        RELEASE_DASHBOARD_RELEASE_HEALTH_JSON: JSON.stringify({
          mainToProductionDrift: { commits: 0 },
          staging: { result: "success" },
          production: { result: "success" },
        }),
      },
      fetch: fakeGitHubFetch({
        mainSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        productionSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        prConclusion: "success",
        deployConclusion: "success",
      }),
    });

    expect(snapshot.main.shortSha).toBe("aaaaaaaa");
    expect(snapshot.productionMarker.shortSha).toBe("aaaaaaaa");
    expect(snapshot.checks.prRequired).toBe("success");
    expect(snapshot.links.latestDeployRun).toBe("https://github.example/runs/deploy");
  });

  it("keeps explicit release dashboard env values ahead of GitHub fallback values", async () => {
    const snapshot = await loadReleaseDashboardSnapshot({
      env: {
        RELEASE_DASHBOARD_DISABLE_GITHUB: "true",
        RELEASE_DASHBOARD_MAIN_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        RELEASE_DASHBOARD_PRODUCTION_MARKER_SHA: "cccccccccccccccccccccccccccccccccccccccc",
        RELEASE_DASHBOARD_PRODUCTION_RESULT: "failure",
      },
      fetch: fakeGitHubFetch({
        mainSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        productionSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        prConclusion: "success",
        deployConclusion: "success",
      }),
    });

    expect(snapshot.main.shortSha).toBe("bbbbbbbb");
    expect(snapshot.productionMarker.shortSha).toBe("cccccccc");
    expect(snapshot.checks.productionDeploy).toBe("failure");
    expect(snapshot.posture).toBe("failed");
  });
});

function fakeGitHubFetch(
  input: Readonly<{
    mainSha: string;
    productionSha: string;
    prConclusion: string;
    deployConclusion: string;
  }>,
): typeof globalThis.fetch {
  return async (resource) => {
    const url = String(resource);
    if (url.includes("git/ref/heads/main")) {
      return jsonResponse({ object: { sha: input.mainSha } });
    }
    if (url.includes("git/ref/heads/production")) {
      return jsonResponse({ object: { sha: input.productionSha } });
    }
    if (url.includes("platform-pr.yml")) {
      return jsonResponse({
        workflow_runs: [{ conclusion: input.prConclusion, html_url: "https://github.example/runs/pr" }],
      });
    }
    if (url.includes("platform-production.yml")) {
      return jsonResponse({
        workflow_runs: [{ conclusion: input.deployConclusion, html_url: "https://github.example/runs/deploy" }],
      });
    }
    return new Response(null, { status: 404 });
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}
