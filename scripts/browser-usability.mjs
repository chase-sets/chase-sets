import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

const findingSeverities = ["blocker", "major", "minor", "polish"];
function moderatorObservations(evidence, run, goal, resolveEvidence, files) {
  const object = (value, keys, name) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}.`);
    for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unknown ${name} key: ${key}.`);
  };
  const step = (value) => {
    if (!Number.isInteger(value) || value < 0 || value >= (run.calls?.length ?? 0))
      throw new Error("Invalid observation step.");
  };
  const result = {};
  if (evidence.findings !== undefined) {
    if (!Array.isArray(evidence.findings)) throw new Error("findings must be an array.");
    const ids = new Set();
    result.findings = evidence.findings.map((finding) => {
      object(
        finding,
        ["id", "category", "severity", "summary", "observedPath", "step", "evidence", "basis"],
        "finding",
      );
      if (typeof finding.id !== "string" || !/^F[1-9]\d*$/.test(finding.id) || ids.has(finding.id))
        throw new Error("Invalid or duplicate finding id.");
      ids.add(finding.id);
      if (
        ![
          "blocked",
          "wrong-answer",
          "dead-end",
          "misleading-copy",
          "discoverability",
          "slow",
          "error-state",
          "accessibility",
          "environment",
        ].includes(finding.category)
      )
        throw new Error("Invalid finding category.");
      if (!findingSeverities.includes(finding.severity)) throw new Error("Invalid finding severity.");
      if (typeof finding.summary !== "string" || finding.summary.length < 1 || finding.summary.length > 500)
        throw new Error("Invalid finding summary.");
      if (
        finding.observedPath !== undefined &&
        (typeof finding.observedPath !== "string" || !/^\/(?!\/)[^?#\\\s]*$/.test(finding.observedPath))
      )
        throw new Error("Invalid finding observedPath.");
      if (finding.step !== undefined) step(finding.step);
      if (!["moderator-reproduced", "participant-reported"].includes(finding.basis))
        throw new Error("Invalid finding basis.");
      return { ...finding, evidence: resolveEvidence(finding.evidence) };
    });
  }
  if (evidence.reachedRoutes !== undefined) {
    if (!Array.isArray(evidence.reachedRoutes)) throw new Error("reachedRoutes must be an array.");
    const surface = browserUsabilityGoalModules.find((entry) => entry.goals.some((entry) => entry.id === goal.id));
    const routes = surfaceRoutes(surface, files);
    result.reachedRoutes = evidence.reachedRoutes.map((reached) => {
      object(reached, ["route", "step", "evidence"], "reached route");
      if (!routes.includes(reached.route))
        throw new Error("Reached route is outside the goal's surface route universe.");
      step(reached.step);
      return { ...reached, evidence: resolveEvidence(reached.evidence) };
    });
  }
  return result;
}

function surfaceRoutes(surface, files) {
  const patterns = surface.routeScope.map((pattern) => new RegExp(pattern));
  return files.filter(
    (file) =>
      /^(bounded-contexts\/[^/]+\/routes\/|deployables\/(marketplace|admin-web|public-web)\/app\/routes\/)/.test(
        file,
      ) &&
      file.endsWith(".tsx") &&
      !/\.(test|spec)\.tsx$/.test(file) &&
      patterns.some((pattern) => pattern.test(file)),
  );
}
const trackedFiles = () => git(["ls-files"]).split(/\r?\n/).filter(Boolean);

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
      "Stop on uncertainty rather than expanding scope.",
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
    ...moderatorObservations(
      evidence,
      run,
      goal,
      (file) => evidenceFile(evidenceDirectory, file),
      evidence.reachedRoutes === undefined ? [] : trackedFiles(),
    ),
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

function readProbe(directory, files, manifestBytes = readFileSync(path.join(directory, "manifest.json"))) {
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
  moderatorObservations(
    adjudication,
    run,
    browserUsabilityGoal(manifest.goalId),
    (proof) => {
      if (!proof || typeof proof.path !== "string" || !/^[0-9a-f]{64}$/.test(proof.sha256))
        throw new Error("Invalid receipt evidence hash.");
      return proof;
    },
    adjudication.reachedRoutes === undefined ? [] : (files ?? trackedFiles()),
  );
  return { manifest, run, adjudication };
}

export function auditProbeSweep({ root, surfaceId, notRun = [], files = trackedFiles() }) {
  const surface = browserUsabilityGoalModules.find((entry) => entry.id === surfaceId);
  if (!surface) throw new Error(`Unknown browser usability surface: ${surfaceId}`);
  if (!Array.isArray(notRun)) throw new Error("not-run must be an array.");
  const reasons = new Map();
  for (const entry of notRun) {
    if (!entry || typeof entry !== "object") throw new Error("Invalid not-run entry.");
    if (!surface.goals.some((goal) => goal.id === entry.goalId)) throw new Error("Unknown not-run goal.");
    if (reasons.has(entry.goalId)) throw new Error("Duplicate not-run goal.");
    reasons.set(entry.goalId, required(entry.reason, "not-run reason"));
  }
  const runs = [];
  const heads = new Set();
  const ids = new Set();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, entry.name);
    if (!existsSync(path.join(directory, "manifest.json"))) continue;
    const manifestBytes = readFileSync(path.join(directory, "manifest.json"));
    const manifest = JSON.parse(manifestBytes);
    browserUsabilityGoal(manifest.goalId);
    if (!surface.goals.some((goal) => goal.id === manifest.goalId)) throw new Error("Manifest goal outside surface.");
    if (!/^[0-9a-f]{40}$/.test(manifest.head) || !Number.isFinite(Date.parse(manifest.preparedAt)))
      throw new Error("Invalid sweep manifest head or preparedAt.");
    if (ids.has(manifest.runId)) throw new Error("Duplicate sweep run id.");
    ids.add(manifest.runId);
    heads.add(manifest.head);
    const probe = existsSync(path.join(directory, "adjudication.json"))
      ? readProbe(directory, files, manifestBytes)
      : {
          manifest,
          run: existsSync(path.join(directory, "run.json")) ? readJson(path.join(directory, "run.json")) : null,
        };
    runs.push(probe);
  }
  if (heads.size > 1) throw new Error("Sweep contains more than one head.");
  const selected = new Map();
  const goals = surface.goals.map((goal) => {
    const attempts = runs
      .filter((probe) => probe.manifest.goalId === goal.id)
      .sort(
        (a, b) =>
          Date.parse(a.manifest.preparedAt) - Date.parse(b.manifest.preparedAt) ||
          a.manifest.runId.localeCompare(b.manifest.runId),
      );
    const adjudicated = attempts.filter((probe) => probe.adjudication);
    if (reasons.has(goal.id) && adjudicated.length) throw new Error("Goal has both not-run and adjudicated attempts.");
    const chosen =
      adjudicated.filter((probe) => probe.adjudication.verdict !== "environment-invalid").at(-1) ?? adjudicated.at(-1);
    if (chosen) selected.set(goal.id, chosen);
    return {
      goalId: goal.id,
      status:
        chosen?.adjudication.verdict ?? (reasons.has(goal.id) ? "not-run" : attempts.length ? "incomplete" : "missing"),
      ...(reasons.has(goal.id) ? { reason: reasons.get(goal.id) } : {}),
      ...(chosen ? { selectedRunId: chosen.manifest.runId } : {}),
      attempts: attempts.map(({ manifest, run, adjudication }) => ({
        runId: manifest.runId,
        preparedAt: manifest.preparedAt,
        runStatus: run?.status ?? null,
        elapsedMs: run?.elapsedMs ?? null,
        actions: run?.actions ?? null,
        verdict: adjudication?.verdict ?? null,
      })),
    };
  });
  const findings = runs
    .flatMap(({ manifest, adjudication }) =>
      (adjudication?.findings ?? []).map((finding) => ({
        key: `${surfaceId}/${manifest.goalId}/${manifest.runId}/${finding.id}`,
        goalId: manifest.goalId,
        runId: manifest.runId,
        ...finding,
      })),
    )
    .sort(
      (a, b) =>
        findingSeverities.indexOf(a.severity) - findingSeverities.indexOf(b.severity) ||
        a.goalId.localeCompare(b.goalId) ||
        a.key.localeCompare(b.key),
    );
  const exercised = [];
  const unexercised = [];
  const excluded = surface.excludedRoutes;
  for (const route of surfaceRoutes(surface, files)) {
    if (excluded.some((entry) => entry.path === route)) continue;
    const reached = goals.find((goal) =>
      selected.get(goal.goalId)?.adjudication.reachedRoutes?.some((entry) => entry.route === route),
    );
    if (reached) exercised.push(route);
    else {
      const claimant = goals.find((goal) => Object.hasOwn(browserUsabilityGoal(goal.goalId).routes ?? {}, route));
      unexercised.push({
        key: `${surfaceId}/unexercised/${route}`,
        route,
        goalId: claimant?.goalId ?? null,
        status: claimant?.status ?? "missing",
      });
    }
  }
  return {
    head: [...heads][0] ?? null,
    surface: surfaceId,
    goals,
    findings,
    coverage: { exercised, unexercised, excluded },
  };
}

export function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  const option = (name) => required(readOption(argv, `--${name}`), `--${name}`);
  if (command === "audit") {
    const surfaceId = readOption(argv, "--surface");
    const root = readOption(argv, "--root");
    if (root)
      return auditProbeSweep({
        root: path.resolve(root),
        surfaceId: option("surface"),
        notRun: readOption(argv, "--not-run") ? readJson(readOption(argv, "--not-run")) : [],
      });
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
    return compareProbes(
      readProbe(option("candidate")),
      readRepeatedOptions(argv, "--baseline").map((directory) => readProbe(directory)),
    );
  if (!command || command === "help" || command === "--help")
    return {
      usage: [
        "pnpm run ops browser:usability select [--base origin/main]",
        "pnpm run ops browser:usability audit [--surface ID]",
        "pnpm run ops browser:usability audit --root DIRECTORY --surface ID [--not-run FILE]",
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
