import type { ReleaseDashboardPhase } from "../read-model/contracts";

export type GitHubReleaseDashboardFacts = Readonly<{
  mainSha: string | null;
  productionMarkerSha: string | null;
  latestPrRequired: ReleaseDashboardPhase;
  latestPlatformDeploy: ReleaseDashboardPhase;
  latestStagingDeploy: ReleaseDashboardPhase;
  latestProductionDeploy: ReleaseDashboardPhase;
  latestPrRunUrl: string | null;
  latestDeployRunUrl: string | null;
  productionMarkerUrl: string | null;
}>;

export type GitHubReleaseDashboardSourceOptions = Readonly<{
  repository: string;
  fetch?: typeof globalThis.fetch;
  token?: string | null;
  disabled?: boolean;
}>;

export async function readGitHubReleaseDashboardFacts({
  repository,
  fetch = globalThis.fetch,
  token = null,
  disabled = false,
}: GitHubReleaseDashboardSourceOptions): Promise<GitHubReleaseDashboardFacts> {
  const fallback = emptyFacts(repository);
  if (disabled) {
    return fallback;
  }

  const [mainRef, productionRef, prRun, deployRun] = await Promise.all([
    requestJson(fetch, repository, "git/ref/heads/main", token),
    requestJson(fetch, repository, "git/ref/heads/production", token),
    requestJson(fetch, repository, "actions/workflows/platform-pr.yml/runs?per_page=1", token),
    requestJson(fetch, repository, "actions/workflows/platform-production.yml/runs?per_page=1", token),
  ]);
  const latestPrRun = readLatestWorkflowRun(prRun);
  const latestDeployRun = readLatestWorkflowRun(deployRun);
  const latestDeployPhase = workflowRunPhase(latestDeployRun);

  return {
    mainSha: readRefSha(mainRef),
    productionMarkerSha: readRefSha(productionRef),
    latestPrRequired: workflowRunPhase(latestPrRun),
    latestPlatformDeploy: latestDeployPhase,
    latestStagingDeploy: latestDeployPhase,
    latestProductionDeploy: latestDeployPhase,
    latestPrRunUrl: readString(latestPrRun, "html_url"),
    latestDeployRunUrl: readString(latestDeployRun, "html_url"),
    productionMarkerUrl: fallback.productionMarkerUrl,
  };
}

function emptyFacts(repository: string): GitHubReleaseDashboardFacts {
  return {
    mainSha: null,
    productionMarkerSha: null,
    latestPrRequired: "unknown",
    latestPlatformDeploy: "unknown",
    latestStagingDeploy: "unknown",
    latestProductionDeploy: "unknown",
    latestPrRunUrl: null,
    latestDeployRunUrl: null,
    productionMarkerUrl: `https://github.com/${repository}/tree/production`,
  };
}

async function requestJson(
  fetch: typeof globalThis.fetch,
  repository: string,
  path: string,
  token: string | null,
): Promise<unknown> {
  try {
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "User-Agent": "chase-sets-release-dashboard",
      "X-GitHub-Api-Version": "2022-11-28",
    });
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, { headers });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

function readRefSha(value: unknown) {
  const object = readRecord(value, "object");
  return readString(object, "sha");
}

function readLatestWorkflowRun(value: unknown) {
  const runs = readArray(value, "workflow_runs");
  return runs.length > 0 ? runs[0] : null;
}

function workflowRunPhase(value: unknown): ReleaseDashboardPhase {
  const conclusion = readString(value, "conclusion");
  if (conclusion === "success" || conclusion === "failure" || conclusion === "cancelled" || conclusion === "skipped") {
    return conclusion;
  }
  return "unknown";
}

function readRecord(value: unknown, key: string) {
  if (!value || typeof value !== "object" || !(key in value)) {
    return null;
  }
  const child = (value as Record<string, unknown>)[key];
  return child && typeof child === "object" ? child : null;
}

function readArray(value: unknown, key: string): readonly unknown[] {
  if (!value || typeof value !== "object" || !(key in value)) {
    return [];
  }
  const child = (value as Record<string, unknown>)[key];
  return Array.isArray(child) ? child : [];
}

function readString(value: unknown, key: string) {
  if (!value || typeof value !== "object" || !(key in value)) {
    return null;
  }
  const child = (value as Record<string, unknown>)[key];
  return typeof child === "string" && child.trim() ? child.trim() : null;
}
