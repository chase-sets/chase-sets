import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import policy from "./tcgplayer-host-credential-policy.json" with { type: "json" };
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";

const guardFiles = new Set([
  "scripts/check-structure/tcgplayer-host-credential-guard.mjs",
  "scripts/check-structure/tcgplayer-host-credential-guard.test.mjs",
  "scripts/check-structure/tcgplayer-host-credential-policy.json",
]);
const hostPattern = /(?:[a-z0-9-]+\.)*tcgplayer\.com/gi;
const hostLiteral = /tcgplayer\.com/i;
const credentialPattern = new RegExp(policy.credentialTokens.map(escapeRegExp).join("|"), "gi");

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function lineNumber(text, index) {
  return text.slice(0, index).split(/\r?\n/).length;
}

function trackedFiles(repoRoot) {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: GIT_LISTING_MAX_BUFFER,
  })
    .split("\0")
    .filter(Boolean);
}

function isRule2File(file) {
  const normalized = file.replaceAll("\\", "/");
  if (
    normalized.startsWith("bounded-contexts/") &&
    !/\.(?:test|spec)\.[^.]+$/i.test(normalized) &&
    !/(?:^|\/)(?:tests|fixtures|__fixtures__|docs)(?:\/|$)/i.test(normalized) &&
    !normalized.endsWith(".md")
  )
    return true;
  return (
    normalized.startsWith("deployables/platform-") ||
    normalized.startsWith("infrastructure/") ||
    normalized.startsWith(".github/workflows/") ||
    normalized.startsWith(".github/authority/")
  );
}

function hostAllowed(file, line, activePolicy = policy) {
  const normalized = file.replaceAll("\\", "/");
  if (
    activePolicy.excludedHostPaths.includes(normalized) ||
    activePolicy.excludedHostPrefixes.some((prefix) => normalized.startsWith(prefix))
  )
    return true;
  const exceptions = activePolicy.hostExceptions[normalized] ?? [];
  if (exceptions.includes("sourceUrl") && /\bsourceUrl\s*[:=]/.test(line)) return true;
  if (exceptions.includes("citation-comment") && /^\s*\/\//.test(line)) return true;
  return false;
}

function credentialAllowed(file, token, activePolicy = policy) {
  const allowed = activePolicy.credentialExceptions[file.replaceAll("\\", "/")];
  const canonical =
    policy.credentialTokens.find((candidate) => candidate.toLowerCase() === token.toLowerCase()) ?? token;
  return Array.isArray(allowed) && allowed.includes(canonical);
}

export function validateTcgplayerHostCredentialPolicy({
  repoRoot,
  files = trackedFiles(repoRoot),
  contents,
  policy: activePolicy = policy,
} = {}) {
  const diagnostics = [];
  const inventory = [];
  const sortedFiles = [...new Set(files.map((file) => file.replaceAll("\\", "/")))].sort();
  for (const file of sortedFiles) {
    if (guardFiles.has(file)) continue;
    const text = contents?.[file] ?? "";
    for (const match of text.matchAll(credentialPattern)) {
      const token = match[0];
      if (
        token.toLowerCase() === "chrome.cookies" &&
        !/^deployables\/(?:tcgplayer-connector-extension|tcgplayer-operator-extension)\//.test(file) &&
        !file.startsWith("bounded-contexts/channels/features/connector-client/integrations/")
      )
        continue;
      const canonicalToken =
        policy.credentialTokens.find((candidate) => candidate.toLowerCase() === token.toLowerCase()) ?? token;
      if (!credentialAllowed(file, token, activePolicy))
        diagnostics.push(`${file}:${lineNumber(text, match.index)} credential token ${canonicalToken}`);
      inventory.push({ rule: "credential", file, line: lineNumber(text, match.index), token });
    }
    if (!isRule2File(file) || !hostLiteral.test(text)) continue;
    let lines;
    const lineAt = (line) => (lines ??= text.split(/\r?\n/))[line - 1] ?? "";
    for (const match of text.matchAll(hostPattern)) {
      const line = lineAt(lineNumber(text, match.index));
      if (!hostAllowed(file, line, activePolicy))
        diagnostics.push(`${file}:${lineNumber(text, match.index)} TCGplayer host`);
      inventory.push({
        rule: "host",
        file,
        line: lineNumber(text, match.index),
        symbol: hostAllowed(file, line, activePolicy) ? "allowed" : "denied",
      });
    }
  }
  const sanitized = diagnostics.slice().sort();
  const digest = createHash("sha256")
    .update(JSON.stringify(inventory.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))))
    .digest("hex");
  return { violations: sanitized, diagnostics: sanitized, inventory, digest };
}

export async function scanTcgplayerHostCredentialPolicy({ repoRoot, files = trackedFiles(repoRoot) } = {}) {
  const pairs = [];
  for (let offset = 0; offset < files.length; offset += 64) {
    pairs.push(
      ...(await Promise.all(
        files
          .slice(offset, offset + 64)
          .map(async (file) => [file.replaceAll("\\", "/"), await readFile(path.join(repoRoot, file), "utf8")]),
      )),
    );
  }
  const contents = Object.fromEntries(pairs);
  return validateTcgplayerHostCredentialPolicy({ repoRoot, files, contents });
}

export { policy };
