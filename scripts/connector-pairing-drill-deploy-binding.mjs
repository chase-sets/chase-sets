// Delivery-owned deploy authority for the connector pairing drill, and the only drill code that reads
// GitHub Actions. The owning Deploy Staging job comes from the shared staging deploy generation (newest applied
// job; a newer unfinished or indeterminate deploy, a skipped or incomplete listing refuses), the requested run and
// commit must be that job's, and each required closed issue's implementation merge is compared with its deployed head.
// Every read is `gh api`, read-only; the product drill receives only the result.
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { selectStagingDeployGeneration } from "./staging-deploy-generation.mjs";

const repository = "chase-sets/chase-sets";
const apiOrigin = "https://api.github.com";
const maxAgeSeconds = 604_800;
const requestTimeoutMs = 30_000;
const retryDelaysMs = [200, 400];
const decimalId = /^[1-9]\d{0,19}$/;
const commitSha = /^[a-f0-9]{40}$/;
const closingMergesQuery =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { state closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { pageInfo { hasNextPage } nodes { number merged mergeCommit { oid } } } } } }";
// Reviewed manual closeout: the accepted sign-in implementation, not incidental issue references.
const manualCloseoutPullRequests = new Map([[10640, 10944]]);

class GhApiFailure extends Error {
  constructor(code, retryable = false) {
    super("gh-api-refused");
    this.code = code;
    this.retryable = retryable;
  }
}

function classifyGhFailure(error, stderr) {
  const detail = String(stderr ?? "");
  // gh api appends the status to JSON error messages (which may span lines), or prints a bare status.
  let status;
  if (/^gh: /m.test(detail))
    for (const [, bare, suffix] of detail.matchAll(/^gh: HTTP ([45]\d{2})\r?$| \(HTTP ([45]\d{2})\)\r?$/gm))
      status = Number(bare ?? suffix);
  if (status) return new GhApiFailure(`http-${status}`, status === 429 || status >= 500);
  if (error.code === "ABORT_ERR" || (!error.code && error.killed && error.signal === "SIGTERM"))
    return new GhApiFailure("timeout", true);
  if (/^(?:gh: )?(?:Get "[^\r\n]*": |net\/http: |dial tcp |read tcp |unexpected EOF)/m.test(detail))
    return new GhApiFailure("transport", true);
  if (Number.isInteger(error.code) && error.code >= 0 && error.code <= 255)
    return new GhApiFailure(`exit-${error.code}`);
  return new GhApiFailure("process-failed");
}

async function retryGitHubGet(request) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof GhApiFailure) || !error.retryable || attempt === retryDelaysMs.length) throw error;
      await delay(retryDelaysMs[attempt]);
    }
  }
}

const withReadFailure = (stop, phase, error) => ({
  stop: error instanceof GhApiFailure ? `${stop}:${phase}:${error.code}` : stop,
});

/** One read-only `gh api` call; its stdout, or a value-free refusal. */
export function ghApi(args, { run = execFile, signal } = {}) {
  return new Promise((resolve, reject) => {
    run(
      "gh",
      ["api", ...args],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: requestTimeoutMs, windowsHide: true, signal },
      (error, stdout, stderr) => (error ? reject(classifyGhFailure(error, stderr)) : resolve(stdout)),
    );
  });
}

/**
 * A `fetch`-shaped transport for the shared GitHub reader. GitHub REST paths go through `gh api`, which holds its
 * own credential (the reader's bearer header is never sent); any other URL is refused unsent.
 */
export function ghApiTransport(gh = ghApi, onFailure = () => {}) {
  return async (url, init = {}) => {
    const target = new URL(url);
    if (target.origin !== apiOrigin || (init.method ?? "GET") !== "GET") return new Response(null, { status: 599 });
    const { signal } = init;
    const onAbort = () => onFailure(new GhApiFailure("timeout", true));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const body = await gh(
        [
          "-H",
          `Accept: ${init.headers?.accept ?? "application/vnd.github+json"}`,
          `${target.pathname.slice(1)}${target.search}`,
        ],
        { signal },
      );
      return new Response(body, { status: 200 });
    } catch (error) {
      if (!signal?.aborted)
        onFailure(error instanceof GhApiFailure ? error : new GhApiFailure("transport-unclassified"));
      return new Response(null, { status: 502 });
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

const json = (bytes) => JSON.parse(Buffer.from(bytes).toString("utf8"));
/** Derives the sign-in floor from selected deploy authority, never from the requested run or a local receipt. */
export async function readStagingSignInReceiptFloor({ generation, requiredMerges }, { gh = ghApi } = {}) {
  const isInstant = (value) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
  const signInMerges = requiredMerges.filter((merge) => merge.issue === 10640);
  if (signInMerges.length !== 1 || !signInMerges[0].contained) return null;
  const job = json(await retryGitHubGet(() => gh([`repos/${repository}/actions/jobs/${generation.jobId}`])));
  if (
    String(job.id) !== generation.jobId ||
    String(job.run_id) !== generation.runId ||
    job.run_attempt !== generation.runAttempt ||
    job.name !== "Deploy Staging" ||
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    job.completed_at !== generation.jobCompletedAt ||
    !isInstant(job.started_at) ||
    !isInstant(job.completed_at) ||
    !Array.isArray(job.steps) ||
    !job.steps.every((step) => step && typeof step.name === "string")
  )
    return null;
  const names = [
    "Activate immutable release before staging mutation",
    "Apply staging Kubernetes runtime secrets",
    "Deploy staging Kubernetes release",
    "Mark staging applied",
  ];
  let previousEnd = Date.parse(job.started_at);
  let previousNumber = 0;
  for (const name of names) {
    const found = job.steps.filter((step) => step.name === name);
    if (found.length !== 1) return null;
    const [step] = found;
    if (
      step.status !== "completed" ||
      step.conclusion !== "success" ||
      !Number.isSafeInteger(step.number) ||
      step.number <= previousNumber ||
      !isInstant(step.started_at) ||
      !isInstant(step.completed_at) ||
      Date.parse(step.started_at) < previousEnd ||
      Date.parse(step.completed_at) < Date.parse(step.started_at) ||
      Date.parse(step.completed_at) > Date.parse(job.completed_at)
    )
      return null;
    previousEnd = Date.parse(step.completed_at);
    previousNumber = step.number;
  }
  return generation.runId;
}

async function readIssue(gh, issue, query) {
  const body = json(
    await gh([
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      "owner=chase-sets",
      "-f",
      "name=chase-sets",
      "-F",
      `number=${issue}`,
    ]),
  );
  if (body.errors?.length || !body?.data?.repository?.issue) throw new Error("issue-unreadable");
  return body.data.repository.issue;
}

/** Closing PRs take precedence; a manual closeout needs its explicitly reviewed implementation merge into main. */
async function requiredMerge(gh, issue, deployedHead) {
  const absent = { issue, pullRequest: null, mergeCommit: null, contained: false };
  const record = await readIssue(gh, issue, closingMergesQuery);
  if (record.state !== "CLOSED") return absent;
  const closing = record.closedByPullRequestsReferences;
  if (!Array.isArray(closing?.nodes) || closing.pageInfo?.hasNextPage !== false)
    throw new Error("closing-merge-unreadable");
  const isMerged = (node) => node?.merged === true && commitSha.test(node?.mergeCommit?.oid ?? "");
  const manualCloseout = closing.nodes.length === 0;
  let merged = closing.nodes.filter(isMerged);
  if (manualCloseout) {
    const number = manualCloseoutPullRequests.get(issue);
    if (!number) return absent;
    const pr = json(await retryGitHubGet(() => gh([`repos/${repository}/pulls/${number}`])));
    if (
      pr?.number !== number ||
      pr.merged !== true ||
      pr.base?.ref !== "main" ||
      pr.base?.repo?.full_name !== repository ||
      !commitSha.test(pr.merge_commit_sha ?? "")
    )
      return absent;
    merged = [{ number, mergeCommit: { oid: pr.merge_commit_sha } }];
  }
  if (merged.length !== 1) return absent;
  const [{ number, mergeCommit }] = merged;
  const { status } = json(
    await retryGitHubGet(() => gh([`repos/${repository}/compare/${mergeCommit.oid}...${deployedHead}?per_page=1`])),
  );
  if (manualCloseout && !["ahead", "identical", "behind", "diverged"].includes(status))
    throw new Error("mapped-merge-comparison-unreadable");
  return {
    issue,
    pullRequest: number,
    mergeCommit: mergeCommit.oid,
    contained: status === "ahead" || status === "identical",
  };
}

/**
 * Binds the drill to `run` and `commit`, read immediately before launch. Returns `{binding}` or `{stop}`; the
 * pairing run's floor comes from staging sign-in's deployed authority (`readReceiptFloor`), and without one it stops.
 */
export async function readConnectorDrillDeployBinding(
  { run, commit, requiredIssues, requireReceiptFloor },
  {
    gh = ghApi,
    selectGeneration = selectStagingDeployGeneration,
    readReceiptFloor = async () => null,
    now = () => new Date().toISOString(),
  } = {},
) {
  if (
    !decimalId.test(run ?? "") ||
    !commitSha.test(commit ?? "") ||
    !Array.isArray(requiredIssues) ||
    requiredIssues.length === 0 ||
    !requiredIssues.every((issue) => Number.isSafeInteger(issue) && issue > 0)
  )
    return { stop: "deploy-binding-input-invalid" };
  let selection;
  let attemptFailure;
  let selectionFailure;
  try {
    selection = await selectGeneration({
      token: "gh-api",
      transport: ghApiTransport(gh, (failure) => {
        attemptFailure = failure;
      }),
      requestTimeoutMs,
      now: now(),
      maxAgeSeconds,
      // Each retry gets the same reader and CLI deadline; no failed read can supply authority.
      readGitHub: async (phase, request) => {
        try {
          return await retryGitHubGet(async () => {
            attemptFailure = undefined;
            try {
              return await request();
            } catch {
              throw attemptFailure ?? new GhApiFailure("response-unreadable");
            }
          });
        } catch (error) {
          selectionFailure = withReadFailure("github-request-failed", phase, error);
          throw error;
        }
      },
    });
  } catch {
    return { stop: "deploy-generation-unavailable" };
  }
  if (selection.stop !== null)
    return selection.stop === "github-request-failed" && selectionFailure ? selectionFailure : { stop: selection.stop };
  const generation = selection.deployGeneration;
  if (generation.runId !== run) return { stop: "deploy-run-not-newest" };
  if (generation.deployedHead !== commit) return { stop: "deploy-commit-mismatch" };
  const requiredMerges = [];
  for (const issue of requiredIssues) {
    try {
      requiredMerges.push(await requiredMerge(gh, issue, generation.deployedHead));
    } catch (error) {
      return withReadFailure("required-merge-unreadable", "required-merges", error);
    }
  }
  let receiptFloorRunId = null;
  if (requireReceiptFloor) {
    try {
      receiptFloorRunId = await readReceiptFloor({ generation, requiredMerges });
    } catch (error) {
      return withReadFailure("receipt-floor-unavailable", "receipt-floor", error);
    }
    if (typeof receiptFloorRunId !== "string" || !decimalId.test(receiptFloorRunId))
      return { stop: "receipt-floor-unavailable" };
    if (BigInt(receiptFloorRunId) > BigInt(generation.runId)) return { stop: "receipt-floor-newer-than-deploy" };
  }
  return {
    binding: {
      runId: generation.runId,
      runAttempt: generation.runAttempt,
      jobId: generation.jobId,
      jobCompletedAt: generation.jobCompletedAt,
      deployedHead: generation.deployedHead,
      requiredMerges,
      receiptFloorRunId,
    },
  };
}
