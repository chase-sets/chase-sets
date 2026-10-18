#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const DEPENDENCY_AUDIT_SCHEMA_VERSION = "dependency-audit/v1";
export const AUDIT_COMMAND = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
export const AUDIT_ARGS = Object.freeze(["audit", "--json"]);

const SEVERITY_ORDER = Object.freeze({ critical: 0, high: 1, moderate: 2, low: 3, info: 4, unknown: 5 });

export function parseReleaseHealthDependencyAuditArgs(argv, env = process.env) {
  return {
    outPath: readOption(argv, "--out") ?? readEnv("RELEASE_HEALTH_DEPENDENCY_AUDIT_OUT", env),
    markdownOutPath:
      readOption(argv, "--markdown-out") ?? readEnv("RELEASE_HEALTH_DEPENDENCY_AUDIT_MARKDOWN_OUT", env),
    githubOutputPath: readOption(argv, "--github-output") ?? readEnv("GITHUB_OUTPUT", env),
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
    runAudit: undefined,
  };
}

export function normalizeAuditAdvisories(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("audit payload must be an object.");
  }
  const rawAdvisories = payload.advisories;
  if (!(Array.isArray(rawAdvisories) || (rawAdvisories && typeof rawAdvisories === "object"))) {
    throw new Error("audit payload advisories must be an object or array.");
  }

  const entries = Array.isArray(rawAdvisories)
    ? rawAdvisories.map((advisory, index) => [String(index), advisory])
    : Object.entries(rawAdvisories);
  return entries.map(([key, advisory]) => {
    if (!advisory || typeof advisory !== "object" || Array.isArray(advisory)) {
      throw new Error(`audit advisory ${key} must be an object.`);
    }
    const findings = advisory.findings ?? [];
    if (!Array.isArray(findings)) {
      throw new Error(`audit advisory ${key} findings must be an array.`);
    }
    const normalizedFindings = findings.map((finding, index) => {
      if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
        throw new Error(`audit advisory ${key} finding ${index} must be an object.`);
      }
      return {
        version: typeof finding.version === "string" ? finding.version : "unknown",
        dev: finding.dev === true,
        optional: finding.optional === true,
        bundled: finding.bundled === true,
        paths: Array.isArray(finding.paths) ? finding.paths.filter((path) => typeof path === "string") : [],
      };
    });
    const severity = normalizeSeverity(advisory.severity);
    return {
      module: stringOrUnknown(advisory.module_name ?? advisory.module ?? key),
      severity,
      ghsa: stringOrUnknown(advisory.github_advisory_id ?? advisory.ghsa ?? "unknown"),
      patchedRange: stringOrUnknown(advisory.patched_versions ?? advisory.patchedRange ?? "unknown"),
      findings: normalizedFindings,
    };
  });
}

export function classifyDependencyAudit({ exitCode, stdout = "", stderr = "", checkedAt = new Date().toISOString() }) {
  const text = typeof stdout === "string" ? stdout.trim() : "";
  const errorText = typeof stderr === "string" ? stderr.trim() : "";
  if (!text) {
    return buildWarningRecord({
      checkedAt,
      exitCode,
      errorClass: exitCode === 1 && !errorText ? "registry-error" : "empty-output",
      errorMessage: errorText || "pnpm audit returned no JSON output.",
    });
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    return buildWarningRecord({
      checkedAt,
      exitCode,
      errorClass: "malformed-json",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  let advisories;
  try {
    advisories = normalizeAuditAdvisories(payload);
  } catch (error) {
    return buildWarningRecord({
      checkedAt,
      exitCode,
      errorClass: "invalid-shape",
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  const sortedAdvisories = advisories.sort(compareAdvisories);
  const alertingAdvisories = sortedAdvisories.filter(isAlertingAdvisory);
  const productionAdvisories = sortedAdvisories.filter((advisory) =>
    advisory.findings.some((finding) => finding.dev === false),
  );
  const result = alertingAdvisories.length > 0 ? "failure" : "success";
  return {
    schemaVersion: DEPENDENCY_AUDIT_SCHEMA_VERSION,
    checkedAt,
    command: [AUDIT_COMMAND, ...AUDIT_ARGS].join(" "),
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    result,
    alertStatus: result,
    error: null,
    summary: {
      advisoryCount: sortedAdvisories.length,
      productionAdvisoryCount: productionAdvisories.length,
      alertingAdvisoryCount: alertingAdvisories.length,
    },
    advisories: sortedAdvisories,
  };
}

export function renderDependencyAuditMarkdown(record) {
  const lines = [
    "## Dependency audit",
    "",
    `- Result: ${record.result}`,
    `- Alert status: ${record.alertStatus}`,
    `- Advisories: ${record.summary?.advisoryCount ?? 0}`,
    `- Production advisories: ${record.summary?.productionAdvisoryCount ?? 0}`,
    `- Alerting advisories: ${record.summary?.alertingAdvisoryCount ?? 0}`,
  ];
  if (record.error) {
    lines.push(`- Error class: ${record.error.class}`, `- Error: ${record.error.message}`);
  }
  const advisories = Array.isArray(record.advisories) ? record.advisories : [];
  if (!advisories.length) {
    lines.push("", "No advisories found.");
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    "",
    "### Advisories",
    "",
    "| Module | Installed versions | GHSA ID | Severity | Patched range | Production finding |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const advisory of advisories) {
    const versions = [...new Set(advisory.findings.map((finding) => finding.version))].sort();
    const production = advisory.findings.some((finding) => finding.dev === false) ? "yes" : "no";
    lines.push(
      `| ${markdownCell(advisory.module)} | ${markdownCell(versions.join(", ") || "unknown")} | ${markdownCell(advisory.ghsa)} | ${markdownCell(advisory.severity)} | ${markdownCell(advisory.patchedRange)} | ${production} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function runPnpmAudit({ spawnImpl = spawnSync } = {}) {
  const result = spawnImpl(AUDIT_COMMAND, AUDIT_ARGS, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    exitCode: Number.isInteger(result?.status) ? result.status : null,
    stdout: typeof result?.stdout === "string" ? result.stdout : "",
    stderr: typeof result?.stderr === "string" ? result.stderr : "",
    error: result?.error instanceof Error ? result.error : null,
  };
}

export async function runReleaseHealthDependencyAudit(options) {
  const commandResult = options.runAudit ? await options.runAudit() : runPnpmAudit();
  const record = commandResult.error
    ? buildWarningRecord({
        checkedAt: options.checkedAt,
        exitCode: commandResult.exitCode,
        errorClass: "command-error",
        errorMessage: commandResult.error.message,
      })
    : classifyDependencyAudit({ ...commandResult, checkedAt: options.checkedAt });
  const markdown = renderDependencyAuditMarkdown(record);
  if (options.outPath) await writeJsonRecord(options.outPath, record);
  if (options.markdownOutPath) {
    await mkdir(dirname(options.markdownOutPath), { recursive: true });
    await writeFile(options.markdownOutPath, markdown);
  }
  if (options.githubOutputPath) {
    await writeFile(options.githubOutputPath, `alert_status=${record.alertStatus}\n`, { flag: "a" });
  }
  return { record, markdown };
}

function buildWarningRecord({ checkedAt, exitCode, errorClass, errorMessage }) {
  return {
    schemaVersion: DEPENDENCY_AUDIT_SCHEMA_VERSION,
    checkedAt,
    command: [AUDIT_COMMAND, ...AUDIT_ARGS].join(" "),
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    result: "warning",
    alertStatus: "warning",
    error: { class: errorClass, message: errorMessage },
    summary: { advisoryCount: 0, productionAdvisoryCount: 0, alertingAdvisoryCount: 0 },
    advisories: [],
  };
}

function isAlertingAdvisory(advisory) {
  return ["high", "critical"].includes(advisory.severity) && advisory.findings.some((finding) => finding.dev === false);
}

function compareAdvisories(left, right) {
  return (
    (SEVERITY_ORDER[left.severity] ?? SEVERITY_ORDER.unknown) - (SEVERITY_ORDER[right.severity] ?? SEVERITY_ORDER.unknown) ||
    left.module.localeCompare(right.module) ||
    left.ghsa.localeCompare(right.ghsa)
  );
}

function normalizeSeverity(value) {
  const severity = typeof value === "string" ? value.trim().toLowerCase() : "unknown";
  return Object.hasOwn(SEVERITY_ORDER, severity) ? severity : "unknown";
}

function stringOrUnknown(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function markdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

async function main(argv, env = process.env) {
  try {
    const result = await runReleaseHealthDependencyAudit(parseReleaseHealthDependencyAuditArgs(argv, env));
    process.stdout.write(result.markdown);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
