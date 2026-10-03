import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOption, readRepeatedOptions } from "./lib/cli-options.mjs";
import {
  auditBrowserUsabilityRoutes,
  browserUsabilityGoal,
  browserUsabilityGoalModules,
  selectBrowserUsabilityGoals,
} from "./browser-usability-goals.mjs";

const schema = "browser-usability/v1";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const required = (value, name) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required.`);
  return value;
};

export function localOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Use a loopback HTTP origin without credentials, path, query, or fragment.");
  return url.origin;
}

function evidenceFile(directory, relative) {
  required(relative, "evidence path");
  if (path.isAbsolute(relative)) throw new Error("Evidence must be relative to its evidence directory.");
  const root = realpathSync(directory);
  const file = realpathSync(path.resolve(root, relative));
  const resolved = path.relative(root, file);
  if (resolved.startsWith("..") || path.isAbsolute(resolved)) throw new Error("Evidence escapes its directory.");
  const bytes = readFileSync(file);
  if (!bytes.length) throw new Error("Evidence must not be empty.");
  return { path: relative, sha256: digest(bytes) };
}

export function validatePreflight(preflight, { head, origin, role, now = Date.now() }) {
  if (preflight.head !== head || preflight.origin !== origin || preflight.role !== role)
    throw new Error("Preflight must match the candidate head, origin, and goal role.");
  if (preflight.environment !== "isolated-synthetic") throw new Error("Only isolated synthetic fixtures are admitted.");
  const age = now - Date.parse(preflight.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 600_000)
    throw new Error("Preflight must be observed within ten minutes.");
  for (const key of ["services", "projections", "fixture", "exclusiveSession"]) {
    if (preflight.checks?.[key]?.status !== "pass") throw new Error(`Preflight ${key} is not passing.`);
    required(preflight.checks[key].evidence, `${key} evidence`);
  }
  for (const key of ["fixtureId", "harness", "viewport", "locale", "timezone", "cachePolicy", "taskContext"])
    required(preflight[key], key);
}

export function prepareProbe({ goalId, origin, preflight, evidenceDirectory, directory, head, now = Date.now() }) {
  const goal = browserUsabilityGoal(goalId);
  origin = localOrigin(origin);
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("A full candidate commit is required.");
  validatePreflight(preflight, { head, origin, role: goal.role, now });
  const proofs = Object.fromEntries(
    Object.entries(preflight.checks).map(([key, value]) => [key, evidenceFile(evidenceDirectory, value.evidence)]),
  );
  if (existsSync(directory)) throw new Error("Use a new output directory for each attempt.");
  const manifest = {
    schema,
    runId: randomUUID(),
    preparedAt: new Date(now).toISOString(),
    head,
    goalId: goal.id,
    goalVersion: goal.version,
    goalSha256: digest(JSON.stringify(goal)),
    scenarioSha256: digest(preflight.taskContext),
    role: goal.role,
    startPath: goal.startPath,
    origin,
    startUrl: new URL(goal.startPath, origin).href,
    model: "gpt-6-luna",
    effort: "medium",
    placement: "override-Todd",
    routingRow: 6,
    mode: "screenshot-grounded-ax",
    timingVersion: 1,
    budgetMs: 360_000,
    maxActions: 35,
    fixtureId: preflight.fixtureId,
    harness: preflight.harness,
    viewport: preflight.viewport,
    locale: preflight.locale,
    timezone: preflight.timezone,
    cachePolicy: preflight.cachePolicy,
    preflight: { observedAt: preflight.observedAt, proofs },
  };
  mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, "manifest.json"), manifest);
  writeJson(path.join(directory, "preflight.json"), preflight);
  writeFileSync(
    path.join(directory, "participant.md"),
    [
      `# Browser goal: ${goal.id} v${goal.version}`,
      goal.goal,
      `Fixture task context: ${preflight.taskContext}`,
      `Starting URL: ${manifest.startUrl}`,
      `Run directory: ${path.resolve(directory)}`,
      "Use only the provided browser session wrapper for observations, actions, and finish. No source, tests, APIs, hidden DOM, other reports, or oracle data. Read only this brief; import the session helper without inspecting it.",
      "Before choosing a target, inspect the screenshot. AX may help read or activate a matching visible control; an AX-only invisible target is not a discovered control. Never guess routes. Stay on the starting origin; do not follow external links or consent to permissions.",
      "Read-only by default: no purchases, messages, reviews, reports, or account, listing, or settings changes.",
      ...(goal.permits ? [`Exception for this goal only: ${goal.permits} The moderator restores it afterwards.`] : []),
      "Never confirm a payment, buy postage, publish or sync to an external channel, send a message, or submit a password or other credential. Stop at the last screen before any of these and report what it would do.",
      "Use session.observe() after errors, and session.finish({status: 'complete'|'partial'|'blocked', answer, obstacles}). Report what remains unknown. Completion is your claim, not the independent verdict. No other file writes or agents.",
      "The code enforces a six-minute/35-action budget and saves screenshots/call timing. Do not bypass it or restart a timed-out attempt. Do not put credentials, personal data, tokens, or private URLs in the answer.",
      "",
    ].join("\n\n"),
    { flag: "wx" },
  );
  return manifest;
}

export function adjudicateProbe({ directory, evidence, evidenceDirectory }) {
  const manifestBytes = readFileSync(path.join(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  const runBytes = readFileSync(path.join(directory, "run.json"));
  const run = JSON.parse(runBytes);
  const goal = browserUsabilityGoal(manifest.goalId);
  if (
    manifest.schema !== schema ||
    run.schema !== schema ||
    run.runId !== manifest.runId ||
    goal.version !== manifest.goalVersion ||
    manifest.goalSha256 !== digest(JSON.stringify(goal)) ||
    run.manifestSha256 !== digest(manifestBytes)
  )
    throw new Error("Run/manifest/goal identity mismatch.");
  if (evidence.runId !== run.runId || evidence.head !== manifest.head || evidence.runSha256 !== digest(runBytes))
    throw new Error("Adjudication must bind the exact run bytes and candidate head.");
  required(evidence.reviewer, "independent reviewer identity");
  if (evidence.reviewer === "participant") throw new Error("The participant cannot adjudicate itself.");
  if (!["verified-complete", "partial", "incorrect", "blocked", "environment-invalid"].includes(evidence.verdict))
    throw new Error("Invalid independent verdict.");
  if (!["finished", "timed-out"].includes(run.status)) throw new Error("Run is not terminal.");
  if (!Number.isFinite(run.elapsedMs) || run.elapsedMs < 0) throw new Error("Missing controller timing.");
  const checks = goal.checks.map((id) => {
    const check = evidence.checks?.[id];
    if (!check || !["pass", "fail", "unknown"].includes(check.status)) throw new Error(`Missing outcome check: ${id}`);
    required(check.reason, `${id} reason`);
    return {
      id,
      status: check.status,
      reason: check.reason,
      evidence: evidenceFile(evidenceDirectory, check.evidence),
    };
  });
  if (
    evidence.verdict === "verified-complete" &&
    (run.status !== "finished" || run.participant?.status !== "complete" || checks.some((c) => c.status !== "pass"))
  )
    throw new Error("Only an independently verified, complete, non-timeout run may pass.");
  const receipt = {
    schema,
    runId: run.runId,
    head: manifest.head,
    runSha256: digest(runBytes),
    reviewer: evidence.reviewer,
    verdict: evidence.verdict,
    checks,
    adjudicatedAt: new Date().toISOString(),
    advisory: true,
  };
  writeJson(path.join(directory, "adjudication.json"), receipt);
  return receipt;
}

export function compareProbes(candidate, baselines) {
  const keys = [
    "goalId",
    "goalVersion",
    "goalSha256",
    "scenarioSha256",
    "role",
    "startPath",
    "budgetMs",
    "maxActions",
    "model",
    "effort",
    "mode",
    "timingVersion",
    "fixtureId",
    "harness",
    "viewport",
    "locale",
    "timezone",
    "cachePolicy",
  ];
  const correct = (r) =>
    r.adjudication?.verdict === "verified-complete" &&
    r.run.status === "finished" &&
    Number.isFinite(r.run.elapsedMs) &&
    r.run.elapsedMs >= 0;
  if (!correct(candidate))
    return { status: "noncompletion", verdict: candidate.adjudication?.verdict ?? "unadjudicated", advisory: true };
  const matching = baselines.filter(
    (b) =>
      correct(b) &&
      keys.every((k) => b.manifest[k] === candidate.manifest[k]) &&
      b.manifest.runId !== candidate.manifest.runId,
  );
  const distinct = [...new Map(matching.map((b) => [b.manifest.runId, b])).values()];
  if (distinct.length < 5)
    return { status: "insufficient-baseline", matchingCorrectRuns: distinct.length, advisory: true };
  const times = distinct.map((b) => b.run.elapsedMs).sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  const medianMs = times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2;
  return {
    status:
      candidate.run.elapsedMs > medianMs * 2 && candidate.run.elapsedMs - medianMs > 60_000
        ? "timing-warning"
        : "within-threshold",
    medianMs,
    candidateMs: candidate.run.elapsedMs,
    matchingCorrectRuns: times.length,
    advisory: true,
  };
}

function readProbe(directory) {
  const manifestBytes = readFileSync(path.join(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  const bytes = readFileSync(path.join(directory, "run.json"));
  const run = JSON.parse(bytes);
  const adjudication = readJson(path.join(directory, "adjudication.json"));
  if (
    adjudication.runSha256 !== digest(bytes) ||
    manifest.runId !== run.runId ||
    adjudication.runId !== run.runId ||
    manifest.head !== adjudication.head ||
    run.manifestSha256 !== digest(manifestBytes)
  )
    throw new Error("Receipt no longer matches the run.");
  return { manifest, run, adjudication };
}

export function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  const option = (name) => required(readOption(argv, `--${name}`), `--${name}`);
  if (command === "audit") {
    const surfaceId = readOption(argv, "--surface");
    const modules = surfaceId
      ? browserUsabilityGoalModules.filter((surface) => surface.id === surfaceId)
      : browserUsabilityGoalModules;
    if (!modules.length) throw new Error(`Unknown browser usability surface: ${surfaceId}`);
    const result = auditBrowserUsabilityRoutes(git(["ls-files"]).split(/\r?\n/).filter(Boolean));
    if (surfaceId) result.coverage.surfaces = { [surfaceId]: result.coverage.surfaces[surfaceId] };
    return result;
  }
  if (command === "select") {
    const base = readOption(argv, "--base") ?? "origin/main";
    const paths = git(["diff", "--name-only", base, "--"]).split(/\r?\n/).filter(Boolean);
    const untracked = git(["ls-files", "--others", "--exclude-standard"]).split(/\r?\n/).filter(Boolean);
    return { advisory: true, base, goals: selectBrowserUsabilityGoals([...paths, ...untracked]).map((g) => g.id) };
  }
  if (command === "prepare") {
    if (git(["status", "--porcelain"]))
      throw new Error("Commit the candidate first so evidence names an exact clean head.");
    const preflightPath = path.resolve(option("preflight"));
    return prepareProbe({
      goalId: option("goal"),
      origin: option("origin"),
      preflight: readJson(preflightPath),
      evidenceDirectory: path.dirname(preflightPath),
      directory: path.resolve(option("out")),
      head: git(["rev-parse", "HEAD"]),
    });
  }
  if (command === "adjudicate") {
    const evidencePath = path.resolve(option("evidence"));
    return adjudicateProbe({
      directory: path.resolve(option("run")),
      evidence: readJson(evidencePath),
      evidenceDirectory: path.dirname(evidencePath),
    });
  }
  if (command === "compare")
    return compareProbes(readProbe(option("candidate")), readRepeatedOptions(argv, "--baseline").map(readProbe));
  if (!command || command === "help" || command === "--help")
    return {
      usage: [
        "pnpm run ops browser:usability select [--base origin/main]",
        "pnpm run ops browser:usability audit [--surface ID]",
        "pnpm run ops browser:usability prepare --goal ID --origin http://localhost:PORT --preflight FILE --out NEW_DIRECTORY",
        "pnpm run ops browser:usability adjudicate --run DIRECTORY --evidence FILE",
        "pnpm run ops browser:usability compare --candidate DIRECTORY --baseline DIRECTORY [--baseline DIRECTORY ...]",
        "Moderator-driven advisory probes. See docs/contributing/browser-usability.md. No CI or merge authorization.",
      ],
    };
  throw new Error(`Unknown browser usability command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(main(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
