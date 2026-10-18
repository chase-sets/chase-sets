import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildCapturePart,
  readRenderedCopyObservations,
  renderedCopyCaptureArtifactName,
  renderedCopyCaptureArtifactRoot,
  renderedCopyCollectEnabled,
  renderedCopyObservationDirectory,
  renderedCopyOwningBatch,
  renderedCopySweepSpecs,
  renderedCopyToolPaths,
  renderedCopyTupleKey,
  renderedCopyTuples,
  validateCapturePart,
} from "../infrastructure/playwright-evidence/rendered-copy.ts";
import { e2eSuiteById, e2eSuites } from "./e2e-suites.mjs";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";
import { buildPackageManagerInvocation, runCommand } from "./lib/process.mjs";
import { validateResponsiveEvidenceArtifacts } from "./validate-responsive-evidence-artifacts.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

export function parseSuiteArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const suiteIds = args
    .flatMap((arg) => arg.split(/[,\s]+/))
    .map((suiteId) => suiteId.trim())
    .filter(Boolean);
  if (suiteIds.length === 0) {
    throw new Error(
      `Usage: node ./scripts/run-e2e-suite.mjs <suite-id>[,<suite-id>...]\nKnown suites: ${e2eSuites.map((suite) => suite.id).join(", ")}`,
    );
  }

  const suites = [];
  for (const suiteId of suiteIds) {
    const suite = e2eSuiteById(suiteId);
    if (!suite) {
      throw new Error(`Unknown E2E suite '${suiteId}'. Known suites: ${e2eSuites.map((entry) => entry.id).join(", ")}`);
    }
    suites.push(suite);
  }

  return suites;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildSuiteGrep(suites) {
  return suites.map((suite) => escapeRegExp(suite.grep)).join("|");
}

export function commandSuiteInvocation(suite, platform = process.platform, env = process.env) {
  const invocation = buildPackageManagerInvocation(suite.command);
  if (suite.requiresDisplay && platform === "linux" && !env.DISPLAY) {
    return { command: "xvfb-run", args: ["--auto-servernum", invocation.command, ...invocation.args] };
  }
  return invocation;
}

const renderedCopyTupleTitle = (tuple) => `rendered copy ${tuple.persona} ${tuple.page} ${tuple.tag} @browser-e2e-seed`;

// Flattens a `playwright test --list --reporter=json` report into the batch's
// normal execution order: projects in config order, files as listed, tests by
// declaration line. Nothing is filtered or reordered to suit the sweep.
export function renderedCopyListingOrder(report) {
  const projects = (report.config?.projects ?? []).map((project) => project.name);
  const specsOf = (suite) => [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(specsOf)];
  // Array#sort is stable, so loop-generated tests sharing a line keep their order.
  const files = (report.suites ?? []).map((suite) =>
    specsOf(suite)
      .sort((left, right) => left.line - right.line || left.column - right.column)
      .flatMap((spec) =>
        (spec.tests ?? []).map((test) => ({ path: spec.file, title: spec.title, project: test.projectName })),
      ),
  );
  return projects.flatMap((project) =>
    files.flatMap((entries) => entries.filter((entry) => entry.project === project)),
  );
}

export function renderedCopyListing(order, blobOf) {
  const listing = [];
  for (const entry of order) {
    const last = listing.at(-1);
    if (last?.path === entry.path) last.tests += 1;
    else listing.push({ path: entry.path, blob: blobOf(entry.path), tests: 1 });
  }
  const positions = new Map();
  for (const tuple of renderedCopyTuples) {
    const position = order.findIndex(
      (entry) =>
        entry.path === renderedCopySweepSpecs[tuple.deployable] && entry.title === renderedCopyTupleTitle(tuple),
    );
    if (position >= 0) positions.set(renderedCopyTupleKey(tuple), position);
  }
  return { listing, positions };
}

export function renderedCopyCaptureIdentity(git, sourceHead) {
  const parents = git("show", "-s", "--diff-merges=off", "--format=%P", "HEAD").split(/\s+/).filter(Boolean);
  const base = parents[0] ?? "";
  return {
    checkout: { commit: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), parents },
    base: { commit: base, tree: git("rev-parse", `${base}^{tree}`) },
    head: { commit: sourceHead, tree: git("rev-parse", `${sourceHead}^{tree}`) },
    diff: git("diff", "--name-only", base, "HEAD").split("\n").filter(Boolean).sort(),
    tools: renderedCopyToolPaths.map((file) => ({ path: file, blob: git("rev-parse", `HEAD:${file}`) })),
  };
}

export function prepareRenderedCopyCapturePart({ batch, env, git, report, observations, capturedAt }) {
  const workflow = /\/\.github\/workflows\/([^/@]+)@/.exec(env.GITHUB_WORKFLOW_REF ?? "")?.[1] ?? "";
  const { listing, positions } = renderedCopyListing(renderedCopyListingOrder(report), (file) =>
    git("rev-parse", `HEAD:${file}`),
  );
  const part = buildCapturePart({
    run: {
      workflow,
      event: env.GITHUB_EVENT_NAME ?? "",
      id: Number(env.GITHUB_RUN_ID),
      attempt: Number(env.GITHUB_RUN_ATTEMPT),
      jobIndex: Number(env.RENDERED_COPY_CAPTURE_JOB_INDEX),
      batch,
      capturedAt,
    },
    identity: renderedCopyCaptureIdentity(git, env.RENDERED_COPY_CAPTURE_SOURCE_HEAD ?? ""),
    listing,
    positions,
    observations,
  });
  const violations = validateCapturePart(part);
  if (violations.length > 0) throw new Error(`rendered-copy capture part is invalid:\n${violations.join("\n")}`);
  return part;
}

function repositoryGit(...args) {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function listPlaywrightBatch(grep) {
  const invocation = buildPackageManagerInvocation([
    "exec",
    "playwright",
    "test",
    "--list",
    "--reporter=json",
    "--grep",
    grep,
  ]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`playwright --list failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  // The JSON reporter prints one report object after any configuration output.
  return JSON.parse(result.stdout.slice(result.stdout.lastIndexOf('{\n  "config"')));
}

async function main() {
  acquireHeavySlot("playwright");
  const suites = parseSuiteArgs(process.argv.slice(2));
  console.log(`Running E2E suites: ${suites.map((suite) => suite.id).join(", ")}`);
  const playwrightSuites = suites.filter((suite) => !Array.isArray(suite.command));
  if (playwrightSuites.length > 0) {
    const grep = buildSuiteGrep(playwrightSuites);
    const batch = suites.map((suite) => suite.id).join(",");
    // Capture is enabled only by the committed toggle, only on pull_request (a
    // merge_group checkout is the queue's single-parent commit, and every
    // merge_group refuses the toggle in the provenance check), only in the
    // Platform PR producer step that binds the capture job index (any other
    // hosted step, such as the scripts battery, never lists or captures) and
    // only for batches that own sweep tuples; other batches are ineligible.
    const capture =
      renderedCopyCollectEnabled(rootDir) &&
      process.env.GITHUB_EVENT_NAME === "pull_request" &&
      process.env.RENDERED_COPY_CAPTURE_JOB_INDEX !== undefined &&
      renderedCopyOwningBatch(batch);
    const report = capture ? listPlaywrightBatch(grep) : null;
    if (capture) rmSync(path.join(rootDir, renderedCopyObservationDirectory), { recursive: true, force: true });
    const invocation = buildPackageManagerInvocation(["exec", "playwright", "test", "--grep", grep]);
    await runCommand(invocation.command, invocation.args, {
      cwd: rootDir,
      stdio: "inherit",
    });
    if (capture) {
      const part = prepareRenderedCopyCapturePart({
        batch,
        env: process.env,
        git: repositoryGit,
        report,
        observations: readRenderedCopyObservations(rootDir),
        capturedAt: new Date().toISOString(),
      });
      const name = renderedCopyCaptureArtifactName(part.run.id, part.run.attempt, part.run.jobIndex);
      const directory = path.join(rootDir, renderedCopyCaptureArtifactRoot, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "part.json"), `${JSON.stringify(part, null, 2)}\n`);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "rendered-copy-capture=true\n");
      console.log(`Rendered-copy capture part ${name}: ${part.tuples.length} tuples, ${part.fields.length} fields.`);
    }
    const artifactResult = await validateResponsiveEvidenceArtifacts({
      repoRoot: rootDir,
      selectedGreps: playwrightSuites.map((suite) => suite.grep),
    });
    if (artifactResult.violations.length > 0) {
      throw new Error(artifactResult.violations.join("\n"));
    }
    if (artifactResult.expectedClaimIds.length > 0) {
      console.log(
        `Responsive evidence artifacts: ${artifactResult.manifests.length}/${artifactResult.expectedClaimIds.length} required claims validated.`,
      );
    }
  }

  for (const suite of suites.filter((candidate) => Array.isArray(candidate.command))) {
    const invocation = commandSuiteInvocation(suite);
    await runCommand(invocation.command, invocation.args, {
      cwd: rootDir,
      stdio: "inherit",
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
