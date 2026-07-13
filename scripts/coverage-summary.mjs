// Coverage posture: aggregate coverage is intentionally measured but
// non-enforcing before launch. The thresholds below are warning signals for
// trend visibility, while scheduled/manual coverage remains non-blocking until
// the project has an owned baseline and promotion plan.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const coverageRoots = ["bounded-contexts", "contracts", "deployables", "infrastructure", "packages"];
const defaultOutputDir = "artifacts/coverage";
const defaultWarningThresholds = {
  lines: 70,
  functions: 70,
  branches: 50,
};

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

function percentValue(hit, found) {
  if (found === 0) {
    return null;
  }

  return (hit / found) * 100;
}

export function parseCoverageSummaryArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const options = {
    lcovFiles: [],
    outputDir: defaultOutputDir,
    statuses: [],
    warningThresholds: { ...defaultWarningThresholds },
  };

  for (const arg of args) {
    if (arg.startsWith("--output-dir=")) {
      options.outputDir = arg.slice("--output-dir=".length);
      continue;
    }

    if (arg.startsWith("--lcov-file=")) {
      options.lcovFiles.push(arg.slice("--lcov-file=".length));
      continue;
    }

    if (arg.startsWith("--status=")) {
      const [name, status] = arg.slice("--status=".length).split(":", 2);
      if (name && status) {
        options.statuses.push({ name, status });
      }
      continue;
    }

    if (arg.startsWith("--warning-threshold=")) {
      const [metric, rawThreshold] = arg.slice("--warning-threshold=".length).split(":", 2);
      const threshold = Number.parseFloat(rawThreshold ?? "");
      if (!["lines", "functions", "branches"].includes(metric ?? "") || !Number.isFinite(threshold)) {
        throw new Error(
          "Coverage warning thresholds must use --warning-threshold=<lines|functions|branches>:<percent>.",
        );
      }

      options.warningThresholds[metric] = threshold;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

export function coverageWarnings({ totals, statuses, warningThresholds = defaultWarningThresholds }) {
  const warnings = [];
  const metrics = [
    { name: "Lines", key: "lines", hit: totals.linesHit, found: totals.linesFound },
    { name: "Functions", key: "functions", hit: totals.functionsHit, found: totals.functionsFound },
    { name: "Branches", key: "branches", hit: totals.branchesHit, found: totals.branchesFound },
  ];

  for (const metric of metrics) {
    const threshold = warningThresholds[metric.key];
    const value = percentValue(metric.hit, metric.found);
    if (typeof threshold === "number" && value !== null && value < threshold) {
      warnings.push(
        `${metric.name} coverage ${value.toFixed(2)}% is below the ${threshold.toFixed(2)}% warning threshold.`,
      );
    }
  }

  for (const status of statuses) {
    if (!["0", "skipped"].includes(status.status)) {
      warnings.push(`${status.name} coverage command reported status ${status.status}.`);
    }
  }

  return warnings;
}

export function buildCoverageSummary({ lcovFiles, totals, statuses, warningThresholds = defaultWarningThresholds }) {
  const statusRows = statuses.length
    ? statuses.map((entry) => `| ${entry.name} | ${entry.status} |`).join("\n")
    : "| none | not reported |";
  const warnings = coverageWarnings({ totals, statuses, warningThresholds });
  const warningRows = warnings.length ? warnings.map((warning) => `- ${warning}`).join("\n") : "- none";

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
    "## Warnings",
    "",
    warningRows,
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

function parseLcovRecords(content) {
  return content
    .split("end_of_record")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => `${record}\nend_of_record`);
}

function recordSourceFile(record) {
  return record
    .split(/\r?\n/)
    .find((line) => line.startsWith("SF:"))
    ?.slice("SF:".length);
}

function recordScore(record) {
  const totals = parseLcovTotals(record);
  return totals.linesHit + totals.functionsHit + totals.branchesHit;
}

export function mergeLcovContents(lcovContents) {
  const recordsBySourceFile = new Map();

  for (const content of lcovContents) {
    for (const record of parseLcovRecords(content)) {
      const sourceFile = recordSourceFile(record);
      if (!sourceFile) {
        continue;
      }

      const existing = recordsBySourceFile.get(sourceFile);
      if (!existing || recordScore(record) >= recordScore(existing)) {
        recordsBySourceFile.set(sourceFile, record);
      }
    }
  }

  return [...recordsBySourceFile.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, record]) => record)
    .join("\n");
}

export function writeCoverageSummary({
  rootDir = repoRoot,
  outputDir = defaultOutputDir,
  statuses = [],
  warningThresholds = defaultWarningThresholds,
  lcovFiles,
} = {}) {
  const selectedLcovFiles = (lcovFiles?.length ? lcovFiles : collectLcovFiles(rootDir))
    .map((filePath) => (path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath)))
    .filter((filePath) => existsSync(filePath))
    .sort();
  const outputPath = path.join(rootDir, outputDir);
  mkdirSync(outputPath, { recursive: true });

  const mergedLcov = mergeLcovContents(
    selectedLcovFiles.map((filePath) => readFileSync(filePath, "utf8").trim()).filter(Boolean),
  );
  writeFileSync(path.join(outputPath, "lcov.info"), `${mergedLcov}\n`, "utf8");

  const totals = parseLcovTotals(mergedLcov);
  const summary = buildCoverageSummary({ lcovFiles: selectedLcovFiles, totals, statuses, warningThresholds });
  writeFileSync(path.join(outputPath, "summary.md"), summary, "utf8");

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  }

  console.log(summary);
  return { lcovFiles: selectedLcovFiles, totals, summary };
}

function main() {
  const options = parseCoverageSummaryArgs(process.argv.slice(2));
  writeCoverageSummary(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
