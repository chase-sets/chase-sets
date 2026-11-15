import {
  normalizeScheduledJobs,
  type BcApiModule,
  type ScheduledJobManifestDeclaration,
  type ScheduledJobDeclaration,
  type WorkerRunner,
} from "@chase-sets/bounded-context-module";
import type { NotificationChannelAdapter } from "@chase-sets/outbound-messaging";
import type { WorkerHostRuntime } from "./worker";
import type { PlatformControlPlane } from "./control-plane";
import type { ProjectionRunContext, ProjectorRunResult } from "@chase-sets/event-core/projector";

export type DurableJobLaneRunContext = Readonly<{
  workflowName: string;
  laneName: string;
  laneIndex: number;
  laneCount: number;
  runnerContext?: ProjectionRunContext;
}>;

export function createDurableJobLaneRunners(input: {
  workflowName: string;
  laneCount: number;
  runLane: (context: DurableJobLaneRunContext) => Promise<ProjectorRunResult>;
  priority?: () => bigint | number;
}): readonly WorkerRunner[] {
  const laneCount = Math.max(1, Math.floor(input.laneCount));
  return Array.from({ length: laneCount }, (_, index): WorkerRunner => {
    const laneIndex = index + 1;
    const laneName = `job:${input.workflowName}.lane-${laneIndex}`;
    return {
      name: laneName,
      kind: "job",
      priority: input.priority,
      runOnce: (runnerContext) =>
        input.runLane({
          workflowName: input.workflowName,
          laneName,
          laneIndex,
          laneCount,
          runnerContext,
        }),
    };
  });
}

export type WorkerJobLogger = Readonly<{
  info: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  warn: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  error: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
}>;

export type WorkerJobInput<TConfig> = Readonly<{
  services: Readonly<Record<string, unknown>>;
  config: TConfig;
  controlPlane: PlatformControlPlane;
  logger: WorkerJobLogger;
  runtime: WorkerHostRuntime;
  notification?: Readonly<{
    emailAdapter: NotificationChannelAdapter;
    mobileMessageAdapters: () => readonly NotificationChannelAdapter[];
    outboxContextNames: ReadonlySet<string>;
  }>;
}>;

export type WorkerJobRegistry<TInput> = readonly Readonly<{
  contextName: string;
  manifest: Readonly<{ contextName?: string; scheduledJobs?: readonly ScheduledJobManifestDeclaration[] }>;
  module: BcApiModule &
    Readonly<{ workerJobFactories?: Readonly<Record<string, (input: TInput) => readonly WorkerRunner[]>> }>;
}>[];

function matchRunnerIdentity(job: ScheduledJobDeclaration, name: string) {
  if (job.schedule.kind === "durable") {
    const prefix = `job:${job.id}.lane-`;
    const lane = name.startsWith(prefix) ? name.slice(prefix.length) : "";
    return /^[1-9]\d*$/.test(lane) ? { lane } : null;
  }
  if (job.id.includes("{contextName}")) {
    const [prefix, suffix] = job.id.split("{contextName}");
    if (prefix === undefined || suffix === undefined || !name.startsWith(prefix) || !name.endsWith(suffix)) return null;
    const contextName = name.slice(prefix.length, name.length - suffix.length);
    return contextName ? { contextName } : null;
  }
  return job.id === name ? {} : null;
}

export function composeWorkerJobs<TInput>(
  registry: WorkerJobRegistry<TInput>,
  input: TInput,
  runtimeProfile: "landing" | "proof" | "public",
  retained: readonly Readonly<{
    order: number;
    group: ScheduledJobDeclaration["group"];
    create: () => readonly WorkerRunner[];
  }>[] = [],
): Readonly<Record<ScheduledJobDeclaration["group"], readonly WorkerRunner[]>> {
  const groups: Record<ScheduledJobDeclaration["group"], WorkerRunner[]> = {
    jobs: [],
    "inventory-jobs": [],
    dispatch: [],
    scheduled: [],
  };
  const contributions = [...retained];
  const declarations = new Set<string>();
  for (const entry of registry) {
    const factories = new Map<string, ScheduledJobDeclaration[]>();
    for (const job of normalizeScheduledJobs(entry.contextName, entry.manifest.scheduledJobs ?? [])) {
      if (declarations.has(job.id)) throw new Error(`${entry.contextName}/${job.id}: duplicate job declaration`);
      declarations.add(job.id);
      const factory = entry.module.workerJobFactories?.[job.runnerExport];
      if (!factory) throw new Error(`${entry.contextName}/${job.id}: missing factory ${job.runnerExport}`);
      if (!job.runtimeProfiles.includes(runtimeProfile)) continue;
      const jobs = factories.get(job.runnerExport) ?? [];
      jobs.push(job);
      factories.set(job.runnerExport, jobs);
    }
    for (const [name, jobs] of factories) {
      const first = jobs[0]!;
      if (jobs.some((job) => job.group !== first.group || job.order !== first.order)) {
        throw new Error(
          `${entry.contextName}/${first.id}: factory declarations must share construction order and group`,
        );
      }
      contributions.push({
        order: first.order,
        group: first.group,
        create: () => {
          const runners = entry.module.workerJobFactories![name]!(input);
          for (const runner of runners) {
            const job = jobs.find((job) => matchRunnerIdentity(job, runner.name));
            if (!job) {
              throw new Error(`${entry.contextName}/${runner.name}: undeclared runner from ${name}`);
            }
            const identity = matchRunnerIdentity(job, runner.name)!;
            const lockScope = job.lockScope
              .replace("{lane}", identity.lane ?? "")
              .replace("{contextName}", identity.contextName ?? "");
            if ((runner.leaseName ?? `${runner.kind}:${runner.name}`) !== lockScope) {
              throw new Error(`${entry.contextName}/${job.id}: runner lease differs from declared lock scope`);
            }
          }
          return runners;
        },
      });
    }
  }
  const identities = new Set<string>();
  for (const contribution of contributions.sort((left, right) => left.order - right.order)) {
    for (const runner of contribution.create()) {
      const identity = runner.leaseName ?? `${runner.kind}:${runner.name}`;
      if (identities.has(identity)) throw new Error(`${runner.name}: duplicate runner lease ${identity}`);
      identities.add(identity);
      groups[contribution.group].push(runner);
    }
  }
  return groups;
}

export function createScheduledJobRunner(
  name: string,
  intervalMs: number,
  controlPlane: PlatformControlPlane,
  job: () => Promise<number>,
): WorkerRunner {
  return {
    name,
    kind: "job",
    runOnce: async () => {
      const claimed = await controlPlane.claimScheduledRunner({ runnerName: name, intervalMs });
      if (!claimed) return { processed: 0, lastGlobalPosition: "0" as never };
      const processed = await job();
      await controlPlane.recordScheduledRunnerCompleted({ runnerName: name });
      return { processed, lastGlobalPosition: "0" as never };
    },
  };
}
