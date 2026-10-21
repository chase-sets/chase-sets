import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

export const KB_REFERENCE_RATCHET_MODE = "warn";

function normalizeFile(file) {
  return String(file).replaceAll("\\", "/").replace(/^\.\//, "");
}

export function userFacingSliceForFile(file) {
  const normalized = normalizeFile(file);
  const featureMatch = /^bounded-contexts\/([^/]+)\/features\/([^/]+)\/(?:ui|routes)\//.exec(normalized);
  if (featureMatch) return `${featureMatch[1]}/${featureMatch[2]}`;
  const routeMatch = /^bounded-contexts\/([^/]+)\/routes\/(?:marketplace|public)\//.exec(normalized);
  if (routeMatch) return `${routeMatch[1]}/routes`;
  return null;
}

export function hasKbDeclaration(body) {
  return /^\s*kb\s*:\s*(?:n\/?a|https?:\/\/\S+|\/\S+|#\d+)\s*$/im.test(String(body ?? ""));
}

export function evaluateKbReferenceRatchet({ changedFiles, body, mode = KB_REFERENCE_RATCHET_MODE }) {
  const slices = [...new Set(changedFiles.map(userFacingSliceForFile).filter(Boolean))].sort();
  if (slices.length === 0 || hasKbDeclaration(body)) return { ok: true, warnings: [], slices };
  const message =
    `user-facing slices changed without a PR/issue body declaration (KB: /help/..., KB: #issue, or KB: n/a): ` +
    slices.join(", ");
  return { ok: mode !== "block", warnings: [message], slices };
}

function gitFiles(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" })
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function loadPullRequestBody() {
  if (process.env.GITHUB_EVENT_PATH && existsSync(process.env.GITHUB_EVENT_PATH)) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    return event.pull_request?.body ?? event.issue?.body ?? "";
  }
  return process.env.KB_REFERENCE_BODY ?? "";
}

function loadChangedFiles() {
  return [
    ...new Set([
      ...gitFiles(["diff", "--name-only"]),
      ...gitFiles(["diff", "--cached", "--name-only"]),
      ...gitFiles(["diff", "--name-only", "origin/main...HEAD"]),
    ]),
  ];
}

function main() {
  const mode = process.env.KB_REFERENCE_RATCHET_MODE ?? KB_REFERENCE_RATCHET_MODE;
  const result = evaluateKbReferenceRatchet({ changedFiles: loadChangedFiles(), body: loadPullRequestBody(), mode });
  for (const warning of result.warnings) console.warn(`KB reference ratchet (${mode}): ${warning}`);
  if (result.warnings.length === 0) console.log("KB reference ratchet passed.");
  if (!result.ok) process.exitCode = 1;
}

if (path.basename(process.argv[1] ?? "") === "kb-reference-ratchet.mjs") main();
