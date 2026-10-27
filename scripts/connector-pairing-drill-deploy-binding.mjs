import { execFileSync } from "node:child_process";

function ghJson(path) {
  return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}

/**
 * Delivery tooling owns GitHub Actions authority. Product E2E receives this
 * result through its command port and refuses when any exact job/run fact is
 * absent, stale, skipped or superseded.
 */
export function readDeployBinding(run, commit) {
  const selected = ghJson(`repos/chase-sets/chase-sets/actions/runs/${encodeURIComponent(run)}`);
  const jobs = ghJson(`repos/chase-sets/chase-sets/actions/runs/${encodeURIComponent(run)}/jobs?per_page=100`);
  const deploy = jobs.jobs?.find((job) => job.name?.toLowerCase().includes("deploy staging"));
  if (
    selected.head_sha !== commit ||
    selected.status !== "completed" ||
    selected.conclusion !== "success" ||
    !deploy ||
    deploy.status !== "completed" ||
    deploy.conclusion !== "success"
  )
    return { state: "completed", skipped: false, superseded: true, requiredMerges: [] };
  const runs = ghJson("repos/chase-sets/chase-sets/actions/runs?per_page=100");
  const selectedCreated = Date.parse(selected.created_at ?? "");
  const superseded = (runs.workflow_runs ?? []).some((candidate) => {
    if (
      candidate.id === Number(run) ||
      !candidate.name?.toLowerCase().includes("deploy staging") ||
      !candidate.created_at ||
      Date.parse(candidate.created_at) <= selectedCreated
    )
      return false;
    return (
      candidate.status === "in_progress" ||
      (candidate.status === "completed" && candidate.conclusion === "success" && candidate.head_sha !== commit)
    );
  });
  if (superseded) return { state: "completed", skipped: false, superseded: true, requiredMerges: [] };
  const pulls = ghJson(`repos/chase-sets/chase-sets/commits/${encodeURIComponent(commit)}/pulls`);
  return {
    state: "completed",
    skipped: false,
    superseded: false,
    requiredMerges: (pulls ?? []).flatMap((pull) => (typeof pull.number === "number" ? [pull.number] : [])),
  };
}
