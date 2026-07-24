import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { e2eSuiteById, e2eSuites } from "./e2e-suites.mjs";
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

async function main() {
  const suites = parseSuiteArgs(process.argv.slice(2));
  console.log(`Running E2E suites: ${suites.map((suite) => suite.id).join(", ")}`);
  const playwrightSuites = suites.filter((suite) => !Array.isArray(suite.command));
  if (playwrightSuites.length > 0) {
    const grep = buildSuiteGrep(playwrightSuites);
    const invocation = buildPackageManagerInvocation(["exec", "playwright", "test", "--grep", grep]);
    await runCommand(invocation.command, invocation.args, {
      cwd: rootDir,
      stdio: "inherit",
    });
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
    const invocation = buildPackageManagerInvocation(suite.command);
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
