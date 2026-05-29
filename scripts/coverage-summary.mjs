import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const coverageRoots = ["bounded-contexts", "contracts", "deployables", "infrastructure", "packages"];
const defaultOutputDir = "artifacts/coverage";

function walkFiles(rootDir) {
  if (!existsSync(rootDir)) {
    return [];
  }

  const files = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      continue;
    }

    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

export function parseLcovTotals(content) {
  const totals = {
    files: 0,
    linesFound: 0,
    linesHit: 0,
    functionsFound: 0,
    functionsHit: 0,
    branchesFound: 0,
    branchesHit: 0,
  };

  for (const record of content.split("end_of_record")) {
    if (record.includes("\nSF:") || record.startsWith("SF:")) {
      totals.files += 1;
    }

    for (const line of record.split(/\r?\n/)) {
      const [key, rawValue] = line.split(":");
      const value = Number.parseInt(rawValue ?? "", 10);
      if (!Number.isFinite(value)) {
        continue;
      }

      if (key === "LF") totals.linesFound += value;
      if (key === "LH") totals.linesHit += value;
      if (key === "FNF") totals.functionsFound += value;
      if (key === "FNH") totals.functionsHit += value;
      if (key === "BRF") totals.branchesFound += value;
      if (key === "BRH") totals.branchesHit += value;
    }
  }

  return totals;
}

function percent(hit, found) {
  if (found === 0) {
    return "n/a";
  }

  return `${((hit / found) * 100).toFixed(2)}%`;
}

export function parseCoverageSummaryArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const options = {
    outputDir: defaultOutputDir,
    statuses: [],
  };

  for (const arg of args) {
    if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
      continue;
    }

    if (arg.startsWith("--status=")) {
      const [name, status] = arg.slice("--status=".length).split(":", 2);
      if (name && status) {
        options.statuses.push({ name, status });
      }
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function buildCoverageSummary({ lcovFiles, totals, statuses }) {
  const statusRows = statuses.length
    ? statuses.map((entry) => `| ${entry.name} | ${entry.status} |`).join("\n")
    : "| none | not reported |";

  return [
    "# Coverage Summary",
    "",
    `LCOV files merged: ${lcovFiles.length}`,
    "",
    "| Metric | Covered | Total | Percent |",
    "| --- | ---: | ---: | ---: |",
    `| Lines | ${totals.linesHit} | ${totals.linesFound} | ${percent(totals.linesHit, totals.linesFound)} |`,
    `| Functions | ${totals.functionsHit} | ${totals.functionsFound} | ${percent(totals.functionsHit, totals.functionsFound)} |`,
    `| Branches | ${totals.branchesHit} | ${totals.branchesFound} | ${percent(totals.branchesHit, totals.branchesFound)} |`,
    "",
    "| Command | Status |",
    "| --- | --- |",
    statusRows,
    "",
  ].join("\n");
}

export function collectLcovFiles(rootDir = repoRoot) {
  return coverageRoots
    .flatMap((coverageRoot) => walkFiles(path.join(rootDir, coverageRoot)))
    .filter(
      (filePath) => path.basename(filePath) === "lcov.info" && filePath.includes(`${path.sep}coverage${path.sep}`),
    )
    .sort();
}

export function writeCoverageSummary({ rootDir = repoRoot, outputDir = defaultOutputDir, statuses = [] } = {}) {
  const lcovFiles = collectLcovFiles(rootDir);
  const outputPath = path.join(rootDir, outputDir);
  mkdirSync(outputPath, { recursive: true });

  const mergedLcov = lcovFiles
    .map((filePath) => readFileSync(filePath, "utf8").trim())
    .filter(Boolean)
    .join("\n");
  writeFileSync(path.join(outputPath, "lcov.info"), `${mergedLcov}\n`, "utf8");

  const totals = parseLcovTotals(mergedLcov);
  const summary = buildCoverageSummary({ lcovFiles, totals, statuses });
  writeFileSync(path.join(outputPath, "summary.md"), summary, "utf8");

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  }

  console.log(summary);
  return { lcovFiles, totals, summary };
}

function main() {
  const options = parseCoverageSummaryArgs(process.argv.slice(2));
  writeCoverageSummary(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
