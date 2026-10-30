import type { BcApiModule } from "@chase-sets/bounded-context-module";
import type { ContextSubscriptionRunner, MountedContextRuntimeEntry } from "@chase-sets/bounded-context-runtime";
import type {
  WorkerContextManifest,
  WorkerContextRegistry,
  WorkerHostRuntime,
  WorkerHostRuntimeProfile,
} from "@chase-sets/platform-runtime/worker";
import {
  buildProjectionInterestIndex,
  lookupProjectionInterests,
} from "@chase-sets/platform-runtime/projection-interest-index";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { parse } from "yaml";

type ContractRecord = Readonly<Record<string, unknown>>;
export type OwnerContract = Readonly<{
  contextName: string;
  runners: readonly ContractRecord[];
  subscriptions: readonly ContractRecord[];
  projectionRevisions?: Readonly<Record<string, number>>;
}>;
export type AdmittedContext = Readonly<{
  contextName: string;
  packageName: string;
  dir: string;
  manifest: WorkerContextManifest & Pick<BcApiModule, "projectionGroups">;
}>;

export function readWorkerContractJson<T>(path: string | URL): T {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Admission comes from workspace packages and context manifests, never from the
// generated registry or the presence of an expectation file. Source-only members
// are admitted too, including manifests reserved for another runtime profile.
export function discoverWorkerContexts(
  repoRoot = fileURLToPath(new URL("../../../", import.meta.url)),
): readonly AdmittedContext[] {
  const workspace: { packages: string[] } = parse(readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8"));
  const contexts = readdirSync(join(repoRoot, "bounded-contexts"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      const relativePath = `bounded-contexts/${entry.name}`;
      return (
        workspace.packages.some((pattern) => !pattern.startsWith("!") && matchesGlob(relativePath, pattern)) &&
        !workspace.packages.some((pattern) => pattern.startsWith("!") && matchesGlob(relativePath, pattern.slice(1)))
      );
    })
    .flatMap((entry): AdmittedContext[] => {
      const dir = join(repoRoot, "bounded-contexts", entry.name);
      if (!existsSync(join(dir, "package.json"))) return [];
      const pkg = readWorkerContractJson<{ name: string }>(join(dir, "package.json"));
      const manifest = readWorkerContractJson<AdmittedContext["manifest"] & { packageName: string }>(
        join(dir, "context.json"),
      );
      expect(manifest.contextName, `${entry.name}: manifest context`).toEqual(expect.any(String));
      expect(manifest.contextName.trim(), `${entry.name}: non-empty manifest context`).not.toBe("");
      expect(manifest.packageName, `${entry.name}: admitted package`).toBe(pkg.name);
      return [{ contextName: manifest.contextName, packageName: pkg.name, dir, manifest }];
    });
  return contexts.filter(
    ({ manifest }) =>
      manifest.runtimeDeployables?.includes("platform-worker") ||
      manifest.sourceRuntimeDeployables?.includes("platform-worker") ||
      (manifest.sourceRuntimeProfiles?.length ?? 0) > 0,
  );
}

export function loadOwnerContracts(contexts: readonly AdmittedContext[]): readonly OwnerContract[] {
  return contexts.map(({ contextName, dir }) => {
    const contract = readWorkerContractJson<OwnerContract>(join(dir, "tests/worker-graph.contract.json"));
    expect(contract.contextName, `${contextName}: owner contract`).toBe(contextName);
    return contract;
  });
}

// Preserve every non-function field from the former fingerprints, including
// absent-valued keys and nested handler names. Functions are not executed here.
function describeGraphMember(value: object): ContractRecord {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => typeof field !== "function")
      .map(([key, field]) => [key, describeValue(field)]),
  );
}

function describeValue(value: unknown): unknown {
  if (value === undefined) return "<undefined>";
  if (typeof value === "function") return "<function>";
  if (Array.isArray(value)) return value.map(describeValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, describeValue(field)]));
  }
  return value;
}

function checkpointIdentity(member: ContractRecord): string {
  return `${member.projectionName}:${member.sourceContextName}:v${member.subscriptionVersion}`;
}

function sortedRecords(records: readonly ContractRecord[]) {
  return [...records].sort((left, right) => checkpointIdentity(left).localeCompare(checkpointIdentity(right)));
}

function assertUnique(values: readonly string[], label: string) {
  expect(values, label).toHaveLength(new Set(values).size);
}

function expectedMounts(contexts: readonly AdmittedContext[], profile: WorkerHostRuntimeProfile) {
  return contexts.flatMap<Pick<MountedContextRuntimeEntry, "contextName" | "mountRole">>(
    ({ contextName, manifest }) => {
      if (
        manifest.runtimeDeployables?.includes("platform-worker") &&
        manifest.workerRuntimeProfiles?.includes(profile)
      ) {
        return [{ contextName, mountRole: "active" as const }];
      }
      if (
        manifest.sourceRuntimeDeployables?.includes("platform-worker") &&
        manifest.sourceRuntimeProfiles?.includes(profile)
      ) {
        return [{ contextName, mountRole: "source-only" as const }];
      }
      return [];
    },
  );
}

export function assertWorkerMembership(
  contexts: readonly AdmittedContext[],
  contracts: readonly OwnerContract[],
  registry: WorkerContextRegistry,
) {
  const eligible = contexts.map(({ contextName }) => contextName).sort();
  assertUnique(eligible, "unique admitted contexts");
  expect(
    contracts.map(({ contextName }) => contextName).sort(),
    "every eligible manifest has an owner contract",
  ).toEqual(eligible);
  expect(
    registry.map(({ contextName }) => contextName).sort(),
    "every eligible manifest has an implementation",
  ).toEqual(eligible);
  for (const context of contexts) {
    const entry = registry.find(({ contextName }) => contextName === context.contextName)!;
    expect(entry.packageName, context.contextName).toBe(context.packageName);
    expect(entry.manifest, `${context.contextName}: manifest export`).toEqual(context.manifest);
    expect(entry.module?.contextName, `${context.contextName}: module export`).toBe(context.contextName);
    expect(entry.module?.createServices, `${context.contextName}: service factory`).toBeTypeOf("function");
  }
}

export function assertWorkerAssembly(
  runtime: WorkerHostRuntime,
  contexts: readonly AdmittedContext[],
  contracts: readonly OwnerContract[],
  profile: WorkerHostRuntimeProfile,
) {
  const mounts = expectedMounts(contexts, profile);
  const mountedNames = new Set(mounts.map(({ contextName }) => contextName));
  expect(
    runtime.mountedContexts
      .map(({ contextName, mountRole }) => ({ contextName, mountRole }))
      .sort((a, b) => a.contextName.localeCompare(b.contextName)),
    `${profile}: complete mounted contexts`,
  ).toEqual([...mounts].sort((a, b) => a.contextName.localeCompare(b.contextName)));
  const expectedRunners = contracts.flatMap((contract) => {
    if (!mounts.some((mount) => mount.contextName === contract.contextName && mount.mountRole === "active")) return [];
    const entry = runtime.mountedContexts.find(({ contextName }) => contextName === contract.contextName)!;
    for (const [projectionName, projectionRevision] of Object.entries(contract.projectionRevisions ?? {})) {
      expect(
        runtime.projectionGroups.find(
          (group) => group.targetContextName === contract.contextName && group.projectionName === projectionName,
        )?.projectionRevision,
        `${contract.contextName}: ${projectionName} revision`,
      ).toBe(projectionRevision);
    }
    const subscriptions = entry.module.buildSubscriptions?.(entry.services) ?? [];
    expect(
      sortedRecords(subscriptions.map(describeGraphMember)),
      `${contract.contextName}: declared subscriptions`,
    ).toEqual(sortedRecords(contract.subscriptions));
    // The previous checkpoint-identity inventory has its one literal home in
    // subscriptions; the assembled checkpoint-key inventory lives in runners.
    assertUnique(
      subscriptions.map(checkpointIdentity),
      `${contract.contextName}: unique declared checkpoint identities`,
    );
    const declarations = [
      ...(entry.module.eventSubscriptions ?? []),
      ...(entry.module.eventReactions ?? []).map((reaction) => ({
        ...reaction,
        projectionName: reaction.reactionName,
      })),
    ];
    expect(
      declarations.map(checkpointIdentity).sort(),
      `${contract.contextName}: every declaration represented`,
    ).toEqual(subscriptions.map(checkpointIdentity).sort());
    for (const projector of entry.projectionHandlerSets) {
      const represented = contract.runners.filter((runner) => runner.projectionName === projector.projectionName);
      expect(represented.length, `${contract.contextName}: projector ${projector.projectionName}`).toBeGreaterThan(0);
      const handlerNames = new Set(represented.flatMap((runner) => Object.keys(runner.handlers as object)));
      for (const eventType of Object.keys(projector.handlers)) {
        expect(handlerNames.has(eventType), `${contract.contextName}: projector handler ${eventType}`).toBe(true);
      }
    }
    return contract.runners.filter((runner) => {
      const subscription = contract.subscriptions.find(
        (candidate) => checkpointIdentity(candidate) === checkpointIdentity(runner),
      );
      if (subscription?.sourceContextMount === "when-all-sources-mounted") {
        const context = contexts.find(({ contextName }) => contextName === contract.contextName)!;
        const group = context.manifest.projectionGroups?.find(
          ({ projectionName }) => projectionName === runner.projectionName,
        );
        if (group?.sourceContextNames.some((source) => !mountedNames.has(source))) return false;
      }
      if (
        subscription?.sourceContextMount === "when-mounted" ||
        subscription?.sourceContextMount === "when-all-sources-mounted"
      ) {
        return mountedNames.has(String(runner.sourceContextName));
      }
      return true;
    });
  });
  const runnerKey = (runner: ContractRecord) => `${runner.targetContextName}:${checkpointIdentity(runner)}`;
  const sortRunners = (runners: readonly ContractRecord[]) =>
    [...runners].sort((a, b) => runnerKey(a).localeCompare(runnerKey(b)));
  expect(
    sortRunners(runtime.subscriptionRunners.map(describeGraphMember)),
    `${profile}: owner runner contracts`,
  ).toEqual(sortRunners(expectedRunners));
  assertUnique(runtime.subscriptionRunners.map(runnerKey), "unique target/checkpoint runners (shared names are legal)");
  for (const runner of runtime.subscriptionRunners) {
    expect(mountedNames.has(runner.sourceContextName), `mounted source: ${runnerKey(runner)}`).toBe(true);
    expect(runner.checkpointKey, runnerKey(runner)).toBe(checkpointIdentity(runner));
    expect(runner.subscriptionVersion, runnerKey(runner)).toBeGreaterThan(0);
  }

  const index = buildProjectionInterestIndex({ projectionGroups: runtime.projectionGroups });
  const edge = (
    member: Pick<
      ContextSubscriptionRunner,
      | "targetContextName"
      | "sourceContextName"
      | "projectionName"
      | "checkpointKey"
      | "subscriptionVersion"
      | "subscriptionName"
      | "eventTypes"
      | "streamPrefixes"
    >,
  ) => ({
    targetContextName: member.targetContextName,
    sourceContextName: member.sourceContextName,
    projectionName: member.projectionName,
    checkpointKey: member.checkpointKey,
    subscriptionVersion: member.subscriptionVersion,
    subscriptionName: member.subscriptionName,
    eventTypes: member.eventTypes ? [...member.eventTypes].sort() : undefined,
    streamPrefixes: member.streamPrefixes ? [...member.streamPrefixes].sort() : undefined,
  });
  expect(sortRunners(index.entries.map(edge)), "every runner has exactly one interest edge").toEqual(
    sortRunners(runtime.subscriptionRunners.map(edge)),
  );
  assertUnique(
    index.entries.map(({ entryId }) => entryId),
    "unique interest entries",
  );
  for (const entry of index.entries) {
    for (const eventType of entry.eventTypes ?? []) {
      expect(
        lookupProjectionInterests(index, { sourceContextName: entry.sourceContextName, eventType }),
        `${entry.entryId}: ${eventType}`,
      ).toContainEqual(entry);
    }
  }
}
