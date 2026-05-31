import {
  buildReleaseDashboardSnapshot,
  readReleaseDashboardSource,
  type ReleaseDashboardPhase,
  type ReleaseDashboardSource,
  type ReleaseDashboardSnapshot,
} from "../read-model/contracts";
import { readReleaseLockStatus } from "../../release-controls/domain/release-lock";
import { readGitHubReleaseDashboardFacts } from "./github-source";

export type { ReleaseDashboardSnapshot };

export type ReleaseDashboardLoadOptions = Readonly<{
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
}>;

export async function loadReleaseDashboardSnapshot({
  env = process.env,
  fetch = globalThis.fetch,
}: ReleaseDashboardLoadOptions = {}): Promise<ReleaseDashboardSnapshot> {
  const source = readReleaseDashboardSource(env);
  const githubFacts = await readGitHubReleaseDashboardFacts({
    repository: source.repository,
    fetch,
    token: env.RELEASE_DASHBOARD_GITHUB_TOKEN ?? env.GITHUB_TOKEN ?? null,
    disabled: env.RELEASE_DASHBOARD_DISABLE_GITHUB === "true",
  });

  return buildReleaseDashboardSnapshot(mergeSources(source, githubFacts), readReleaseLockStatus(env, "production"));
}

function mergeSources(
  source: ReleaseDashboardSource,
  githubFacts: Partial<ReleaseDashboardSource>,
): ReleaseDashboardSource {
  return {
    ...source,
    mainSha: source.mainSha ?? githubFacts.mainSha ?? null,
    productionMarkerSha: source.productionMarkerSha ?? githubFacts.productionMarkerSha ?? null,
    latestPrRequired: preferKnownPhase(source.latestPrRequired, githubFacts.latestPrRequired),
    latestPlatformDeploy: preferKnownPhase(source.latestPlatformDeploy, githubFacts.latestPlatformDeploy),
    latestStagingDeploy: preferKnownPhase(source.latestStagingDeploy, githubFacts.latestStagingDeploy),
    latestProductionDeploy: preferKnownPhase(source.latestProductionDeploy, githubFacts.latestProductionDeploy),
    latestPrRunUrl: source.latestPrRunUrl ?? githubFacts.latestPrRunUrl ?? null,
    latestDeployRunUrl: source.latestDeployRunUrl ?? githubFacts.latestDeployRunUrl ?? null,
    productionMarkerUrl: source.productionMarkerUrl ?? githubFacts.productionMarkerUrl ?? null,
  };
}

function preferKnownPhase(current: ReleaseDashboardPhase, fallback: ReleaseDashboardPhase | undefined) {
  return current === "unknown" && fallback ? fallback : current;
}
