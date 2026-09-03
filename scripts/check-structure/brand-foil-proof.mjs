import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireHeavySlot } from "../lib/heavy-slot.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const aggregateFixture = "#8A682A80";
const validatorPath = "scripts/check-structure/brand-foil-sites.mjs";
const aggregatePath = "scripts/check-structure.mjs";
const runPath = "scripts/check-structure/run.mjs";
const plantedPath = "scripts/opaque-violation.data";
const candidatePaths = [
  validatorPath,
  "scripts/check-structure/brand-foil-sites.test.mjs",
  runPath,
  "scripts/check-structure/brand-mark-representations.test.mjs",
  "scripts/check-structure/brand-foil-proof.mjs",
  "package.json",
  "scripts/check-heavy-slot-coverage.test.mjs",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (root, args) =>
  execFileSync("git", args, {
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
const gitText = (root, args) => git(root, args).toString("utf8").trim();
const status = (root) => git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
const indexPath = (root) => path.resolve(root, gitText(root, ["rev-parse", "--git-path", "index"]));

export function assertProofArguments(args) {
  assert.equal(args.length, 0, "brand foil proof accepts no arguments or root override");
}

export function inspectProofCandidate(root, cwd) {
  assert.equal(realpathSync(cwd), realpathSync(root), "brand foil proof must run from its real repository root");
  assert.equal(realpathSync(gitText(root, ["rev-parse", "--show-toplevel"])), realpathSync(root));
  const head = gitText(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const tree = gitText(root, ["rev-parse", "HEAD^{tree}"]);
  const base = gitText(root, ["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"]);
  const mergeBase = gitText(root, ["merge-base", base, head]);
  for (const object of [head, tree, base, mergeBase]) assert.match(object, /^[a-f0-9]{40}$/);
  assert.equal(status(root).length, 0, "brand foil proof requires a clean committed candidate and index");
  const parents = gitText(root, ["show", "-s", "--format=%P", head]).split(" ").filter(Boolean);
  return { root: realpathSync(root), head, tree, base, mergeBase, parents };
}

export function snapshotProofRepository(root) {
  const index = readFileSync(indexPath(root));
  const tracked = git(root, ["ls-files", "-z"]);
  const digest = createHash("sha256");
  let start = 0;
  let files = 0;
  for (let end = 0; end < tracked.length; end++) {
    if (tracked[end] !== 0) continue;
    const name = tracked.subarray(start, end);
    const bytes = readFileSync(Buffer.concat([Buffer.from(root + path.sep), name]));
    digest.update(name).update("\0").update(String(bytes.length)).update("\0").update(bytes);
    start = end + 1;
    files++;
  }
  assert.equal(start, tracked.length, "unterminated tracked path");
  return {
    head: gitText(root, ["rev-parse", "HEAD"]),
    tree: gitText(root, ["rev-parse", "HEAD^{tree}"]),
    files,
    bytes: digest.digest("hex"),
    index: hash(index),
    status: status(root).toString("hex"),
  };
}

// Only the two production registration spans change; every intervening byte is retained.
export function omitBrandFoilRegistration(source) {
  const targets = [
    'import { validateBrandFoilSites } from "./brand-foil-sites.mjs";\n',
    "  const brandFoilSitesResult = validateBrandFoilSites({ repoRoot });\n  violations.push(...brandFoilSitesResult.violations);\n",
  ];
  const spans = targets
    .map((target) => {
      const start = source.indexOf(target);
      assert.ok(start >= 0 && source.indexOf(target, start + target.length) === -1, "expected exactly one import/fold");
      return { start, end: start + target.length, target };
    })
    .sort((a, b) => a.start - b.start);
  assert.ok(spans[0].end <= spans[1].start);
  const retained = [
    source.slice(0, spans[0].start),
    source.slice(spans[0].end, spans[1].start),
    source.slice(spans[1].end),
  ];
  assert.equal(retained[0] + spans[0].target + retained[1] + spans[1].target + retained[2], source);
  return { source: retained.join(""), retainedSha256: hash(retained.join("")), spans };
}

export function withProofMutation(root, action, log = console.log) {
  const originalRun = readFileSync(path.join(root, runPath));
  const originalIndex = readFileSync(indexPath(root));
  const before = snapshotProofRepository(root);
  assert.equal(existsSync(path.join(root, plantedPath)), false, "planted path must be absent");
  try {
    writeFileSync(path.join(root, plantedPath), aggregateFixture);
    git(root, ["add", "--", plantedPath]);
    return action({ originalRun, plantedPath });
  } finally {
    const failures = [];
    for (const restore of [
      () => writeFileSync(path.join(root, runPath), originalRun),
      () => writeFileSync(indexPath(root), originalIndex),
      () => rmSync(path.join(root, plantedPath), { force: true }),
    ]) {
      try {
        restore();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "brand foil clone restoration failed");
    const after = snapshotProofRepository(root);
    assert.deepEqual(after, before, "clone bytes/index/status must be restored");
    assert.equal(existsSync(path.join(root, plantedPath)), false);
    log(`Brand foil proof cleanup: ${JSON.stringify({ before, after, plantedPathAbsent: true })}`);
  }
}

export function withProofClone(candidate, action, log = console.log) {
  const parentBefore = snapshotProofRepository(candidate.root);
  const temporaryRoot = realpathSync(mkdtempSync(path.join(os.tmpdir(), "brand-foil-proof-")));
  const clone = path.join(temporaryRoot, "checkout");
  try {
    git(candidate.root, ["clone", "--quiet", "--shared", "--no-checkout", "--", candidate.root, clone]);
    git(clone, ["checkout", "--quiet", "--detach", candidate.head]);
    git(clone, ["update-ref", "refs/remotes/origin/main", candidate.base]);
    assert.deepEqual(inspectProofCandidate(clone, clone), { ...candidate, root: realpathSync(clone) });
    assert.equal(gitText(clone, ["ls-files", "--stage"]), gitText(candidate.root, ["ls-files", "--stage"]));
    if (existsSync(path.join(candidate.root, "node_modules")))
      symlinkSync(path.join(candidate.root, "node_modules"), path.join(clone, "node_modules"), "junction");
    return action(clone);
  } finally {
    const failures = [];
    try {
      const parentAfter = snapshotProofRepository(candidate.root);
      assert.deepEqual(parentAfter, parentBefore, "source repository bytes/index/status changed");
      log(`Brand foil proof source preserved: ${JSON.stringify({ before: parentBefore, after: parentAfter })}`);
    } catch (error) {
      failures.push(error);
    }
    try {
      assert.equal(realpathSync(temporaryRoot), temporaryRoot);
      assert.equal(path.dirname(temporaryRoot), realpathSync(os.tmpdir()));
      assert.ok(path.basename(temporaryRoot).startsWith("brand-foil-proof-"));
      rmSync(temporaryRoot, { recursive: true, force: true });
      assert.equal(existsSync(temporaryRoot), false);
      log("Brand foil proof owned temporary clone removed");
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "brand foil proof cleanup failed");
  }
}

export function proofEnvironment(candidate, env = process.env) {
  const changed = git(candidate.root, ["diff", "--name-only", "-z", `${candidate.mergeBase}...${candidate.head}`, "--"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  // Freeze the complete candidate diff and both mutation paths across every causal child.
  return { ...env, CHANGED_FILES_JSON: JSON.stringify([...new Set([...changed, runPath, plantedPath])]) };
}

function invoke(root, entry, phase, env) {
  const child = spawnSync(process.execPath, [path.join(root, entry)], {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  console.log(`Brand foil proof ${phase}: command=node ${entry}; exit=${child.status}; signal=${child.signal}`);
  process.stdout.write(child.stdout ?? "");
  process.stderr.write(child.stderr ?? "");
  if (child.error) throw child.error;
  assert.equal(child.signal, null, "proof child must terminate normally");
  return child;
}
function assertViolation(child) {
  assert.equal(child.status, 1);
  const output = child.stdout + child.stderr;
  assert.ok(output.includes(plantedPath), "expected planted path diagnostic");
  assert.match(output, /opaque-violation\.data:.*detectors=raw/);
}

export function runBrandFoilProof() {
  assertProofArguments(process.argv.slice(2));
  const candidate = inspectProofCandidate(repoRoot, process.cwd());
  assert.ok(existsSync(path.join(repoRoot, "node_modules")), "install candidate dependencies before proof");
  acquireHeavySlot("repository-gate");
  const blobs = Object.fromEntries(
    candidatePaths.map((name) => [name, gitText(repoRoot, ["rev-parse", `${candidate.head}:${name}`])]),
  );
  const env = proofEnvironment(candidate);
  console.log(
    `Brand foil proof candidate: ${JSON.stringify({ ...candidate, blobs, changedFiles: JSON.parse(env.CHANGED_FILES_JSON) })}`,
  );
  withProofClone(candidate, (clone) => {
    assert.equal(invoke(clone, validatorPath, "clean standalone", env).status, 0);
    assert.equal(invoke(clone, aggregatePath, "clean aggregate", env).status, 0);
    withProofMutation(clone, ({ originalRun }) => {
      const standalone = invoke(clone, validatorPath, "planted standalone", env);
      const aggregate = invoke(clone, aggregatePath, "planted aggregate", env);
      assertViolation(standalone);
      assertViolation(aggregate);
      const mutationBefore = snapshotProofRepository(clone);
      const omission = omitBrandFoilRegistration(originalRun.toString("utf8"));
      writeFileSync(path.join(clone, runPath), omission.source);
      assert.equal(hash(readFileSync(path.join(clone, runPath))), omission.retainedSha256);
      const bypass = invoke(clone, aggregatePath, "registration omitted aggregate", env);
      const standaloneAfter = invoke(clone, validatorPath, "registration omitted standalone", env);
      assert.equal(bypass.status, 0);
      assertViolation(standaloneAfter);
      assert.doesNotThrow(() => assertViolation(aggregate));
      assert.throws(() => assertViolation(bypass), assert.AssertionError);
      writeFileSync(path.join(clone, runPath), originalRun);
      assert.deepEqual(snapshotProofRepository(clone), mutationBefore, "non-governing mutation inputs changed");
      console.log(
        `Brand foil proof causal assertion: candidate=pass; bypass=fail; ${JSON.stringify({ mutationBefore, retainedSha256: omission.retainedSha256, removedSpans: omission.spans })}`,
      );
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runBrandFoilProof();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
