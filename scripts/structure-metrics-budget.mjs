import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { repoRoot } from "./lib/repo.mjs";

const metricsPath = process.env.STRUCTURE_METRICS_OUTPUT_PATH ?? "artifacts/structure-metrics.json";
const dashboardPath = process.env.STRUCTURE_METRICS_DASHBOARD_PATH ?? "artifacts/structure-metrics-dashboard.md";
const budgetMode = process.env.STRUCTURE_BUDGET_MODE === "error" ? "error" : "warn";

const budget = {
  maxSingleSliceSupportFiles: Number.parseInt(process.env.STRUCTURE_BUDGET_MAX_SINGLE_SLICE_SUPPORT_FILES ?? "20", 10),
  maxDriftCount: Number.parseInt(process.env.STRUCTURE_BUDGET_MAX_DRIFT_COUNT ?? "8", 10),
  maxSupportDirectoryCount: Number.parseInt(process.env.STRUCTURE_BUDGET_MAX_SUPPORT_DIRECTORY_COUNT ?? "80", 10),
};

process.env.STRUCTURE_METRICS_WRITE = "1";
const { runStructureCheck } = await import("./check-structure/run.mjs");
const structureCheckResult = await runStructureCheck({ exit: false });

const absoluteMetricsPath = path.resolve(repoRoot, metricsPath);
const metrics = JSON.parse(readFileSync(absoluteMetricsPath, "utf8"));
const totals = metrics.totals ?? {};
const contexts = Array.isArray(metrics.contexts) ? metrics.contexts : [];

const breaches = [];
if ((totals.singleSliceSupportFiles ?? 0) > budget.maxSingleSliceSupportFiles) {
  breaches.push(
    `single-slice support files ${totals.singleSliceSupportFiles} exceeds budget ${budget.maxSingleSliceSupportFiles}`,
  );
}
if ((totals.driftCount ?? 0) > budget.maxDriftCount) {
  breaches.push(`drift count ${totals.driftCount} exceeds budget ${budget.maxDriftCount}`);
}
if ((totals.supportDirectoryCount ?? 0) > budget.maxSupportDirectoryCount) {
  breaches.push(
    `support directory count ${totals.supportDirectoryCount} exceeds budget ${budget.maxSupportDirectoryCount}`,
  );
}

const lines = [
  "# Structure Metrics Dashboard",
  "",
  `Generated at: ${metrics.generatedAt ?? "unknown"}`,
  "",
  "## Totals",
  "",
  "| Metric | Current | Budget |",
  "| --- | ---: | ---: |",
  `| Context count | ${totals.contextCount ?? 0} | n/a |`,
  `| Slice count | ${totals.sliceCount ?? 0} | n/a |`,
  `| Support directory count | ${totals.supportDirectoryCount ?? 0} | ≤ ${budget.maxSupportDirectoryCount} |`,
  `| Single-slice support files | ${totals.singleSliceSupportFiles ?? 0} | ≤ ${budget.maxSingleSliceSupportFiles} |`,
  `| Drift count | ${totals.driftCount ?? 0} | ≤ ${budget.maxDriftCount} |`,
  "",
  "## Per-context metrics",
  "",
  "| Context | Slices | Support directories | Single-slice support files | Drift count |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...contexts.map(
    (context) =>
      `| ${context.contextName ?? context.contextRoot} | ${context.sliceCount ?? 0} | ${context.supportDirectoryCount ?? 0} | ${context.singleSliceSupportFiles ?? 0} | ${context.driftCount ?? 0} |`,
  ),
  "",
];

if (breaches.length === 0) {
  lines.push("Budget status: within threshold.");
} else {
  lines.push("Budget status: threshold exceeded.");
  lines.push("");
  for (const breach of breaches) {
    lines.push(`- ${breach}`);
  }
}

const absoluteDashboardPath = path.resolve(repoRoot, dashboardPath);
mkdirSync(path.dirname(absoluteDashboardPath), { recursive: true });
writeFileSync(absoluteDashboardPath, `${lines.join("\n")}\n`, "utf8");

if (breaches.length > 0) {
  const header = budgetMode === "error" ? "Structure budget check failed:" : "Structure budget warning:";
  console.warn(header);
  for (const breach of breaches) {
    console.warn(`- ${breach}`);
  }

  if (budgetMode === "error") {
    process.exit(1);
  }
}

if (!structureCheckResult.ok) {
  process.exitCode = 1;
}

console.log(`Structure metrics dashboard written to ${dashboardPath}`);
