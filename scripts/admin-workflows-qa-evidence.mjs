#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizeString, readEnv, readOption } from "./lib/cli-options.mjs";
import { writeJsonRecord } from "./lib/output-file.mjs";

export const ADMIN_WORKFLOWS_QA_EVIDENCE_VERSION = "admin-workflows-qa-evidence/v1";

export const ADMIN_WORKFLOWS_QA_REDACTION_CATEGORIES = Object.freeze([
  "email",
  "cookie_or_session",
  "authorization_token",
  "raw_recovery_token",
  "raw_domain_id",
  "full_url",
]);

const CATEGORY_PATTERNS = Object.freeze({
  email: [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi],
  cookie_or_session: [
    /\b(?:cookie|set-cookie)\s*[:=]\s*\S+/gi,
    /\bchase_sets_[A-Za-z0-9_-]+\s*=\s*[^;\s]+/gi,
    /\b(?:session|csrf|xsrf)[-_]?(?:token|cookie|id)?\s*[:=]\s*[A-Za-z0-9._~+/-]{8,}/gi,
  ],
  authorization_token: [
    /\bauthorization\s*[:=]\s*(?:Bearer\s+)?[A-Za-z0-9._~+/-]{8,}/gi,
    /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/gi,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  ],
  raw_recovery_token: [
    /\b(?:afterWrite|postWriteToken|readAfterWrite|read_after_write)=\S+/gi,
    /\bChase-Sets-Read-After-Write\s*[:=]\s*\S+/gi,
  ],
  raw_domain_id: [
    /\b(?:account|acct|user|usr|membership|member|mbr|invitation|invite|api_key|apikey|session|sess|checkout|chk|payment|pay|payout|order|ord|sale|shipment|ship|label|inventory|inv|listing|lst|offer|ofr|cart|crt|event|evt|job|bulk|provider|profile)_[0-9A-Za-z][0-9A-Za-z_:-]{3,}\b/g,
  ],
  full_url: [/\bhttps?:\/\/[^\s<>)"']+/gi],
});

export function parseAdminWorkflowsQaEvidenceArgs(argv, env = process.env) {
  const envEvidenceFiles = splitEvidenceFiles(readEnv("ADMIN_WORKFLOWS_QA_EVIDENCE_FILES", env));
  return {
    evidenceFiles: [...readEvidenceFileOptions(argv), ...envEvidenceFiles],
    outPath: readOption(argv, "--out") ?? readEnv("ADMIN_WORKFLOWS_QA_EVIDENCE_OUT", env),
    environment: readOption(argv, "--environment") ?? readEnv("ADMIN_WORKFLOWS_QA_ENVIRONMENT", env) ?? "staging",
    issue: readOption(argv, "--issue") ?? readEnv("ADMIN_WORKFLOWS_QA_ISSUE", env) ?? "3027",
    checkedAt: readOption(argv, "--checked-at") ?? new Date().toISOString(),
  };
}

export async function runAdminWorkflowsQaEvidence(options) {
  const files = normalizeEvidenceFiles(options.evidenceFiles);
  if (files.length === 0) {
    throw new Error("At least one --evidence-file is required.");
  }

  const evidenceFiles = [];
  for (const filePath of files) {
    evidenceFiles.push({
      path: filePath,
      content: await readFile(filePath, "utf8"),
    });
  }

  const evidence = buildAdminWorkflowsQaEvidence({
    ...options,
    evidenceFiles,
  });

  if (options.outPath) {
    await writeJsonRecord(options.outPath, evidence);
  }

  return evidence;
}

export function buildAdminWorkflowsQaEvidence(input) {
  const fileResults = input.evidenceFiles.map(({ path, content }) => {
    const findings = findAdminWorkflowsQaEvidenceFindings(content);
    return {
      path: supportSafePath(path),
      lineCount: content.split(/\r?\n/).length,
      status: findings.length === 0 ? "pass" : "fail",
      findings,
    };
  });
  const summary = summarizeFindings(fileResults);
  const totalFindings = Object.values(summary).reduce((total, count) => total + count, 0);

  return {
    schemaVersion: ADMIN_WORKFLOWS_QA_EVIDENCE_VERSION,
    checkedAt: input.checkedAt,
    environment: normalizeString(input.environment) ?? "staging",
    issue: normalizeIssue(input.issue),
    verdict: totalFindings === 0 ? "pass" : "fail",
    summary,
    files: fileResults,
    guidance:
      totalFindings === 0
        ? ["Evidence is support-safe for public GitHub issue comments under the admin-workflows QA redaction policy."]
        : [
            "Replace raw values with actor aliases, route templates, support-safe artifact references, and issue/PR numbers before posting publicly.",
          ],
    redaction: {
      emails: "never-recorded",
      cookies: "never-recorded",
      sessionTokens: "never-recorded",
      authorizationHeaders: "never-recorded",
      rawIds: "never-recorded",
      afterWrite: "never-recorded",
      postWriteToken: "never-recorded",
      fullUrls: "never-recorded",
    },
  };
}

export function findAdminWorkflowsQaEvidenceFindings(content) {
  const findings = [];
  const lines = String(content).split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const category of ADMIN_WORKFLOWS_QA_REDACTION_CATEGORIES) {
      const count = countCategoryMatches(line, category);
      if (count > 0) {
        findings.push({
          category,
          line: index + 1,
          count,
          severity: "blocker",
        });
      }
    }
  });
  return findings;
}

function countCategoryMatches(line, category) {
  for (const pattern of CATEGORY_PATTERNS[category] ?? []) {
    if (new RegExp(pattern.source, pattern.flags).test(line)) {
      return 1;
    }
  }
  return 0;
}

function summarizeFindings(fileResults) {
  const summary = Object.fromEntries(ADMIN_WORKFLOWS_QA_REDACTION_CATEGORIES.map((category) => [category, 0]));
  for (const fileResult of fileResults) {
    for (const finding of fileResult.findings) {
      summary[finding.category] += finding.count;
    }
  }
  return summary;
}

function normalizeEvidenceFiles(paths) {
  return [...new Set(paths.map((path) => normalizeString(path)).filter(Boolean))];
}

function splitEvidenceFiles(value) {
  if (!value) {
    return [];
  }
  return value
    .split(/[;,]/)
    .map((path) => path.trim())
    .filter(Boolean);
}

function supportSafePath(path) {
  if (isAbsolute(path)) {
    const relativePath = relative(process.cwd(), path).replaceAll("\\", "/");
    if (!relativePath.startsWith("..") && !relativePath.startsWith("/") && !relativePath.includes(":")) {
      return relativePath;
    }
    return basename(path);
  }
  const relativePath = relative(process.cwd(), path).replaceAll("\\", "/");
  if (!relativePath.startsWith("..") && !relativePath.startsWith("/") && relativePath !== "") {
    return relativePath;
  }
  return basename(path);
}

function readEvidenceFileOptions(argv) {
  const files = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (
      (argv[index] === "--evidence-file" || argv[index] === "--file") &&
      argv[index + 1] &&
      !argv[index + 1].startsWith("--")
    ) {
      files.push(argv[index + 1]);
      index += 1;
    }
  }
  return files;
}

function normalizeIssue(value) {
  const issue = normalizeString(value) ?? "3027";
  return issue.startsWith("#") ? issue : `#${issue}`;
}

async function main(argv, env = process.env) {
  try {
    const evidence = await runAdminWorkflowsQaEvidence(parseAdminWorkflowsQaEvidenceArgs(argv, env));
    console.log(JSON.stringify(evidence, null, 2));
    return evidence.verdict === "pass" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
