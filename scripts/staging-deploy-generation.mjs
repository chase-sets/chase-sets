import { countCaptureSearchFrom } from "../bounded-contexts/catalog/features/scope-sync-batches/domain/count-lifecycle-receipt.ts";
import { readCountCaptureDeploymentLog } from "./catalog-count-capture-deployment.mjs";
import { countCaptureGitHubLimits, createCountCaptureGitHubReader } from "./catalog-count-capture-github.mjs";

// Selects the staging deploy generation: the newest Deploy Staging job of the
// Platform Deploy workflow that provably applied its release, bound to the commit
// and image digest its own deploy step logged. Authority comes only from that
// owning job's executed steps, identity and times, over a complete inventory of
// every run and attempt that could hold a newer deploy. A run's conclusion, head
// SHA or order grants nothing; a newer unfinished or indeterminate deploy, or any
// incomplete listing, refuses. Every refusal is one bounded stop code.

const repository = "chase-sets/chase-sets";
const workflowFile = "platform-production.yml";
const workflowName = "Platform Deploy";
const jobName = "Deploy Staging";
// G1, G2 and G3 of the Deploy Staging job, which are also their order by name.
const governedSteps = [
  "Activate immutable release before staging mutation",
  "Deploy staging Kubernetes release",
  "Mark staging applied",
];
const perPage = 100;
// Filtered listings return at most 1,000 results; larger run windows are split.
const filteredResultCap = 1000;
const maxAgeBound = 604_800;
const rejectionReasons = new Set(["job-not-success", "deploy-not-applied", "superseded"]);
const deploymentKeys = [
  "workflowFile",
  "workflowName",
  "jobName",
  "runId",
  "jobId",
  "runNumber",
  "runAttempt",
  "deployedHead",
  "imageDigest",
  "jobConclusion",
  "steps",
  "jobCompletedAt",
  "ageSeconds",
  "inventory",
  "rejectedRuns",
];
const inventoryCounts = ["runsTotalCount", "runsCollected", "runsInspected", "attemptsInspected", "jobsCollected"];
const generationKeys = ["runId", "runAttempt", "jobId", "jobCompletedAt", "deployedHead"];

class SelectionStop extends Error {
  constructor(stop) {
    super(stop);
    this.stop = stop;
  }
}
const stop = (code) => new SelectionStop(code);

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isInstant = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const inRange = (value, minimum, maximum) => Number.isInteger(value) && value >= minimum && value <= maximum;
const isDecimalId = (value) => typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const toSecond = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

// Complete, total-closed paging: the total stays stable, ids never repeat, and a
// short page before the total is reached is truncation, never completeness.
async function closedPages(first, readPage, key, incomplete) {
  if (!isRecord(first) || !inRange(first.total_count, 0, filteredResultCap)) throw stop(incomplete);
  const entries = [];
  const seen = new Set();
  let body = first;
  for (let page = 1; ; page++) {
    if (page > 1) body = await readPage(page);
    if (!isRecord(body) || body.total_count !== first.total_count) throw stop(incomplete);
    const listed = body[key];
    if (!Array.isArray(listed) || listed.length > perPage) throw stop(incomplete);
    for (const entry of listed) {
      if (!isRecord(entry) || !Number.isSafeInteger(entry.id) || entry.id < 1 || seen.has(entry.id))
        throw stop(incomplete);
      seen.add(entry.id);
      entries.push(entry);
    }
    if (entries.length > first.total_count) throw stop(incomplete);
    if (entries.length === first.total_count) return entries;
    if (listed.length < perPage) throw stop(incomplete);
  }
}

// Only these fields of a listed run are ever read; its conclusion, pull requests
// and head SHA grant nothing.
function readRun(value) {
  if (
    value.path !== `.github/workflows/${workflowFile}` ||
    typeof value.name !== "string" ||
    typeof value.status !== "string" ||
    !inRange(value.run_number, 1, 1_000_000) ||
    !inRange(value.run_attempt, 1, 100) ||
    !isInstant(value.created_at) ||
    !isInstant(value.updated_at)
  )
    throw stop("deploy-run-inventory-incomplete");
  return {
    id: value.id,
    name: value.name,
    number: value.run_number,
    attempts: value.run_attempt,
    status: value.status,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

// Every Platform Deploy run created in [createdFrom, createdTo], with no branch,
// status, event or conclusion filter.
async function listRuns(read, inventory) {
  const incomplete = "deploy-run-inventory-incomplete";
  const page = (from, to, number) =>
    read((reader) =>
      reader.json(
        `/actions/workflows/${workflowFile}/runs?per_page=${perPage}&page=${number}&created=${toSecond(from * 1000)}..${toSecond(to * 1000)}`,
      ),
    );
  async function created(from, to) {
    const first = await page(from, to, 1);
    if (isRecord(first) && Number.isSafeInteger(first.total_count) && first.total_count > filteredResultCap) {
      if (to <= from) throw stop(incomplete);
      const middle = Math.floor((from + to) / 2);
      return [...(await created(from, middle)), ...(await created(middle + 1, to))];
    }
    const runs = (await closedPages(first, (number) => page(from, to, number), "workflow_runs", incomplete)).map(
      readRun,
    );
    if (runs.some(({ createdAt }) => Date.parse(createdAt) < from * 1000 || Date.parse(createdAt) >= (to + 1) * 1000))
      throw stop(incomplete);
    inventory.runsTotalCount += first.total_count;
    return runs;
  }
  const runs = await created(Date.parse(inventory.createdFrom) / 1000, Date.parse(inventory.createdTo) / 1000);
  if (new Set(runs.map(({ id }) => id)).size !== runs.length) throw stop(incomplete);
  inventory.runsCollected = runs.length;
  return runs;
}

// One attempt's own jobs; a job listed under another run or attempt is not this
// attempt's inventory.
async function listJobs(read, run, attempt) {
  const incomplete = "deploy-job-inventory-incomplete";
  const page = (number) =>
    read((reader) =>
      reader.json(`/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=${perPage}&page=${number}`),
    );
  const jobs = await closedPages(await page(1), page, "jobs", incomplete);
  if (
    jobs.some(
      (job) =>
        job.run_id !== run.id ||
        job.run_attempt !== attempt ||
        typeof job.name !== "string" ||
        typeof job.status !== "string",
    )
  )
    throw stop(incomplete);
  return jobs;
}

// Classifies one completed Deploy Staging job by its governed steps, matched by
// exact name (their numbers differ between workflow revisions).
function classify(job) {
  if (!Array.isArray(job.steps) || !job.steps.every((step) => isRecord(step) && typeof step.name === "string"))
    throw stop("deploy-step-inventory-divergence");
  if (job.steps.length === 0 && job.conclusion !== "success") return { outcome: "job-not-success" };
  const found = governedSteps.map((name) => job.steps.filter((step) => step.name === name));
  if (found.some((steps) => steps.length !== 1)) throw stop("deploy-step-inventory-divergence");
  const steps = found.map(([step]) => step);
  const [activate, deploy, applied] = steps;
  const succeeded = (step) => step.conclusion === "success";
  const skipped = (step) => step.conclusion === "skipped";
  const completedAt = isInstant(job.completed_at) ? Date.parse(job.completed_at) : Number.NaN;
  if (job.conclusion === "success" && steps.every(succeeded) && Number.isFinite(completedAt))
    return { outcome: "applied", steps, completedAt };
  if (job.conclusion === "success" && succeeded(activate) && skipped(deploy) && skipped(applied))
    return { outcome: "deploy-not-applied" };
  if (!succeeded(activate) && skipped(deploy) && skipped(applied)) return { outcome: "job-not-success" };
  // It ran, or may have run, the deploy without being marked applied. An
  // unusable completion time orders at or after every applied job.
  return { outcome: "indeterminate", completedAt };
}

// The applied job with the latest completed_at. Skipped jobs' placeholder times
// never order: only applied and indeterminate jobs carry a completion.
function newestApplied(executions, nowMs, windowStartMs) {
  const applied = executions.filter(({ outcome }) => outcome === "applied");
  const newest = Math.max(...applied.map(({ completedAt }) => completedAt));
  if (executions.some(({ outcome, completedAt }) => outcome === "indeterminate" && !(completedAt < newest)))
    throw stop("deploy-outcome-indeterminate");
  if (applied.length === 0) throw stop("no-applied-deploy-found");
  const latest = applied.filter(({ completedAt }) => completedAt === newest);
  if (latest.length !== 1) throw stop("deploy-staging-job-ambiguous");
  if (newest > nowMs) throw stop("future-instant-refused");
  if (newest < windowStartMs) throw stop("deploy-too-stale");
  return latest[0];
}

const rejection = ({ run, attempt, job, outcome }) => ({
  runId: String(run.id),
  runAttempt: attempt,
  jobId: String(job.id),
  reason: outcome === "applied" || outcome === "indeterminate" ? "superseded" : outcome,
});

// JSON.parse keeps the last of duplicate keys; this scan of already-valid JSON
// refuses them instead. Strings are whole tokens, so a colon outside one always
// follows its object's key.
function hasDuplicateKey(text) {
  const scopes = [];
  let previous = null;
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\]:]/g)) {
    if (token === "{") scopes.push(new Set());
    else if (token === "[") scopes.push(null);
    else if (token === "}" || token === "]") scopes.pop();
    else if (token === ":") {
      const key = JSON.parse(previous);
      if (scopes.at(-1).has(key)) return true;
      scopes.at(-1).add(key);
    }
    previous = token;
  }
  return false;
}

const hasExactKeys = (value, keys) =>
  isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function isDeployment(deployment) {
  if (!hasExactKeys(deployment, deploymentKeys)) return false;
  const { steps, inventory, rejectedRuns } = deployment;
  return (
    deployment.workflowFile === workflowFile &&
    deployment.workflowName === workflowName &&
    deployment.jobName === jobName &&
    isDecimalId(deployment.runId) &&
    isDecimalId(deployment.jobId) &&
    inRange(deployment.runNumber, 1, 1_000_000) &&
    inRange(deployment.runAttempt, 1, 100) &&
    matches(/^[a-f0-9]{40}$/, deployment.deployedHead) &&
    matches(/^sha256:[a-f0-9]{64}$/, deployment.imageDigest) &&
    deployment.jobConclusion === "success" &&
    Array.isArray(steps) &&
    steps.length === governedSteps.length &&
    steps.every(
      (step, index) =>
        hasExactKeys(step, ["name", "number", "conclusion"]) &&
        step.name === governedSteps[index] &&
        inRange(step.number, 1, 200) &&
        step.conclusion === "success",
    ) &&
    isInstant(deployment.jobCompletedAt) &&
    inRange(deployment.ageSeconds, 0, maxAgeBound) &&
    hasExactKeys(inventory, ["createdFrom", "createdTo", ...inventoryCounts]) &&
    isInstant(inventory.createdFrom) &&
    isInstant(inventory.createdTo) &&
    inventoryCounts.every((key) => inRange(inventory[key], 0, 100_000)) &&
    inventory.runsCollected === inventory.runsTotalCount &&
    inventory.runsTotalCount >= inventory.runsInspected &&
    Array.isArray(rejectedRuns) &&
    rejectedRuns.length <= 1000 &&
    rejectedRuns.every(
      (entry, index) =>
        hasExactKeys(entry, ["runId", "runAttempt", "jobId", "reason"]) &&
        isDecimalId(entry.runId) &&
        inRange(entry.runAttempt, 1, 100) &&
        isDecimalId(entry.jobId) &&
        rejectionReasons.has(entry.reason) &&
        (index === 0 || BigInt(rejectedRuns[index - 1].jobId) < BigInt(entry.jobId)),
    )
  );
}

// Parses a serialized `{deployment, deployGeneration}` and refuses any unknown,
// missing or duplicate key at any level, and any value outside its rule.
// `deployGeneration` is the projection consumers bind: five fields, each equal to
// deployment's.
export function readStagingDeployGeneration(text) {
  const refused = () => new Error("closed-schema-shallow-validation");
  if (typeof text !== "string") throw refused();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw refused();
  }
  if (
    hasDuplicateKey(text) ||
    !hasExactKeys(value, ["deployment", "deployGeneration"]) ||
    !isDeployment(value.deployment) ||
    !hasExactKeys(value.deployGeneration, generationKeys) ||
    generationKeys.some((key) => value.deployGeneration[key] !== value.deployment[key])
  )
    throw refused();
  return value;
}

// Selects the newest applied staging deploy generation. The window starts
// `maxAgeSeconds` (1..604800) before `now`, or at the caller's explicit
// `windowStart` with no age bound. Returns `{stop: null, deployment,
// deployGeneration}` or `{stop, deployment: null, deployGeneration: null}`;
// invalid input throws before any request.
export async function selectStagingDeployGeneration({
  token,
  transport,
  requestTimeoutMs,
  now,
  maxAgeSeconds,
  windowStart,
}) {
  const ageBounded = maxAgeSeconds !== undefined;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    !isInstant(now) ||
    ageBounded === (windowStart !== undefined) ||
    (ageBounded ? !inRange(maxAgeSeconds, 1, maxAgeBound) : !isInstant(windowStart))
  )
    throw new TypeError("staging-deploy-generation-input-invalid");
  const nowMs = Date.parse(now);
  const windowStartMs = ageBounded ? nowMs - maxAgeSeconds * 1000 : Date.parse(windowStart);
  const reader = createCountCaptureGitHubReader({
    repository,
    token,
    transport,
    limits: { ...countCaptureGitHubLimits, deadlineMs: requestTimeoutMs },
  });
  const read = async (operation) => {
    try {
      return await operation(reader);
    } catch {
      throw stop("github-request-failed");
    }
  };

  try {
    const inventory = {
      createdFrom: countCaptureSearchFrom(new Date(windowStartMs).toISOString()),
      createdTo: toSecond(nowMs),
      runsTotalCount: 0,
      runsCollected: 0,
      runsInspected: 0,
      attemptsInspected: 0,
      jobsCollected: 0,
    };
    const runs = await listRuns(read, inventory);
    // A completed run last updated before the window cannot hold a deploy that
    // completed inside it; a re-run would have updated it.
    const candidates = runs.filter(
      ({ status, updatedAt }) => status !== "completed" || Date.parse(updatedAt) >= windowStartMs,
    );
    inventory.runsInspected = candidates.length;
    const executions = [];
    for (const run of candidates)
      for (let attempt = 1; attempt <= run.attempts; attempt++) {
        inventory.attemptsInspected++;
        const jobs = await listJobs(read, run, attempt);
        inventory.jobsCollected += jobs.length;
        const deploys = jobs.filter((job) => job.name === jobName);
        if (deploys.length > 1) throw stop("deploy-staging-job-ambiguous");
        if (deploys.length === 0) continue;
        const [job] = deploys;
        if (job.status !== "completed") throw stop("deploy-in-progress");
        executions.push({ run, attempt, job, ...classify(job) });
      }

    const selected = newestApplied(executions, nowMs, windowStartMs);
    const { run, attempt, job, steps, completedAt } = selected;
    const [, deployStep] = steps;
    const log = await read((reader) => reader.jobLog(String(job.id)));
    let bound;
    try {
      bound = readCountCaptureDeploymentLog(log, deployStep);
    } catch {
      throw stop("deploy-log-unbound");
    }
    const deployment = {
      workflowFile,
      workflowName: run.name,
      jobName: job.name,
      runId: String(run.id),
      jobId: String(job.id),
      runNumber: run.number,
      runAttempt: attempt,
      deployedHead: bound.sha,
      imageDigest: bound.digest,
      jobConclusion: job.conclusion,
      steps: steps.map(({ name, number, conclusion }) => ({ name, number, conclusion })),
      jobCompletedAt: job.completed_at,
      ageSeconds: Math.floor((nowMs - completedAt) / 1000),
      inventory,
      rejectedRuns: executions
        .filter((execution) => execution !== selected)
        .map(rejection)
        .sort((left, right) => Number(left.jobId) - Number(right.jobId)),
    };
    const deployGeneration = Object.fromEntries(generationKeys.map((key) => [key, deployment[key]]));
    let document;
    try {
      document = readStagingDeployGeneration(JSON.stringify({ deployment, deployGeneration }));
    } catch {
      throw stop("closed-schema-shallow-validation");
    }
    return { stop: null, ...document };
  } catch (error) {
    if (error instanceof SelectionStop) return { stop: error.stop, deployment: null, deployGeneration: null };
    throw error;
  }
}
