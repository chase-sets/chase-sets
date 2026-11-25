import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import policy from "./tcgplayer-host-credential-policy.json" with { type: "json" };
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";

const guardFiles = new Set([
  "scripts/check-structure/tcgplayer-host-credential-guard.mjs",
  "scripts/check-structure/tcgplayer-host-credential-guard.test.mjs",
  "scripts/check-structure/tcgplayer-host-credential-policy.json",
]);
const hostPattern = /(?<![\w-])(?:[a-z0-9-]+\.)*tcgplayer\.com(?![\w-])/gi;
const credentialPattern = new RegExp(policy.credentialTokens.map(escapeRegExp).join("|"), "gi");
const browserPackage =
  /(?:^|\/)(?:(?:app-)?tcgplayer-(?:connector|operator)-extension|order-(?:authority|detection-pagination)-probe)(?:\/|$)/i;
const browserModule =
  /(?:^|\/)(?:tcgplayer-set-name-endpoint|live-export-authority|tcgplayer-live-export-executor)(?:\.[cm]?[jt]sx?)?$/i;
const browserSymbol = /\b(?:createTcgplayerLiveExportExecutor|liveExportAuthorityUrl|tcgplayerLiveExportAuthority)\b/;
const jsFile = /\.[cm]?[jt]sx?$/i;
const outboundCall =
  /(?:^|\.)(?:fetch|fetcher|fetchEndpoint)$|^(?:axios|http|https|undici|child_process)(?:\.(?:request|get|post|put|send|connect|exec|execFile|spawn))?$/;

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

function isRuntimeFile(file) {
  return (
    !(
      /\.(?:test|spec)\.[^.]+$|\.md$/i.test(file) ||
      /(?:^|\/)(?:__tests__|tests|fixtures|__fixtures__|e2e|docs)\//i.test(file)
    ) &&
    (/^(?:bounded-contexts|deployables|infrastructure|scripts|packages|contracts|\.github)\//.test(file) ||
      /^[^/]+\.(?:json|ya?ml|[cm]?[jt]sx?|sh|ps1)$|^Dockerfile(?:\.[^/]+)?$/i.test(file))
  );
}

function browserOnlyModule(specifier) {
  const normalized = specifier.replaceAll("\\", "/");
  return browserPackage.test(normalized) || browserModule.test(normalized);
}

function isOperatorRuntime(file) {
  return /^bounded-contexts\/catalog\/features\/operator-session\/(?:api|domain)\/|^deployables\/tcgplayer-operator-extension\/src\//.test(
    file,
  );
}

function codeViolations(file, text, activePolicy) {
  const diagnostics = [];
  const operator =
    isOperatorRuntime(file) || (activePolicy.hostExceptions[file] ?? []).some((line) => !line.startsWith("//"));
  const importAllowed = (specifier) => (activePolicy.browserImports[file] ?? []).includes(specifier);
  const possibleImport =
    /tcgplayer-(?:connector|operator)-extension|order-(?:authority|detection-pagination)-probe|tcgplayer-set-name-endpoint|live-export-(?:authority|executor)/i.test(
      text,
    ) || browserSymbol.test(text);
  if (!jsFile.test(file)) {
    if (possibleImport) {
      const commands = text.matchAll(
        /(?:^|[\s"';|&])(?:uses\s*:|node(?:\.exe)?\s|tsx\s|bun\s|deno\s|bash\s|sh\s|pwsh\s|powershell\s|python3?\s|\.\.?\/)[^\r\n;|&]*(?:\\\r?\n[^\r\n;|&]*)*/gim,
      );
      for (const command of commands) {
        const tokens = command[0].match(/[^\s"'`=,:()]+/g) ?? [];
        if (
          tokens.some(
            (token, index) =>
              !/\.(?:test|spec)\.[^.]+$/i.test(token) &&
              browserOnlyModule(token) &&
              (/[.][cm]?[jt]sx?$|^[./]|deployables\/|\/integrations\//i.test(token) ||
                /^(?:--import|--require|-r)$/.test(tokens[index - 1] ?? "")),
          )
        )
          diagnostics.push(
            `${file}:${lineNumber(text, command.index + command[0].search(/\S/))} extension-only module`,
          );
      }
      for (const match of text.matchAll(
        /(?:\bfrom\s*|\b(?:require|import)\s*\(\s*|\bimport\s*)["']([^"'\r\n]+)["']/g,
      )) {
        if (browserOnlyModule(match[1]) && !importAllowed(match[1]))
          diagnostics.push(`${file}:${lineNumber(text, match.index)} extension-only module`);
      }
    }
    return diagnostics;
  }
  if (!possibleImport && !operator) return diagnostics;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const report = (node, message) =>
    diagnostics.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${message}`);
  function visit(node) {
    if (possibleImport) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier;
        if (
          specifier &&
          ts.isStringLiteralLike(specifier) &&
          !importAllowed(specifier.text) &&
          (browserOnlyModule(specifier.text) ||
            (/(?:^|\/)channels\/client(?:\.[cm]?[jt]s)?$/.test(specifier.text) &&
              browserSymbol.test(node.getText(source))))
        )
          report(node, "extension-only module");
      } else if (ts.isCallExpression(node) && /^(?:import|(?:\w+\.)?require)$/.test(node.expression.getText(source))) {
        const specifier = node.arguments[0];
        if (
          specifier &&
          ts.isStringLiteralLike(specifier) &&
          !importAllowed(specifier.text) &&
          browserOnlyModule(specifier.text)
        )
          report(node, "extension-only module");
      } else if (
        ts.isExternalModuleReference(node) &&
        node.expression &&
        ts.isStringLiteralLike(node.expression) &&
        !importAllowed(node.expression.text) &&
        browserOnlyModule(node.expression.text)
      ) {
        report(node, "extension-only module");
      }
    }
    if (operator && ts.isCallExpression(node)) {
      const callee = node.expression.getText(source);
      if (
        outboundCall.test(callee) &&
        !(activePolicy.operatorOutboundTargets[file] ?? []).includes(node.arguments[0]?.getText(source))
      )
        report(node, "unapproved operator outbound target");
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return diagnostics;
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
    if (!isRuntimeFile(file)) continue;
    diagnostics.push(...codeViolations(file, text, activePolicy));
    let lines;
    const lineAt = (line) => (lines ??= text.split(/\r?\n/))[line - 1] ?? "";
    for (const match of text.matchAll(hostPattern)) {
      const line = lineNumber(text, match.index);
      const allowed =
        (activePolicy.hostExceptions[file] ?? []).includes(lineAt(line).trim()) ||
        (activePolicy.browserHosts[file] ?? []).includes(match[0].toLowerCase());
      if (!allowed) diagnostics.push(`${file}:${line} TCGplayer host`);
      inventory.push({
        rule: "host",
        file,
        line,
        symbol: allowed ? "allowed" : "denied",
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
