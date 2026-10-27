// Delivery-owned deploy authority for the connector pairing drill, and the only drill code that reads
// GitHub Actions. The owning Deploy Staging job comes from the shared staging deploy generation (newest applied
// job; a newer unfinished or indeterminate deploy, a skipped or incomplete listing refuses), the requested run and
// commit must be that job's, and each required issue's closing-PR merge commit is compared with its deployed head.
// Every read is `gh api`, read-only; the product drill receives only the result.
import { execFile } from "node:child_process";
import { selectStagingDeployGeneration } from "./staging-deploy-generation.mjs";

const repository = "chase-sets/chase-sets";
const apiOrigin = "https://api.github.com";
const maxAgeSeconds = 604_800;
const requestTimeoutMs = 30_000;
const decimalId = /^[1-9]\d{0,19}$/;
const commitSha = /^[a-f0-9]{40}$/;
const closingMergesQuery =
  "query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number merged mergeCommit { oid } } } } } }";

/** One read-only `gh api` call; its stdout, or a value-free refusal. */
export function ghApi(args, { run = execFile } = {}) {
  return new Promise((resolve, reject) => {
    run(
      "gh",
      ["api", ...args],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024, timeout: requestTimeoutMs, windowsHide: true },
      (error, stdout) => (error ? reject(new Error("gh-api-refused")) : resolve(stdout)),
    );
  });
}

/**
 * A `fetch`-shaped transport for the shared GitHub reader. GitHub REST paths go through `gh api`, which holds its
 * own credential (the reader's bearer header is never sent); any other URL is refused unsent.
 */
export function ghApiTransport(gh = ghApi) {
  return async (url, init = {}) => {
    const target = new URL(url);
    if (target.origin !== apiOrigin) return new Response(null, { status: 599 });
    try {
      const body = await gh([
        "-H",
        `Accept: ${init.headers?.accept ?? "application/vnd.github+json"}`,
        `${target.pathname.slice(1)}${target.search}`,
      ]);
      return new Response(body, { status: 200 });
    } catch {
      return new Response(null, { status: 502 });
    }
  };
}

const json = (bytes) => JSON.parse(Buffer.from(bytes).toString("utf8"));

/** The closing-PR merge of one issue, compared with the deployed head; ambiguity or absence is not contained. */
async function requiredMerge(gh, issue, deployedHead) {
  const body = json(
    await gh([
      "graphql",
      "-f",
      `query=${closingMergesQuery}`,
      "-f",
      "owner=chase-sets",
      "-f",
      "name=chase-sets",
      "-F",
      `number=${issue}`,
    ]),
  );
  const nodes = body?.data?.repository?.issue?.closedByPullRequestsReferences?.nodes;
  if (!Array.isArray(nodes)) throw new Error("closing-merge-unreadable");
  const merged = nodes.filter((node) => node?.merged === true && commitSha.test(node?.mergeCommit?.oid ?? ""));
  if (merged.length !== 1) return { issue, pullRequest: null, mergeCommit: null, contained: false };
  const [{ number, mergeCommit }] = merged;
  const { status } = json(await gh([`repos/${repository}/compare/${mergeCommit.oid}...${deployedHead}?per_page=1`]));
  return {
    issue,
    pullRequest: number,
    mergeCommit: mergeCommit.oid,
    contained: status === "ahead" || status === "identical",
  };
}

/**
 * Binds the drill to `run` and `commit`, read immediately before launch. Returns `{binding}` or `{stop}`; the
 * pairing run's floor comes from staging sign-in's deployed receipt (`readReceiptFloor`), and without one it stops.
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
  try {
    selection = await selectGeneration({
      token: "gh-api",
      transport: ghApiTransport(gh),
      requestTimeoutMs,
      now: now(),
      maxAgeSeconds,
    });
  } catch {
    return { stop: "deploy-generation-unavailable" };
  }
  if (selection.stop !== null) return { stop: selection.stop };
  const generation = selection.deployGeneration;
  if (generation.runId !== run) return { stop: "deploy-run-not-newest" };
  if (generation.deployedHead !== commit) return { stop: "deploy-commit-mismatch" };
  const requiredMerges = [];
  for (const issue of requiredIssues) {
    try {
      requiredMerges.push(await requiredMerge(gh, issue, generation.deployedHead));
    } catch {
      return { stop: "required-merge-unreadable" };
    }
  }
  let receiptFloorRunId = null;
  if (requireReceiptFloor) {
    receiptFloorRunId = await readReceiptFloor().catch(() => null);
    if (typeof receiptFloorRunId !== "string" || !decimalId.test(receiptFloorRunId))
      return { stop: "receipt-floor-unavailable" };
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
