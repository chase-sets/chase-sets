import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { classifyPrScope } from "./lib/pr-scope-policy-v1.mjs";
import {
  RiskReviewBoundaryError as GithubBoundaryError,
  MAX_PULL_REQUEST_FILES,
  createGithubClient,
  projectChangedFile,
  projectEvent,
  projectPullRequest,
  resolveMergeGroupPullRequests,
  upsertStableComment,
} from "./platform-risk-review.mjs";

export const COMMENT_MARKER = "<!-- chase-sets:pr-scope:v1 -->";
export const PR_SCOPE_ROLLOUT_PATH = new URL("./pr-scope-rollout-v1.json", import.meta.url);
export const FULL_BATTERY_LABEL = "full-ci";
const BOT_LOGIN = "github-actions[bot]";
const RATIONALE_HEADING = /^##\s+Large-change rationale\s*$/m;

function fail(code) {
  throw new GithubBoundaryError(code);
}

export function validateRolloutConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("rollout-schema");
  const allowedKeys = ["schemaVersion", "mode", "mechanicalMigrationEscapeLabel"];
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) fail("rollout-schema");
  if (value.schemaVersion !== "pr-scope-rollout/v1") fail("rollout-schema");
  if (value.mode !== "advisory" && value.mode !== "enforcing") fail("rollout-schema");
  if (typeof value.mechanicalMigrationEscapeLabel !== "string" || value.mechanicalMigrationEscapeLabel.length === 0) {
    fail("rollout-schema");
  }
  return {
    schemaVersion: value.schemaVersion,
    mode: value.mode,
    mechanicalMigrationEscapeLabel: value.mechanicalMigrationEscapeLabel,
  };
}

// The rationale section must have non-empty content before the next H2 (or
// end of body); a bare heading with nothing under it does not count.
export function hasLargeChangeRationale(body) {
  if (typeof body !== "string") return false;
  const headingIndex = body.search(RATIONALE_HEADING);
  if (headingIndex === -1) return false;
  const lines = body.slice(headingIndex).split("\n").slice(1);
  const content = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) break;
    content.push(line);
  }
  return content.join("\n").trim().length > 0;
}

function unknownScopeResult({ pullRequest, files, code }) {
  return {
    pullRequest,
    scope: {
      schemaVersion: "pr-scope-policy/v1",
      status: "unknown",
      raw: null,
      normalized: null,
      excluded: null,
      boundedContexts: [],
      compositionRoots: [],
      risk: null,
      splitSuggestion: null,
      scan: { filesScanned: files.length, filesTotal: pullRequest.changedFilesCount, complete: false },
    },
    mechanicalMigrationEscape: false,
    requiresRationale: false,
    rationalePresent: false,
    code,
  };
}

export async function evaluatePrScope({ client, pullRequestNumber, rollout }) {
  const raw = (await client.request(`/pulls/${pullRequestNumber}`)).data;
  const pullRequest = projectPullRequest(raw);
  const body = typeof raw?.body === "string" ? raw.body : "";
  let files = [];
  try {
    if (!Number.isInteger(pullRequest.changedFilesCount)) fail("pull-request-files-count-shape");
    files = (await client.paginate(`/pulls/${pullRequest.number}/files`)).map(projectChangedFile);
    if (pullRequest.changedFilesCount >= MAX_PULL_REQUEST_FILES || files.length !== pullRequest.changedFilesCount) {
      fail("api-files-truncated");
    }
    // Pagination can straddle a synchronize: re-read authority immediately
    // after collecting files and before any comment/label mutation. Any
    // movement in head SHA or changed-file count means the collected files
    // are stale/mixed and must never be published as a current-looking
    // scope; fail closed to unknown instead.
    const reread = projectPullRequest((await client.request(`/pulls/${pullRequest.number}`)).data);
    if (reread.headSha !== pullRequest.headSha || reread.changedFilesCount !== pullRequest.changedFilesCount) {
      fail("pull-request-head-moved");
    }
    const scope = classifyPrScope({ changedFiles: files, labels: pullRequest.labels });
    const mechanicalMigrationEscape = pullRequest.labels
      .map((label) => label.toLowerCase())
      .includes(rollout.mechanicalMigrationEscapeLabel.toLowerCase());
    // Rationale/escape are enforcement semantics: they must stay inactive
    // while the rollout is advisory so an advisory-mode result never reports
    // an enforcing-looking "requires rationale" state.
    const requiresRationale = rollout.mode === "enforcing" && scope.status === "large" && !mechanicalMigrationEscape;
    return {
      pullRequest,
      scope: {
        ...scope,
        scan: { filesScanned: files.length, filesTotal: pullRequest.changedFilesCount, complete: true },
      },
      mechanicalMigrationEscape,
      requiresRationale,
      rationalePresent: hasLargeChangeRationale(body),
      code: null,
    };
  } catch (error) {
    return unknownScopeResult({
      pullRequest,
      files,
      code: error instanceof GithubBoundaryError ? error.code : "internal-failure",
    });
  }
}

async function labelWasLastAddedByBot({ client, pullRequestNumber, label }) {
  const events = await client.paginate(`/issues/${pullRequestNumber}/events`);
  const labelEvents = events
    .filter(
      (event) =>
        (event?.event === "labeled" || event?.event === "unlabeled") &&
        event?.label?.name?.toLowerCase() === label.toLowerCase(),
    )
    .sort((left, right) => Date.parse(left.created_at ?? 0) - Date.parse(right.created_at ?? 0));
  const latest = labelEvents.at(-1);
  return latest?.event === "labeled" && latest?.actor?.login === BOT_LOGIN && latest?.actor?.type === "Bot";
}

// Only ever mutates the pre-existing `full-ci` full-battery trigger, and only
// ever removes it when this automation's own prior "labeled" event is the
// most recent one for that label — a human-applied full-ci label for an
// unrelated reason is never touched.
export async function reconcileFullBatteryLabel({ client, pullRequestNumber, currentLabels, wantsLarge }) {
  const hasLabel = currentLabels.some((label) => label.toLowerCase() === FULL_BATTERY_LABEL);
  if (wantsLarge && !hasLabel) {
    await client.request(`/issues/${pullRequestNumber}/labels`, {
      method: "POST",
      body: { labels: [FULL_BATTERY_LABEL] },
    });
    return "added";
  }
  if (!wantsLarge && hasLabel) {
    const addedByBot = await labelWasLastAddedByBot({ client, pullRequestNumber, label: FULL_BATTERY_LABEL });
    if (!addedByBot) return "kept-manual";
    await client.request(`/issues/${pullRequestNumber}/labels/${encodeURIComponent(FULL_BATTERY_LABEL)}`, {
      method: "DELETE",
    });
    return "removed";
  }
  return "unchanged";
}

function formatLines(value) {
  return value == null ? "unknown" : String(value);
}

export function renderPrScopeComment(result) {
  const { scope } = result;
  if (scope.status === "unknown") {
    return [
      COMMENT_MARKER,
      "### PR Scope — advisory",
      "",
      `Evaluation state: **unknown** (safe code: \`${result.code}\`).`,
      "",
      `Head: \`${result.pullRequest?.headSha ?? "unavailable"}\`  `,
      `Scanned: ${scope.scan.filesScanned}/${scope.scan.filesTotal ?? scope.scan.filesScanned} files (complete: ${scope.scan.complete}).`,
      "",
      "This is advisory only. It does not affect `PR Required` or the live main ruleset.",
    ].join("\n");
  }
  const excludedRows = Object.entries(scope.excluded.totals)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([reason, totals]) => `- \`${reason}\`: ${totals.files} file(s), ${totals.additions + totals.deletions} line(s)`,
    );
  return [
    COMMENT_MARKER,
    "### PR Scope — advisory",
    "",
    `Status: **${scope.status}**  `,
    `Head: \`${result.pullRequest?.headSha ?? "unavailable"}\`  `,
    `Raw: ${formatLines(scope.raw.lines)} lines / ${formatLines(scope.raw.files)} files  `,
    `Normalized: ${formatLines(scope.normalized.lines)} lines / ${formatLines(scope.normalized.files)} files  `,
    `Thresholds (\`pr-scope-policy/v1\`): advisory > ${scope.thresholds.advisory.lines} lines or ${scope.thresholds.advisory.files} files; large > ${scope.thresholds.large.lines} lines or ${scope.thresholds.large.files} files  `,
    `Bounded contexts: ${scope.boundedContexts.length > 0 ? scope.boundedContexts.join(", ") : "none"}  `,
    `Composition roots: ${scope.compositionRoots.length > 0 ? scope.compositionRoots.join(", ") : "none"}  `,
    `Risk categories: ${scope.risk.categories.length > 0 ? scope.risk.categories.join(", ") : "none"}  `,
    ...(result.mechanicalMigrationEscape
      ? [`Mechanical-migration escape: **applied** (raw size and full CI are unaffected)  `]
      : []),
    ...(scope.status === "large"
      ? [`Large-change rationale: ${result.rationalePresent ? "present" : "**missing**"}  `]
      : []),
    "",
    "Excluded mechanical totals:",
    excludedRows.length > 0 ? excludedRows.join("\n") : "- none",
    ...(scope.splitSuggestion
      ? [
          "",
          `Suggested split boundaries (${scope.splitSuggestion.reason}): ${scope.splitSuggestion.boundaries.join(", ")}`,
        ]
      : []),
    "",
    "This is advisory only. It does not affect `PR Required` or the live main ruleset.",
  ].join("\n");
}

// `mutate: false` powers the lightweight scope-policy check: it reads the
// same trusted-base metadata but never posts the advisory comment nor
// mutates the full-ci label, so the one job allowed to fail this feature's
// own check never doubles up on the advisory job's mutations.
export async function runPrScopeEvaluation({ event, repository, token, rollout, fetchImpl = fetch, mutate = true }) {
  const client = createGithubClient({ repository, token, fetchImpl });
  const pullRequestNumbers =
    event.eventName === "merge_group"
      ? await resolveMergeGroupPullRequests({ client, mergeGroup: event.mergeGroup })
      : [event.pullRequestNumber];

  const results = [];
  for (const number of pullRequestNumbers) {
    if (!Number.isInteger(number) || number < 1) fail("event-pull-request-number");
    const result = await evaluatePrScope({ client, pullRequestNumber: number, rollout });
    let comment = "not-evaluated";
    let labelAction = "not-evaluated";
    if (mutate) {
      comment = await upsertStableComment({
        client,
        pullRequestNumber: number,
        body: renderPrScopeComment(result),
        createWhenMissing: result.scope.status !== "normal",
        marker: COMMENT_MARKER,
      });
      if (rollout.mode === "enforcing" && result.scope.status !== "unknown") {
        labelAction = await reconcileFullBatteryLabel({
          client,
          pullRequestNumber: number,
          currentLabels: result.pullRequest.labels,
          wantsLarge: result.scope.status === "large",
        });
      }
    }
    results.push({ ...result, comment, labelAction });
  }
  return {
    schemaVersion: "pr-scope-evaluation/v1",
    rolloutMode: rollout.mode,
    eventName: event.eventName,
    results,
  };
}

// The lightweight scope-policy check enforces nothing during the mandated
// advisory rollout: it always exits 0 regardless of computed scope. Once an
// operator flips rollout mode to "enforcing", it fails only when a large PR
// with complete (non-unknown) scope data is missing the required rationale.
export function scopePolicyExitCode(record) {
  if (record.rolloutMode !== "enforcing") return 0;
  const blocked = record.results.some(
    (result) => result.scope.status === "large" && result.requiresRationale && !result.rationalePresent,
  );
  return blocked ? 1 : 0;
}

export function summaryMarkdown(record) {
  if (record.status === "unknown") {
    return `## PR Scope — advisory\n\nEvaluation state: **unknown** (safe code: \`${record.code}\`).\n\nThis advisory workflow remains non-enforcing.`;
  }
  return [
    "## PR Scope — advisory",
    "",
    ...record.results.map(
      (result) =>
        `- PR #${result.pullRequest.number}: ${result.scope.status}${result.code ? ` (safe code: \`${result.code}\`)` : ""}; rollout: ${record.rolloutMode}${result.labelAction && result.labelAction !== "not-evaluated" ? `; label: ${result.labelAction}` : ""}.`,
    ),
    "",
    "`PR Scope` is not required by the live ruleset and does not feed `PR Required` during calibration.",
  ].join("\n");
}

async function main() {
  let record;
  try {
    const [payload, rolloutValue] = await Promise.all([
      readFile(process.env.GITHUB_EVENT_PATH, "utf8").then(JSON.parse),
      readFile(PR_SCOPE_ROLLOUT_PATH, "utf8").then(JSON.parse),
    ]);
    const rollout = validateRolloutConfig(rolloutValue);
    const event = projectEvent(process.env.GITHUB_EVENT_NAME, payload, process.env.PR_SCOPE_PULL_REQUEST);
    record = await runPrScopeEvaluation({
      event,
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
      rollout,
      mutate: process.env.PR_SCOPE_CHECK_ONLY !== "true",
    });
  } catch (error) {
    record = {
      schemaVersion: "pr-scope-evaluation/v1",
      rolloutMode: "advisory",
      status: "unknown",
      code: error instanceof GithubBoundaryError ? error.code : "internal-failure",
      results: [],
    };
  }
  const output = JSON.stringify(record, null, 2);
  if (process.env.PR_SCOPE_OUTPUT) await writeFile(process.env.PR_SCOPE_OUTPUT, `${output}\n`, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summaryMarkdown(record)}\n`, "utf8");
  console.log(output);
  process.exitCode = scopePolicyExitCode(record);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
