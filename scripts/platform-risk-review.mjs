import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { classifyRisk } from "./lib/risk-policy-v1.mjs";

export const COMMENT_MARKER = "<!-- chase-sets:risk-review:v1 -->";
const API_VERSION = "2022-11-28";
const REVIEW_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);
const USER_TYPES = new Set(["User", "Bot"]);
const HEX_SHA = /^[a-f0-9]{40}$/;
const MAX_PULL_REQUEST_FILES = 3_000;

export class RiskReviewBoundaryError extends Error {
  constructor(code) {
    super(code);
    this.name = "RiskReviewBoundaryError";
    this.code = code;
  }
}

function fail(code) {
  throw new RiskReviewBoundaryError(code);
}

function assertObject(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function assertClosed(value, keys, code) {
  assertObject(value, code);
  if (Object.keys(value).some((key) => !keys.includes(key))) fail(code);
  return value;
}

function assertString(value, code, { empty = false } = {}) {
  if (typeof value !== "string" || (!empty && value.length === 0)) fail(code);
  return value;
}

function assertSha(value, code) {
  if (!HEX_SHA.test(assertString(value, code).toLowerCase())) fail(code);
  return value.toLowerCase();
}

function assertGithubName(value, code) {
  const name = assertString(value, code).toLowerCase();
  if (name.length > 100 || !/^[a-z0-9-]+(?:\[bot\])?$/.test(name)) fail(code);
  return name;
}

export function validateEligibilityConfig(value) {
  assertClosed(value, ["schemaVersion", "mode", "eligiblePrincipals", "eligibleTeams"], "eligibility-schema");
  if (value.schemaVersion !== "risk-review-eligibility/v1" || value.mode !== "advisory") {
    fail("eligibility-version-or-mode");
  }
  if (!Array.isArray(value.eligiblePrincipals) || !Array.isArray(value.eligibleTeams)) fail("eligibility-schema");
  const eligiblePrincipals = value.eligiblePrincipals.map((entry) => {
    assertClosed(entry, ["login", "allowBot"], "eligibility-principal-schema");
    if (typeof entry.allowBot !== "boolean") fail("eligibility-principal-schema");
    return { login: assertGithubName(entry.login, "eligibility-principal-schema"), allowBot: entry.allowBot };
  });
  const eligibleTeams = value.eligibleTeams.map((entry) => {
    assertClosed(entry, ["organization", "slug"], "eligibility-team-schema");
    return {
      organization: assertGithubName(entry.organization, "eligibility-team-schema"),
      slug: assertGithubName(entry.slug, "eligibility-team-schema"),
    };
  });
  if (new Set(eligiblePrincipals.map((entry) => entry.login)).size !== eligiblePrincipals.length) {
    fail("eligibility-principal-duplicate");
  }
  if (new Set(eligibleTeams.map((entry) => `${entry.organization}/${entry.slug}`)).size !== eligibleTeams.length) {
    fail("eligibility-team-duplicate");
  }
  return { schemaVersion: value.schemaVersion, mode: value.mode, eligiblePrincipals, eligibleTeams };
}

export function projectPullRequest(value) {
  const raw = assertObject(value, "pull-request-shape");
  const user = assertObject(raw.user, "pull-request-user-shape");
  const head = assertObject(raw.head, "pull-request-head-shape");
  const base = assertObject(raw.base, "pull-request-base-shape");
  if (
    !Number.isInteger(raw.number) ||
    raw.number < 1 ||
    (raw.changed_files != null && (!Number.isInteger(raw.changed_files) || raw.changed_files < 0)) ||
    !Array.isArray(raw.labels)
  ) {
    fail("pull-request-shape");
  }
  return assertClosed(
    {
      number: raw.number,
      state: assertString(raw.state, "pull-request-state"),
      author: assertGithubName(user.login, "pull-request-user-shape"),
      headSha: assertSha(head.sha, "pull-request-head-shape"),
      baseRef: assertString(base.ref, "pull-request-base-shape"),
      mergeCommitSha: raw.merge_commit_sha == null ? null : assertSha(raw.merge_commit_sha, "pull-request-merge-shape"),
      changedFilesCount: raw.changed_files ?? null,
      labels: raw.labels.map((label) =>
        assertString(assertObject(label, "pull-request-label-shape").name, "pull-request-label-shape"),
      ),
    },
    ["number", "state", "author", "headSha", "baseRef", "mergeCommitSha", "changedFilesCount", "labels"],
    "pull-request-projection",
  );
}

export function projectChangedFile(value) {
  const raw = assertObject(value, "file-shape");
  const numeric = {};
  for (const key of ["additions", "deletions", "changes"]) {
    if (!Number.isInteger(raw[key]) || raw[key] < 0) fail("file-metadata-shape");
    numeric[key] = raw[key];
  }
  return assertClosed(
    {
      filename: assertString(raw.filename, "file-path-shape"),
      status: assertString(raw.status, "file-status-shape"),
      previousFilename:
        raw.previous_filename == null ? null : assertString(raw.previous_filename, "file-previous-path-shape"),
      ...numeric,
      patch: raw.patch == null ? null : assertString(raw.patch, "file-patch-shape", { empty: true }),
    },
    ["filename", "status", "previousFilename", "additions", "deletions", "changes", "patch"],
    "file-projection",
  );
}

export function projectReview(value) {
  const raw = assertObject(value, "review-shape");
  const user = assertObject(raw.user, "review-user-shape");
  if (!Number.isInteger(raw.id) || raw.id < 1 || !REVIEW_STATES.has(raw.state) || !USER_TYPES.has(user.type)) {
    fail("review-shape");
  }
  return assertClosed(
    {
      id: raw.id,
      actor: assertGithubName(user.login, "review-user-shape"),
      actorType: user.type,
      state: raw.state,
      commitId: raw.commit_id == null ? null : assertSha(raw.commit_id, "review-commit-shape"),
      submittedAt: raw.submitted_at == null ? null : assertString(raw.submitted_at, "review-submission-shape"),
    },
    ["id", "actor", "actorType", "state", "commitId", "submittedAt"],
    "review-projection",
  );
}

function validateReviewProjection(review, index) {
  assertClosed(review, ["id", "actor", "actorType", "state", "commitId", "submittedAt"], `review-${index}`);
  if (
    !Number.isInteger(review.id) ||
    review.id < 1 ||
    !USER_TYPES.has(review.actorType) ||
    !REVIEW_STATES.has(review.state)
  ) {
    fail("review-projection-shape");
  }
  assertGithubName(review.actor, "review-projection-shape");
  if (review.commitId != null) assertSha(review.commitId, "review-projection-shape");
  if (review.submittedAt != null && Number.isNaN(Date.parse(review.submittedAt))) fail("review-projection-shape");
  return review;
}

function principalEligibility(config, actor, actorType) {
  const principal = config.eligiblePrincipals.find((entry) => entry.login === actor);
  if (!principal) return false;
  return actorType !== "Bot" || principal.allowBot;
}

export function evaluateApprovalState({ pullRequest, reviews, config, teamEligibleActors = [] }) {
  assertClosed(
    pullRequest,
    ["number", "state", "author", "headSha", "baseRef", "mergeCommitSha", "changedFilesCount", "labels"],
    "pull-request-projection",
  );
  validateEligibilityConfig(config);
  if (!Array.isArray(reviews) || !Array.isArray(teamEligibleActors)) fail("review-evaluation-shape");
  const eligibleTeamActors = new Set(teamEligibleActors.map((actor) => assertGithubName(actor, "team-actor-shape")));
  const currentHead = assertSha(pullRequest.headSha, "pull-request-projection");
  const author = assertGithubName(pullRequest.author, "pull-request-projection");
  const ordered = reviews
    .map(validateReviewProjection)
    .filter((review) => review.submittedAt != null)
    .sort(
      (left, right) =>
        Date.parse(left.submittedAt) - Date.parse(right.submittedAt) ||
        left.id - right.id ||
        left.actor.localeCompare(right.actor),
    );
  const currentHeadReviews = ordered.filter((review) => review.commitId === currentHead);
  const independent = currentHeadReviews.filter((review) => review.actor !== author);
  const eligible = independent.filter(
    (review) =>
      principalEligibility(config, review.actor, review.actorType) ||
      (review.actorType !== "Bot" && eligibleTeamActors.has(review.actor)),
  );
  const decisive = eligible.filter((review) => review.state === "APPROVED" || review.state === "CHANGES_REQUESTED");
  const latest = decisive.at(-1) ?? null;
  return {
    state: latest?.state === "APPROVED" ? "approved" : "approval-required",
    currentHead,
    latestDecision: latest?.state ?? null,
    counts: {
      total: reviews.length,
      currentHead: currentHeadReviews.length,
      independent: independent.length,
      eligible: eligible.length,
      stale: ordered.filter((review) => review.commitId !== currentHead).length,
      dismissed: ordered.filter((review) => review.state === "DISMISSED").length,
    },
    ordering: "submitted_at,id,actor",
  };
}

function nextLink(header) {
  if (!header) return null;
  const next = header
    .split(",")
    .map((part) => part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/))
    .find((match) => match?.[2] === "next");
  if (!next?.[1] || !next[1].startsWith("https://api.github.com/")) fail("api-pagination-shape");
  return next[1];
}

export function createGithubClient({ repository, token, fetchImpl = fetch }) {
  if (!/^[^/]+\/[^/]+$/.test(repository) || !token) fail("api-configuration");
  const base = `https://api.github.com/repos/${repository}`;
  async function request(urlOrPath, { method = "GET", body, allowNotFound = false } = {}) {
    let response;
    try {
      const url = urlOrPath.startsWith("https://")
        ? urlOrPath
        : urlOrPath.startsWith("/orgs/")
          ? `https://api.github.com${urlOrPath}`
          : `${base}${urlOrPath}`;
      response = await fetchImpl(url, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": API_VERSION,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      fail("api-network");
    }
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) fail(`api-http-${Number.isInteger(response.status) ? response.status : "unknown"}`);
    try {
      return { data: await response.json(), link: response.headers?.get?.("link") ?? null };
    } catch {
      fail("api-json");
    }
  }
  async function paginate(pathname) {
    const values = [];
    let next = pathname.includes("?") ? `${pathname}&per_page=100` : `${pathname}?per_page=100`;
    let pages = 0;
    while (next) {
      if (pages >= 100) fail("api-pagination-limit");
      const response = await request(next);
      if (!Array.isArray(response.data)) fail("api-pagination-shape");
      values.push(...response.data);
      next = nextLink(response.link);
      pages += 1;
    }
    return values;
  }
  return { request, paginate };
}

async function resolveTeamActors({ client, config, reviews }) {
  if (config.eligibleTeams.length === 0) return [];
  for (const team of config.eligibleTeams) {
    const teamResponse = await client.request(
      `/orgs/${encodeURIComponent(team.organization)}/teams/${encodeURIComponent(team.slug)}`,
    );
    const teamData = assertObject(teamResponse.data, "eligibility-team-api-shape");
    if (
      teamData.slug?.toLowerCase() !== team.slug ||
      teamData.organization?.login?.toLowerCase() !== team.organization
    ) {
      fail("eligibility-team-api-shape");
    }
  }
  const actors = [...new Set(reviews.map((review) => review.actor))];
  const eligible = [];
  for (const actor of actors) {
    for (const team of config.eligibleTeams) {
      const response = await client.request(
        `/orgs/${encodeURIComponent(team.organization)}/teams/${encodeURIComponent(team.slug)}/memberships/${encodeURIComponent(actor)}`,
        { allowNotFound: true },
      );
      if (response) {
        const membership = assertObject(response.data, "eligibility-membership-api-shape");
        if (!new Set(["active", "pending"]).has(membership.state)) fail("eligibility-membership-api-shape");
      }
      if (response?.data?.state === "active") {
        eligible.push(actor);
        break;
      }
    }
  }
  return eligible;
}

function unknownPullRequestResult({ pullRequest, files, code }) {
  const pathsScanned = files.reduce((count, file) => count + 1 + Number(file.previousFilename != null), 0);
  return {
    pullRequest,
    classification: {
      schemaVersion: "risk-policy/v1",
      classification: "unknown",
      categories: [],
      reasons: [],
      findings: [],
      scan: {
        filesScanned: files.length,
        filesTotal: pullRequest.changedFilesCount,
        pathsScanned,
        uniquePathsScanned: new Set(files.flatMap((file) => [file.filename, file.previousFilename].filter(Boolean)))
          .size,
        totalSurface: (pullRequest.changedFilesCount ?? files.length) + pullRequest.labels.length,
        complete: false,
      },
    },
    approval: { state: "not-evaluated" },
    advisoryState: "unknown",
    code,
  };
}

export async function evaluatePullRequest({ client, pullRequestNumber, config }) {
  const pullRequest = projectPullRequest((await client.request(`/pulls/${pullRequestNumber}`)).data);
  let files = [];
  try {
    if (!Number.isInteger(pullRequest.changedFilesCount)) fail("pull-request-files-count-shape");
    files = (await client.paginate(`/pulls/${pullRequest.number}/files`)).map(projectChangedFile);
    if (pullRequest.changedFilesCount >= MAX_PULL_REQUEST_FILES || files.length !== pullRequest.changedFilesCount) {
      fail("api-files-truncated");
    }
    const risk = classifyRisk({ changedFiles: files, labels: pullRequest.labels });
    const classification = {
      ...risk,
      scan: {
        ...risk.scan,
        filesTotal: pullRequest.changedFilesCount,
        complete: true,
      },
    };
    if (classification.classification === "low") {
      return { pullRequest, classification, approval: { state: "not-required" }, advisoryState: "low-risk" };
    }
    if (config.eligiblePrincipals.length === 0 && config.eligibleTeams.length === 0) {
      return {
        pullRequest,
        classification,
        approval: { state: "configuration-required" },
        advisoryState: "configuration-required",
      };
    }
    const reviews = (await client.paginate(`/pulls/${pullRequest.number}/reviews`)).map(projectReview);
    const teamEligibleActors = await resolveTeamActors({ client, config, reviews });
    const approval = evaluateApprovalState({ pullRequest, reviews, config, teamEligibleActors });
    return {
      pullRequest,
      classification,
      approval,
      advisoryState: approval.state === "approved" ? "approved" : "approval-required",
    };
  } catch (error) {
    return unknownPullRequestResult({
      pullRequest,
      files,
      code: error instanceof RiskReviewBoundaryError ? error.code : "internal-failure",
    });
  }
}

export async function resolveMergeGroupPullRequests({ client, mergeGroup }) {
  assertClosed(mergeGroup, ["headSha", "baseSha", "baseRef"], "merge-group-projection");
  const headSha = assertSha(mergeGroup.headSha, "merge-group-projection");
  assertSha(mergeGroup.baseSha, "merge-group-projection");
  const baseRef = assertString(mergeGroup.baseRef, "merge-group-projection").replace(/^refs\/heads\//, "");
  const associated = (await client.paginate(`/commits/${headSha}/pulls`)).map(projectPullRequest);
  const exact = associated.filter((pr) => pr.mergeCommitSha === headSha && pr.baseRef === baseRef);
  const compare = (await client.request(`/compare/${mergeGroup.baseSha}...${headSha}`)).data;
  if (!Number.isInteger(compare?.total_commits) || !Array.isArray(compare?.commits)) fail("merge-group-compare-shape");
  if (compare.total_commits !== compare.commits.length) fail("merge-group-compare-incomplete");
  const numbers = exact.map((pr) => pr.number);
  for (const commit of compare.commits) {
    const sha = assertSha(assertObject(commit, "merge-group-commit-shape").sha, "merge-group-commit-shape");
    const prs = (await client.paginate(`/commits/${sha}/pulls`)).map(projectPullRequest);
    numbers.push(...prs.filter((pr) => pr.headSha === sha && pr.baseRef === baseRef).map((pr) => pr.number));
  }
  const isolated = [...new Set(numbers)].sort((a, b) => a - b);
  if (isolated.length === 0) fail("merge-group-constituents-missing");
  return isolated;
}

export function renderComment(result) {
  const categories = result.classification.categories.length > 0 ? result.classification.categories.join(", ") : "none";
  const paths = result.classification.findings
    .map((finding) => finding.path)
    .filter(Boolean)
    .slice(0, 10)
    .map(
      (value) =>
        `- \`${String(value)
          .replace(/[\u0000-\u001f\u007f`]/g, " ")
          .slice(0, 200)}\``,
    )
    .join("\n");
  return [
    COMMENT_MARKER,
    "### Risk Review — advisory",
    "",
    `Classification: **${result.classification.classification}${result.classification.classification === "unknown" ? "" : "-risk"}**  `,
    `Evaluation: **${result.advisoryState}**  `,
    `Head: \`${result.pullRequest?.headSha ?? "unavailable"}\`  `,
    ...(result.code ? [`Safe code: \`${result.code}\`  `] : []),
    `Categories: ${categories}  `,
    `Scanned: ${result.classification.scan.filesScanned}/${result.classification.scan.filesTotal ?? result.classification.scan.filesScanned} files (complete: ${result.classification.scan.complete ?? "unknown"}); ${result.classification.scan.pathsScanned}/${result.classification.scan.totalSurface} path/label surfaces.`,
    "",
    paths || "No high-risk paths detected.",
    "",
    "This is advisory only. It does not affect `PR Required` or the live main ruleset.",
  ].join("\n");
}

export async function upsertStableComment({ client, pullRequestNumber, body, createWhenMissing }) {
  const comments = await client.paginate(`/issues/${pullRequestNumber}/comments`);
  const existing = comments
    .filter(
      (comment) =>
        Number.isInteger(comment?.id) &&
        comment.user?.login === "github-actions[bot]" &&
        comment.user?.type === "Bot" &&
        typeof comment.body === "string" &&
        comment.body.includes(COMMENT_MARKER),
    )
    .sort((left, right) => left.id - right.id)[0];
  if (existing) {
    if (!Number.isInteger(existing.id)) fail("comment-shape");
    await client.request(`/issues/comments/${existing.id}`, { method: "PATCH", body: { body } });
    return "updated";
  }
  if (!createWhenMissing) return "absent";
  await client.request(`/issues/${pullRequestNumber}/comments`, { method: "POST", body: { body } });
  return "created";
}

export async function runRiskReview({ event, repository, token, config, fetchImpl = fetch }) {
  const client = createGithubClient({ repository, token, fetchImpl });
  let pullRequestNumbers;
  if (event.eventName === "merge_group") {
    pullRequestNumbers = await resolveMergeGroupPullRequests({ client, mergeGroup: event.mergeGroup });
  } else {
    pullRequestNumbers = [event.pullRequestNumber];
  }
  const results = [];
  for (const number of pullRequestNumbers) {
    if (!Number.isInteger(number) || number < 1) fail("event-pull-request-number");
    const result = await evaluatePullRequest({ client, pullRequestNumber: number, config });
    const comment = await upsertStableComment({
      client,
      pullRequestNumber: number,
      body: renderComment(result),
      createWhenMissing: result.classification.classification === "high" || result.advisoryState === "unknown",
    });
    results.push({ ...result, comment });
  }
  return { schemaVersion: "risk-review-evaluation/v1", mode: "advisory", eventName: event.eventName, results };
}

export function projectEvent(eventName, payload, dispatchPullRequestNumber) {
  const raw = assertObject(payload, "event-shape");
  if (eventName === "merge_group") {
    const mergeGroup = assertObject(raw.merge_group, "merge-group-event-shape");
    return {
      eventName,
      mergeGroup: {
        headSha: assertSha(mergeGroup.head_sha, "merge-group-event-shape"),
        baseSha: assertSha(mergeGroup.base_sha, "merge-group-event-shape"),
        baseRef: assertString(mergeGroup.base_ref, "merge-group-event-shape"),
      },
    };
  }
  if (eventName === "workflow_dispatch") {
    const number = Number.parseInt(dispatchPullRequestNumber ?? "", 10);
    if (!Number.isInteger(number) || number < 1) fail("dispatch-pull-request-number");
    return { eventName, pullRequestNumber: number };
  }
  const pullRequest = assertObject(raw.pull_request, "pull-request-event-shape");
  if (!Number.isInteger(pullRequest.number) || pullRequest.number < 1) fail("pull-request-event-shape");
  return { eventName, pullRequestNumber: pullRequest.number };
}

export function summaryMarkdown(record) {
  if (record.status === "unknown") {
    return `## Risk Review — advisory\n\nEvaluation state: **unknown** (safe code: \`${record.code}\`).\n\nThis advisory workflow remains non-enforcing.`;
  }
  return [
    "## Risk Review — advisory",
    "",
    ...record.results.map(
      (result) =>
        `- PR #${result.pullRequest.number}: ${result.classification.classification}${result.classification.classification === "unknown" ? "" : "-risk"} / ${result.advisoryState}${result.code ? ` (safe code: \`${result.code}\`)` : ""}; scanned ${result.classification.scan.pathsScanned}/${result.classification.scan.totalSurface} surfaces.`,
    ),
    "",
    "`Risk Review` is not required by the live ruleset and does not feed `PR Required` during calibration.",
  ].join("\n");
}

async function main() {
  let record;
  try {
    const [payload, configValue] = await Promise.all([
      readFile(process.env.GITHUB_EVENT_PATH, "utf8").then(JSON.parse),
      readFile(new URL("./risk-review-eligibility-v1.json", import.meta.url), "utf8").then(JSON.parse),
    ]);
    const config = validateEligibilityConfig(configValue);
    const event = projectEvent(process.env.GITHUB_EVENT_NAME, payload, process.env.RISK_REVIEW_PULL_REQUEST);
    record = await runRiskReview({
      event,
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
      config,
    });
  } catch (error) {
    record = {
      schemaVersion: "risk-review-evaluation/v1",
      mode: "advisory",
      status: "unknown",
      code: error instanceof RiskReviewBoundaryError ? error.code : "internal-failure",
      results: [],
    };
  }
  const output = JSON.stringify(record, null, 2);
  if (process.env.RISK_REVIEW_OUTPUT) await writeFile(process.env.RISK_REVIEW_OUTPUT, `${output}\n`, "utf8");
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summaryMarkdown(record)}\n`, "utf8");
  console.log(output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
