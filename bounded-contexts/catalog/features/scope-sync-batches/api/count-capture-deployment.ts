import { z } from "zod";
import { type CountCaptureAuthority, validateCountCaptureAuthority } from "../domain/count-lifecycle-receipt";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const instant = z.iso.datetime({ offset: true });
const runSchema = z.object({
  id,
  workflow_id: id,
  run_attempt: z.number().int().min(1).max(1000),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/),
  status: z.string(),
  created_at: instant,
  updated_at: instant,
});
const stepSchema = z.object({
  name: z.string(),
  number: z.number().int().positive(),
  status: z.string(),
  conclusion: z.string().nullable(),
  started_at: instant.nullable(),
  completed_at: instant.nullable(),
});
const jobSchema = z.object({
  id,
  run_id: id,
  run_attempt: z.number().int().positive(),
  head_sha: z.string(),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  started_at: instant.nullable(),
  completed_at: instant.nullable(),
  steps: z.array(stepSchema),
});

export type CountCaptureDeploymentReader = Readonly<{
  json(path: string): Promise<unknown>;
  jobLog(jobId: string): Promise<string>;
}>;

export function readCountCaptureDeploymentLog(log: string) {
  if (new TextEncoder().encode(log).length > 16_000_000) throw new Error("log-bound");
  const lines = log.split(/\r?\n/).map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, ""));
  const markers = lines.flatMap((line, index) =>
    line.includes('"schemaVersion": "platform-kubernetes-deployment/v1"') ? [index] : [],
  );
  if (markers.length !== 1) throw new Error("deploy-log-marker-missing-or-duplicate");
  const open = markers[0]! - 1;
  if (open < 0 || lines[open]?.trim() !== "{") throw new Error("deploy-log-invalid");
  for (let close = open + 1; close < Math.min(lines.length, open + 101); close++) {
    if (lines[close]?.trim() !== "}") continue;
    let value: unknown;
    try {
      value = JSON.parse(lines.slice(open, close + 1).join("\n"));
    } catch {
      continue;
    }
    return z
      .object({
        schemaVersion: z.literal("platform-kubernetes-deployment/v1"),
        action: z.literal("deploy"),
        namespace: z.literal("chase-sets-platform"),
        result: z.literal("success"),
        image: z.string(),
      })
      .parse(value);
  }
  throw new Error("deploy-log-invalid");
}

export function readCountCaptureExecutedDeployment(rawJob: unknown, log: string, stepNumber: number) {
  const job = jobSchema.parse(rawJob);
  const steps = job.steps.filter((step) => step.number === stepNumber);
  const step = steps[0];
  if (
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    !job.started_at ||
    !job.completed_at ||
    steps.length !== 1 ||
    !step ||
    step.status !== "completed" ||
    step.conclusion !== "success" ||
    !step.started_at ||
    !step.completed_at ||
    Date.parse(step.started_at) >= Date.parse(step.completed_at) ||
    Date.parse(job.started_at) > Date.parse(step.started_at) ||
    Date.parse(job.completed_at) < Date.parse(step.completed_at)
  )
    throw new Error("selected-job-unexecuted");
  const deployment = readCountCaptureDeploymentLog(log);
  const image = /:([a-f0-9]{40})@(sha256:[a-f0-9]{64})$/.exec(deployment.image);
  if (!image || image[1] !== job.head_sha) throw new Error("deploy-image-mismatch");
  return {
    runId: String(job.run_id),
    attempt: job.run_attempt,
    jobId: String(job.id),
    jobName: job.name,
    stepNumber: step.number,
    stepName: step.name,
    conclusion: "success" as const,
    startedAt: new Date(step.started_at).toISOString(),
    completedAt: new Date(step.completed_at).toISOString(),
    sha: job.head_sha,
    digest: image[2]!,
    logSha: image[1]!,
    logDigest: image[2]!,
  };
}

// The runner supplies transport only. It cannot supply a green collection summary.
export async function collectCountCaptureDeployment(
  reader: CountCaptureDeploymentReader,
  authority: CountCaptureAuthority,
  now: string,
): Promise<CountCaptureAuthority["collection"]> {
  let pageCount = 0;
  let workflowCount = 0;
  let runCount = 0;
  let attemptCount = 0;
  let jobCount = 0;
  let overlap = false;
  const result = (complete: boolean) => ({
    collectedAt: now,
    complete,
    overlap,
    workflowCount,
    runCount,
    attemptCount,
    jobCount,
    pageCount,
  });
  try {
    instant.parse(now);
    async function pages<T extends { id: number }>(path: string, key: string, schema: z.ZodType<T>) {
      const values: T[] = [];
      const seen = new Set<number>();
      let total: number | null = null;
      for (let page = 1; page <= 2000; page++) {
        if (++pageCount > 10000) throw new Error("inventory-bound");
        const raw = z
          .object({ total_count: z.number().int().min(0).max(200_000) })
          .loose()
          .parse(await reader.json(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`));
        if (total !== null && total !== raw.total_count) throw new Error("inventory-changed");
        total = raw.total_count;
        const entries = z.array(schema).max(100).parse(raw[key]);
        for (const entry of entries) {
          if (seen.has(entry.id)) throw new Error("duplicate-identity");
          seen.add(entry.id);
          values.push(entry);
        }
        if (values.length > total) throw new Error("inventory-overflow");
        if (values.length === total) return values;
        if (entries.length < 100) throw new Error("inventory-truncated");
      }
      throw new Error("inventory-bound");
    }
    const workflows = await pages("/actions/workflows", "workflows", z.object({ id, path: z.string() }));
    workflowCount = workflows.length;
    // No head/status/workflow filter: those hide another workflow's or an
    // earlier-started run's later deployment. Independent totals close paging.
    const runs = await pages("/actions/runs", "workflow_runs", runSchema);
    runCount = runs.length;
    const start = Date.parse(authority.deployment.startedAt);
    const selectedEnd = Date.parse(authority.deployment.completedAt);
    let selected = 0;
    for (const run of runs) {
      if (Date.parse(run.updated_at) < Date.parse(run.created_at)) throw new Error("run-time-invalid");
      // A terminal run last updated before the selected deployment cannot
      // have executed an overlapping step. Nonterminal runs never take this path.
      if (
        run.status === "completed" &&
        Date.parse(run.updated_at) < start &&
        String(run.id) !== authority.deployment.runId
      )
        continue;
      if (!workflows.some((workflow) => workflow.id === run.workflow_id)) throw new Error("workflow-unknown");
      for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
        attemptCount++;
        const jobs = await pages(`/actions/runs/${run.id}/attempts/${attempt}/jobs`, "jobs", jobSchema);
        jobCount += jobs.length;
        for (const job of jobs) {
          if (job.run_id !== run.id || job.run_attempt !== attempt || job.head_sha !== run.head_sha)
            throw new Error("job-binding");
          const stagingSteps = job.steps.filter((step) => /deploy.*staging|staging.*deploy/i.test(step.name));
          const stagingJob = /deploy.*staging|staging.*deploy/i.test(job.name);
          if (!stagingJob && !stagingSteps.length) continue;
          if (String(job.id) === authority.deployment.jobId) {
            selected++;
            const expected = authority.deployment;
            const steps = job.steps.filter(
              (step) => step.number === expected.stepNumber && step.name === expected.stepName,
            );
            const step = steps[0];
            if (
              String(run.id) !== expected.runId ||
              attempt !== expected.attempt ||
              run.head_sha !== expected.sha ||
              job.name !== expected.jobName ||
              job.status !== "completed" ||
              job.conclusion !== "success" ||
              !job.started_at ||
              !job.completed_at ||
              steps.length !== 1 ||
              !step ||
              step.status !== "completed" ||
              step.conclusion !== "success" ||
              Date.parse(step.started_at ?? "") !== start ||
              Date.parse(step.completed_at ?? "") !== selectedEnd ||
              Date.parse(job.started_at) > start ||
              Date.parse(job.completed_at) < selectedEnd
            )
              throw new Error("selected-job-unexecuted");
            const deployment = readCountCaptureExecutedDeployment(
              job,
              await reader.jobLog(expected.jobId),
              expected.stepNumber,
            );
            if (deployment.sha !== expected.sha || deployment.digest !== expected.digest)
              throw new Error("deploy-image-mismatch");
          } else if (job.status !== "completed" || !job.completed_at || Date.parse(job.completed_at) >= start) {
            // Failed and earlier-started attempts can mutate the deployment.
            // Skipped jobs with no executed steps are explicit non-authority.
            if (
              !(
                job.conclusion === "skipped" &&
                job.steps.every((step) => step.status === "completed" && step.conclusion === "skipped")
              )
            )
              overlap = true;
          }
        }
      }
    }
    if (selected !== 1) throw new Error("selected-job-missing-or-duplicate");
    const collection = result(true);
    if (!validateCountCaptureAuthority({ ...authority, collection }, now)) return result(false);
    return collection;
  } catch {
    return result(false);
  }
}
