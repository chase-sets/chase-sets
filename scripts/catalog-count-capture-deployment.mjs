import { parse } from "yaml";
import {
  countCaptureAuthoritySchema,
  countCaptureCollectionSchema,
  countCaptureSearchFrom,
} from "../bounded-contexts/catalog/features/scope-sync-batches/domain/count-lifecycle-receipt.ts";

// Deployment collector for the count-lifecycle capture. It pages every workflow
// run that could have executed after the selected staging deploy step, every
// attempt and every job, binds the executed step's own log block to SHA@digest,
// and classifies every other job that executed in that window by the definition
// GitHub executed: the run's workflow file at the attempt's executed revision.
// Anything it cannot prove returns a bound-free "unknown"; nothing here is live
// deployment authority.

// Filtered run listings return at most 1,000 results; larger ranges are split.
const filteredResultCap = 1000;
const pageBound = 10_000;
const perPage = 100;

// Secrets that sign a browser into the staging Admin application and cannot reach
// the cluster, registry or Terraform state (the application-runtime grants in
// .github/authority/catalog-staging-provider-uat/). The staging-scoped
// DIGITALOCEAN_ACCESS_TOKEN is an environment secret
// (docs/runbooks/digitalocean-platform-deployment.md), so only a job bound to the
// staging environment can hold deployment-capable staging credentials.
const stagingSignInSecrets = new Set([
  "CATALOG_ADMIN_E2E_PASSWORD",
  "PLATFORM_ADMIN_EMAIL",
  "PLATFORM_ADMIN_PASSWORD",
  "GITHUB_TOKEN",
]);
const hostedRunner = /^(ubuntu|windows|macos)-[a-z0-9.-]+$/;
const workflowPath = /^\.github\/workflows\/[A-Za-z0-9_.-]{1,200}\.ya?ml$/;
// A same-repository reusable workflow runs from the caller's own commit; the
// attempt's referenced workflows record which one.
const localReusable = /^\.\/(\.github\/workflows\/[A-Za-z0-9_.-]{1,200}\.ya?ml)$/;
const referencedWorkflow =
  /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/(\.github\/workflows\/[A-Za-z0-9_.-]{1,200}\.ya?ml)@[\x21-\x7e]{1,256}$/;
// Events whose run head SHA is the commit GitHub read the workflow from. A
// pull_request run executes the PR merge commit instead, which only its attempt's
// merge-ref referenced workflows record; any other event's revision is unproven.
const headSourcedEvents = new Set(["push", "workflow_dispatch", "schedule", "merge_group"]);
const mergeRef = /^refs\/pull\/[1-9]\d{0,9}\/merge$/;

class CollectionUnknown extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}
const unknown = (reason) => new CollectionUnknown(reason);

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isInstant = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
const isId = (value) => Number.isSafeInteger(value) && value > 0;
const isText = (value, maximum) => typeof value === "string" && value.length > 0 && value.length <= maximum;
const nullableInstant = (value) => value === null || isInstant(value);
const toSecond = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");

function readRun(value) {
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !Number.isInteger(value.run_attempt) ||
    value.run_attempt < 1 ||
    value.run_attempt > 1000 ||
    !/^[a-f0-9]{40}$/.test(value.head_sha ?? "") ||
    !isText(value.path, 512) ||
    !isText(value.event, 64) ||
    !isText(value.status, 64) ||
    !isInstant(value.created_at) ||
    !isInstant(value.updated_at) ||
    Date.parse(value.updated_at) < Date.parse(value.created_at)
  )
    throw unknown("malformed-response");
  return value;
}

function readJob(value, run, attempt) {
  const step = (entry) =>
    isRecord(entry) &&
    isText(entry.name, 1024) &&
    Number.isInteger(entry.number) &&
    entry.number > 0 &&
    isText(entry.status, 64) &&
    (entry.conclusion === null || isText(entry.conclusion, 64)) &&
    nullableInstant(entry.started_at) &&
    nullableInstant(entry.completed_at);
  if (
    !isRecord(value) ||
    !isId(value.id) ||
    !isText(value.name, 1024) ||
    !isText(value.status, 64) ||
    !(value.conclusion === null || isText(value.conclusion, 64)) ||
    !nullableInstant(value.started_at) ||
    !nullableInstant(value.completed_at) ||
    !Array.isArray(value.steps) ||
    value.steps.length > 1000 ||
    !value.steps.every(step)
  )
    throw unknown("malformed-response");
  // A job listed under another run, attempt or head is not this inventory's job.
  if (value.run_id !== run.id || value.run_attempt !== attempt || value.head_sha !== run.head_sha)
    throw unknown("malformed-response");
  return value;
}

const skippedStep = (step) => step.status === "completed" && step.conclusion === "skipped";
const ordered = (from, to) => from !== null && to !== null && Date.parse(from) <= Date.parse(to);

// The interval a completed job provably executed in, or null when its times cannot
// establish one (never started, or skipped with placeholder times). A job that ran
// steps must report an ordered interval enclosing every executed step's own
// ordered interval; contradictory executed times are refused, never trusted.
function executedInterval(job) {
  if (job.status !== "completed" || job.conclusion === "skipped") return null;
  const executed = job.steps.filter((step) => !skippedStep(step));
  if (executed.length === 0) return ordered(job.started_at, job.completed_at) ? job : null;
  if (
    !ordered(job.started_at, job.completed_at) ||
    !executed.every(
      (step) =>
        step.status === "completed" &&
        ordered(step.started_at, step.completed_at) &&
        ordered(job.started_at, step.started_at) &&
        ordered(step.completed_at, job.completed_at),
    )
  )
    throw unknown("malformed-response");
  return job;
}

// The attempt's own run object: same run, attempt, head, workflow and event as the
// listing, and the referenced workflows GitHub resolved for that attempt.
function readAttemptReferences(value, run, attempt) {
  if (
    !isRecord(value) ||
    value.id !== run.id ||
    value.run_attempt !== attempt ||
    value.head_sha !== run.head_sha ||
    value.path !== run.path ||
    value.event !== run.event
  )
    throw unknown("malformed-response");
  const references = value.referenced_workflows ?? [];
  if (!Array.isArray(references) || references.length > 100) throw unknown("malformed-response");
  return references.map((reference) => {
    const match = isRecord(reference) ? referencedWorkflow.exec(reference.path ?? "") : null;
    if (
      !match ||
      !/^[a-f0-9]{40}$/.test(reference.sha ?? "") ||
      !(reference.ref === undefined || reference.ref === null || isText(reference.ref, 256))
    )
      throw unknown("malformed-response");
    return { path: match[1], sha: reference.sha, ref: reference.ref ?? null };
  });
}

// The commit whose workflow files this attempt executed. Never the PR head for a
// pull_request run, and never a branch tip or current ref as a fallback.
function executedRevision(run, references) {
  if (headSourcedEvents.has(run.event)) return run.head_sha;
  if (run.event !== "pull_request") throw unknown("deployment-capability-unknown");
  const merged = new Set(
    references.filter((reference) => reference.ref !== null && mergeRef.test(reference.ref)).map(({ sha }) => sha),
  );
  if (merged.size !== 1) throw unknown("deployment-capability-unknown");
  return [...merged][0];
}

// A same-repository callee runs from the caller's revision, and the attempt must
// record exactly that one reference to it.
function calleeRevision(references, callee, revision) {
  const matches = references.filter((reference) => reference.path === callee);
  if (matches.length !== 1 || matches[0].sha !== revision) throw unknown("deployment-capability-unknown");
  return revision;
}

// --- Executed deploy step and its log ---------------------------------------

const logLine = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z ?(.*)$/;

// Binds the one platform-kubernetes-deployment/v1 block in the job log to the
// selected step: every block line must be timestamped inside that step's
// executed interval (GitHub reports step times to the second).
export function readCountCaptureDeploymentLog(log, step) {
  if (typeof log !== "string" || log.length > 8_388_608) throw unknown("deploy-log-unbound");
  const lines = log.split(/\r?\n/).map((line) => {
    const match = logLine.exec(line);
    return match ? { second: Date.parse(`${match[1]}Z`), text: match[2] } : { second: Number.NaN, text: line };
  });
  const markers = lines.flatMap((line, index) =>
    line.text.trim() === '"schemaVersion": "platform-kubernetes-deployment/v1",' ? [index] : [],
  );
  if (markers.length !== 1 || lines[markers[0] - 1]?.text.trim() !== "{") throw unknown("deploy-log-unbound");
  const open = markers[0] - 1;
  for (let close = open + 1; close < Math.min(lines.length, open + 101); close++) {
    if (lines[close].text.trim() !== "}") continue;
    let block;
    try {
      block = JSON.parse(
        lines
          .slice(open, close + 1)
          .map((line) => line.text)
          .join("\n"),
      );
    } catch {
      continue;
    }
    const from = Date.parse(step.started_at);
    const to = Date.parse(step.completed_at);
    const image = /^[\x21-\x7e]+:([a-f0-9]{40})@(sha256:[a-f0-9]{64})$/.exec(block?.image ?? "");
    if (
      !lines.slice(open, close + 1).every((line) => line.second >= from && line.second <= to) ||
      block.action !== "deploy" ||
      block.namespace !== "chase-sets-platform" ||
      block.result !== "success" ||
      !image
    )
      throw unknown("deploy-log-unbound");
    return { sha: image[1], digest: image[2] };
  }
  throw unknown("deploy-log-unbound");
}

// The executed job/step itself, never a run-level conclusion.
export function readCountCaptureExecutedDeployment(job, log, deployment) {
  const steps = job.steps.filter((step) => step.number === deployment.stepNumber && step.name === deployment.stepName);
  const step = steps[0];
  if (
    String(job.id) !== deployment.jobId ||
    job.run_attempt !== deployment.attempt ||
    String(job.run_id) !== deployment.runId ||
    job.head_sha !== deployment.sha ||
    job.name !== deployment.jobName ||
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    steps.length !== 1 ||
    step.status !== "completed" ||
    step.conclusion !== "success" ||
    !step.started_at ||
    !step.completed_at ||
    Date.parse(step.started_at) !== Date.parse(deployment.startedAt) ||
    Date.parse(step.completed_at) !== Date.parse(deployment.completedAt) ||
    Date.parse(step.started_at) >= Date.parse(step.completed_at) ||
    // The executed job's own finite interval must enclose the selected step.
    !ordered(job.started_at, step.started_at) ||
    !ordered(step.completed_at, job.completed_at)
  )
    throw unknown("selected-job-unexecuted");
  const bound = readCountCaptureDeploymentLog(log, step);
  if (bound.sha !== job.head_sha || bound.digest !== deployment.digest) throw unknown("deploy-image-mismatch");
  return {
    runId: deployment.runId,
    attempt: deployment.attempt,
    jobId: deployment.jobId,
    stepNumber: deployment.stepNumber,
    sha: bound.sha,
    digest: bound.digest,
  };
}

// --- Head-bound job capability ----------------------------------------------

// Secret references inside expressions anywhere in a definition. Bare or indexed
// access to the secrets context is dynamic and therefore unclassifiable.
function secretReferences(value, names = new Set(), state = { dynamic: false }, expression = false) {
  if (typeof value === "string") {
    const segments = expression ? [value] : [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((match) => match[1]);
    for (const segment of segments)
      for (const match of segment.matchAll(/\bsecrets\b(\s*\.\s*([A-Za-z_][A-Za-z0-9_]*))?/g)) {
        if (match[2]) names.add(match[2]);
        else state.dynamic = true;
      }
  } else if (Array.isArray(value)) {
    for (const entry of value) secretReferences(entry, names, state);
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === "secrets") state.dynamic = true;
      secretReferences(entry, names, state, key === "if");
    }
  }
  return { names, dynamic: state.dynamic };
}

function writesIdToken(permissions) {
  return permissions === "write-all" || (isRecord(permissions) && permissions["id-token"] === "write");
}

// A token with Actions write can dispatch any workflow, a staging deployer
// included, without holding a staging secret itself. A job declaring no
// permissions at job or workflow level receives the repository default, which
// the definition cannot prove read-only.
function mayDispatch(permissions) {
  if (permissions === "read-all") return false;
  if (isRecord(permissions)) return permissions.actions === "write";
  return true;
}

function runnerLabels(runsOn) {
  if (typeof runsOn === "string") return [runsOn];
  if (Array.isArray(runsOn)) return runsOn;
  return [null];
}

// "staging-mutator" when the executed definition can hold credentials able to
// change the staging deployment or dispatch a workflow that can, "non-mutating"
// only when it provably cannot, and "reusable" when a same-repository callee at
// the same revision decides it.
function jobCapability(job, workflow) {
  if (!isRecord(job)) return "staging-mutator";
  const permissions = job.permissions ?? workflow.permissions;
  if (mayDispatch(permissions)) return "staging-mutator";
  if (job.uses !== undefined)
    return typeof job.uses === "string" && localReusable.test(job.uses) && !writesIdToken(permissions)
      ? "reusable"
      : "staging-mutator";
  const environment = isRecord(job.environment) ? job.environment.name : job.environment;
  if (environment !== undefined && typeof environment !== "string") return "staging-mutator";
  const stagingBound =
    typeof environment === "string" && (environment.toLowerCase() === "staging" || environment.includes("${{"));
  const references = secretReferences({ job, env: workflow.env });
  const hosted = runnerLabels(job["runs-on"]).every((label) => typeof label === "string" && hostedRunner.test(label));
  const idToken = writesIdToken(permissions);
  if (!hosted || idToken || references.dynamic) return "staging-mutator";
  if (!stagingBound) return "non-mutating";
  return [...references.names].every((name) => stagingSignInSecrets.has(name)) ? "non-mutating" : "staging-mutator";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// A listed job's display name routes it to candidate definitions; the capability
// always comes from the candidate definitions, never from the name.
function displayNameMatcher(key, job) {
  const template = typeof job?.name === "string" ? job.name : key;
  const parts = template.split(/\$\{\{[\s\S]*?\}\}/);
  let pattern = parts.map(escapeRegExp).join(".*");
  if (job?.strategy?.matrix !== undefined && parts.length === 1) pattern += String.raw`(?: \(.*\))?`;
  if (job?.uses !== undefined) pattern += "(?: / (.+))?";
  return new RegExp(`^${pattern}$`, "s");
}

export function readCountCaptureWorkflowCapabilities(text) {
  let workflow;
  try {
    workflow = parse(text, { maxAliasCount: 50, uniqueKeys: true });
  } catch {
    throw unknown("deployment-capability-unknown");
  }
  if (!isRecord(workflow) || !isRecord(workflow.jobs) || !Object.keys(workflow.jobs).length)
    throw unknown("deployment-capability-unknown");
  return Object.entries(workflow.jobs).map(([key, job]) => {
    const capability = jobCapability(job, workflow);
    return {
      key,
      matcher: displayNameMatcher(key, job),
      capability,
      callee: capability === "reusable" ? localReusable.exec(job.uses)[1] : null,
    };
  });
}

// Resolves a listed job to its candidate definitions. A reusable caller is
// classified by its callee's jobs (all of them when the listing names none);
// a callee that itself calls a reusable workflow is not followed.
export async function classifyCountCaptureJob(definitions, jobName, readCallee, depth = 0) {
  const candidates = definitions.filter((definition) => definition.matcher.test(jobName));
  if (!candidates.length) return "unclassified";
  for (const candidate of candidates) {
    if (candidate.capability === "non-mutating") continue;
    if (candidate.capability !== "reusable" || depth > 0 || !readCallee) return "staging-mutator";
    const callee = await readCallee(candidate.callee);
    const calleeJob = candidate.matcher.exec(jobName)[1];
    const capabilities = calleeJob
      ? [await classifyCountCaptureJob(callee, calleeJob, readCallee, depth + 1)]
      : callee.map((definition) => (definition.capability === "non-mutating" ? "non-mutating" : "staging-mutator"));
    if (capabilities.includes("unclassified")) return "unclassified";
    if (capabilities.some((capability) => capability !== "non-mutating")) return "staging-mutator";
  }
  return "non-mutating";
}

// --- Collection --------------------------------------------------------------

export async function collectCountCaptureDeployment(reader, deploymentInput, now) {
  if (!isInstant(now)) throw new TypeError("count-capture-collection-clock-invalid");
  const counts = {
    runCount: 0,
    attemptCount: 0,
    jobCount: 0,
    pageCount: 0,
    definitionCount: 0,
    nonMutatingJobCount: 0,
  };
  let createdFrom = now;
  const result = (outcome, reason, binding) =>
    countCaptureCollectionSchema.parse({ collectedAt: now, outcome, reason, binding, createdFrom, ...counts });
  const call = async (operation) => {
    if (counts.pageCount >= pageBound) throw unknown("inventory-cap");
    counts.pageCount++;
    try {
      return await operation();
    } catch {
      throw unknown("http-failure");
    }
  };
  try {
    const parsed = countCaptureAuthoritySchema.shape.deployment.safeParse(deploymentInput);
    if (!parsed.success) throw unknown("authority-invalid");
    const deployment = parsed.data;
    const windowStart = Date.parse(deployment.startedAt);
    const collectedAt = Date.parse(now);
    if (windowStart > collectedAt) throw unknown("selected-job-unexecuted");
    createdFrom = countCaptureSearchFrom(deployment.startedAt);
    const from = Date.parse(createdFrom) / 1000;
    const to = Math.floor(collectedAt / 1000);

    // Complete, total-closed paging: totals stay stable, ids never repeat and
    // short pages before the total is reached are truncation, not completeness.
    async function closedPages(first, readPage, key) {
      const values = [];
      const seen = new Set();
      let body = first;
      for (let page = 1; ; page++) {
        if (page > 1) body = await readPage(page);
        if (!isRecord(body) || !Number.isSafeInteger(body.total_count) || body.total_count < 0)
          throw unknown("malformed-response");
        if (body.total_count !== first.total_count) throw unknown("inventory-changed");
        const entries = body[key];
        if (!Array.isArray(entries) || entries.length > perPage) throw unknown("malformed-response");
        for (const entry of entries) {
          if (!isRecord(entry) || seen.has(entry.id)) throw unknown("inventory-duplicate");
          seen.add(entry.id);
          values.push(entry);
        }
        if (values.length > first.total_count) throw unknown("inventory-changed");
        if (values.length === first.total_count) return values;
        if (entries.length < perPage) throw unknown("inventory-truncated");
      }
    }
    const runsPage = (start, end, page) =>
      call(() =>
        reader.json(
          `/actions/runs?per_page=${perPage}&page=${page}&created=${toSecond(start * 1000)}..${toSecond(end * 1000)}`,
        ),
      );
    async function runsCreated(start, end) {
      const first = await runsPage(start, end, 1);
      if (!isRecord(first) || !Number.isSafeInteger(first.total_count)) throw unknown("malformed-response");
      if (first.total_count > filteredResultCap) {
        if (end <= start) throw unknown("inventory-cap");
        const middle = Math.floor((start + end) / 2);
        return [...(await runsCreated(start, middle)), ...(await runsCreated(middle + 1, end))];
      }
      const runs = (await closedPages(first, (page) => runsPage(start, end, page), "workflow_runs")).map(readRun);
      if (
        runs.some((run) => Date.parse(run.created_at) < start * 1000 || Date.parse(run.created_at) >= (end + 1) * 1000)
      )
        throw unknown("malformed-response");
      return runs;
    }

    const runs = await runsCreated(from, to);
    if (new Set(runs.map((run) => run.id)).size !== runs.length) throw unknown("inventory-duplicate");
    counts.runCount = runs.length;
    const definitions = new Map();
    async function definitionAt(path, revision) {
      const key = `${path}@${revision}`;
      if (!definitions.has(key)) {
        if (!workflowPath.test(path)) throw unknown("deployment-capability-unknown");
        const text = await call(() => reader.workflow(path, revision));
        definitions.set(key, readCountCaptureWorkflowCapabilities(text));
        counts.definitionCount = definitions.size;
      }
      return definitions.get(key);
    }

    let binding = null;
    let selected = 0;
    for (const run of runs) {
      // A terminal run last updated before the selected step started cannot have
      // executed after it; a re-run would have updated it.
      if (run.status === "completed" && Date.parse(run.updated_at) < windowStart && String(run.id) !== deployment.runId)
        continue;
      for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
        counts.attemptCount++;
        const references = readAttemptReferences(
          await call(() => reader.json(`/actions/runs/${run.id}/attempts/${attempt}`)),
          run,
          attempt,
        );
        const jobsPage = (page) =>
          call(() => reader.json(`/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=${perPage}&page=${page}`));
        const first = await jobsPage(1);
        if (!isRecord(first)) throw unknown("malformed-response");
        const jobs = (await closedPages(first, jobsPage, "jobs")).map((job) => readJob(job, run, attempt));
        counts.jobCount += jobs.length;
        for (const job of jobs) {
          if (String(job.id) === deployment.jobId) {
            selected++;
            const log = await call(() => reader.jobLog(deployment.jobId));
            binding = readCountCaptureExecutedDeployment(job, log, deployment);
            continue;
          }
          const unexecuted = job.status === "completed" && job.conclusion === "skipped" && job.steps.every(skippedStep);
          if (unexecuted) continue;
          // Only a validated executed interval can place a job wholly before the step.
          const interval = executedInterval(job);
          if (interval && Date.parse(interval.completed_at) < windowStart) continue;
          // Executed, running, queued or waiting at/after the selected step: only a
          // proof from the executed definition that it has no staging-deployment
          // capability lets it pass.
          const revision = executedRevision(run, references);
          const capability = await classifyCountCaptureJob(
            await definitionAt(run.path, revision),
            job.name,
            async (callee) => definitionAt(callee, calleeRevision(references, callee, revision)),
          );
          if (capability === "unclassified") throw unknown("deployment-capability-unknown");
          if (capability !== "non-mutating") throw unknown("staging-mutation-overlap");
          counts.nonMutatingJobCount++;
        }
      }
    }
    if (selected !== 1 || !binding) throw unknown("selected-job-missing");
    return result("bound", null, binding);
  } catch (error) {
    return result("unknown", error instanceof CollectionUnknown ? error.reason : "malformed-response", null);
  }
}
