import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { e2eSuiteById, e2eSuites } from "./e2e-suites.mjs";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";
import { buildPackageManagerInvocation, runCommand } from "./lib/process.mjs";
import { validateResponsiveEvidenceArtifacts } from "./validate-responsive-evidence-artifacts.mjs";
import {
  buildCapturePart,
  readRenderedCopyObservations,
  renderedCopyCaptureArtifactName,
  renderedCopyCaptureArtifactRoot,
  renderedCopyObservationDirectory,
  renderedCopySweepSpecs,
  renderedCopyTupleKey,
  renderedCopyTuples,
} from "../infrastructure/playwright-evidence/rendered-copy.ts";

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

  if (suiteIds.includes("rendered_copy") && suiteIds.length !== 1) throw new Error("rendered_copy must be unpaired");
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

export function expectedRenderedCopyListing() {
  return renderedCopyTuples.map((tuple) => ({
    path: renderedCopySweepSpecs[tuple.deployable],
    title: `rendered copy ${tuple.persona} ${tuple.page} @rendered-copy @browser-e2e-seed`,
    project: `${tuple.deployable}-chromium`,
  }));
}

export function renderedCopyListingOrder(report) {
  const specsOf = (suite) => [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(specsOf)];
  const files = (report.suites ?? []).map((suite) =>
    specsOf(suite).sort((a, b) => a.line - b.line || a.column - b.column),
  );
  const projects = (report.config?.projects ?? []).map((project) => project.name);
  if (
    new Set(projects).size !== projects.length ||
    files.flat().some((spec) => (spec.tests ?? []).some((test) => !projects.includes(test.projectName)))
  )
    throw new Error("rendered-copy exact listed set: duplicate or unknown project");
  return (report.config?.projects ?? []).flatMap((project) =>
    files.flatMap((specs) =>
      specs.flatMap((spec) =>
        (spec.tests ?? [])
          .filter((test) => test.projectName === project.name)
          .map(() => ({ path: spec.file, title: spec.title, project: project.name })),
      ),
    ),
  );
}

export function assertRenderedCopyListing(order) {
  if (JSON.stringify(order) !== JSON.stringify(expectedRenderedCopyListing()))
    throw new Error(
      `rendered-copy exact listed set mismatch: expected ${JSON.stringify(expectedRenderedCopyListing())}; got ${JSON.stringify(order)}`,
    );
  console.log(`RENDERED_COPY_EXACT_LIST ${JSON.stringify(order)}`);
}

export function renderedCopyAttempts(report) {
  assertRenderedCopyListing(renderedCopyListingOrder(report));
  const specsOf = (suite) => [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(specsOf)];
  return (report.suites ?? []).flatMap(specsOf).flatMap((spec) =>
    (spec.tests ?? []).flatMap((test) => {
      // Exact listing has already rejected unknown and duplicate tests.
      const entry = expectedRenderedCopyListing().findIndex(
        (entry) => entry.path === spec.file && entry.title === spec.title && entry.project === test.projectName,
      );
      if (entry < 0) throw new Error("rendered-copy unknown terminal test");
      return (test.results ?? []).map((result) => ({
        key: renderedCopyTupleKey(renderedCopyTuples[entry]),
        retry: result.retry,
        status: result.status,
      }));
    }),
  );
}

export function prepareRenderedCopyCapturePart({ env, git, report, observations, capturedAt }) {
  return buildCapturePart({
    candidate: {
      commit: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
      sourceHead: env.RENDERED_COPY_SOURCE_HEAD ?? "",
    },
    run: {
      workflow: /\/\.github\/workflows\/([^/@]+)@/.exec(env.GITHUB_WORKFLOW_REF ?? "")?.[1] ?? "",
      event: env.GITHUB_EVENT_NAME ?? "",
      id: Number(env.GITHUB_RUN_ID),
      attempt: Number(env.GITHUB_RUN_ATTEMPT),
      jobIndex: Number(env.RENDERED_COPY_JOB_INDEX),
      batch: "rendered_copy",
      capturedAt,
    },
    attempts: renderedCopyAttempts(report),
    observations,
  });
}

function repositoryGit(...args) {
  const result = spawnSync("git", args, { cwd: rootDir, encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.trim();
}

function listRenderedCopy(args) {
  const invocation = buildPackageManagerInvocation([
    "exec",
    "playwright",
    "test",
    ...args,
    "--list",
    "--reporter=json",
  ]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: rootDir,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`rendered-copy discovery failed: ${result.error?.message ?? result.stderr}`);
  const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{\n  "config"')));
  assertRenderedCopyListing(renderedCopyListingOrder(report));
}

async function main() {
  acquireHeavySlot("playwright");
  const suites = parseSuiteArgs(process.argv.slice(2));
  console.log(`Running E2E suites: ${suites.map((suite) => suite.id).join(", ")}`);
  const playwrightSuites = suites.filter((suite) => !Array.isArray(suite.command));
  if (playwrightSuites.length > 0) {
    const grep = buildSuiteGrep(playwrightSuites);
    const dedicated = suites.length === 1 && suites[0].id === "rendered_copy";
    const args = ["--grep", grep, ...(dedicated ? Object.values(renderedCopySweepSpecs) : [])];
    const reportPath = path.join(rootDir, "artifacts/playwright/rendered-copy-results.json");
    if (dedicated) {
      if (
        process.env.PLAYWRIGHT_SKIP_WEB_SERVER === "true" ||
        process.env.CHASE_SETS_BROWSER_E2E_SYSTEM !== "production"
      )
        throw new Error("rendered-copy requires a fresh production browser stack");
      process.env.CHASE_SETS_RENDERED_COPY_SWEEP = "1";
      process.env.CI = "true";
      listRenderedCopy(args);
      rmSync(path.join(rootDir, renderedCopyObservationDirectory), { recursive: true, force: true });
      rmSync(reportPath, { force: true });
    }
    const invocation = buildPackageManagerInvocation(["exec", "playwright", "test", ...args]);
    await runCommand(invocation.command, invocation.args, {
      cwd: rootDir,
      stdio: "inherit",
    });
    if (dedicated) {
      const report = JSON.parse(readFileSync(reportPath, "utf8"));
      const observations = readRenderedCopyObservations(rootDir);
      const attempts = renderedCopyAttempts(report);
      // Validate terminal authority on both events, but only PR jobs produce parts.
      if (process.env.GITHUB_EVENT_NAME === "pull_request") {
        const part = prepareRenderedCopyCapturePart({
          env: process.env,
          git: repositoryGit,
          report,
          observations,
          capturedAt: new Date().toISOString(),
        });
        const name = renderedCopyCaptureArtifactName(part.run.id, part.run.attempt, part.run.jobIndex);
        const directory = path.join(rootDir, renderedCopyCaptureArtifactRoot, name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(path.join(directory, "part.json"), `${JSON.stringify(part, null, 2)}\n`);
        if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `rendered-copy-part=${name}\n`);
        console.log(`RENDERED_COPY_PART ${name} retried=${JSON.stringify(part.retriedTuples)}`);
      } else {
        const { finalRenderedCopyObservations } =
          await import("../infrastructure/playwright-evidence/rendered-copy.ts");
        finalRenderedCopyObservations(observations, attempts);
        console.log("RENDERED_COPY_PART_NOT_PRODUCED: event is not pull_request");
      }
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
