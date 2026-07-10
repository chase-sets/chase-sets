import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { collectFiles } from "./lib/files.mjs";
import { normalizePath, normalizeRelative, repoRoot } from "./lib/repo.mjs";

const indexRelativePaths = ["README.md", "docs/README.md"];
const docsRootRelativePath = "docs";
const contextDocsRootRelativePath = "bounded-contexts";
const markdownLinkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
const contextDocReferenceFileExtensions = new Set([".md", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"]);
const contextDocAcceptedReferenceKinds =
  "a link from its context README, a link from another Markdown file, or a mention in a code/test/config file";
const pushWakeGlossaryTerms = [
  "Wake Intent",
  "Projection Wake Relay",
  "Projection Interest Index",
  "Source-Context Wake Registry",
  "Platform Work-Signal Composite",
];

async function walkMarkdownFiles(rootDir) {
  const results = [];

  async function visit(dir) {
    if (!existsSync(dir)) {
      return;
    }

    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(normalizeRelative(entryPath, rootDir));
      }
    }
  }

  await visit(path.join(rootDir, docsRootRelativePath));
  return results.sort((left, right) => left.localeCompare(right, "en"));
}

function normalizeMarkdownLinkTarget(linkTarget, sourceRelativePath) {
  const withoutAnchor = linkTarget.split("#")[0].split("?")[0];
  if (
    withoutAnchor.length === 0 ||
    withoutAnchor.startsWith("http://") ||
    withoutAnchor.startsWith("https://") ||
    withoutAnchor.startsWith("mailto:") ||
    withoutAnchor.startsWith("/")
  ) {
    return null;
  }

  const sourceDir = path.dirname(sourceRelativePath);
  return normalizePath(path.normalize(path.join(sourceDir, withoutAnchor)));
}

function linkedMarkdownTargets(content, sourceRelativePath) {
  const targets = [];

  for (const match of content.matchAll(markdownLinkPattern)) {
    const target = normalizeMarkdownLinkTarget(match[1], sourceRelativePath);
    if (target?.startsWith("docs/") && target.endsWith(".md")) {
      targets.push(target);
    }
  }

  return targets;
}

export async function checkDocsIndex(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const allDocs = new Set(await walkMarkdownFiles(rootDir));
  const queue = [...indexRelativePaths];
  const reachable = new Set();

  for (const indexPath of indexRelativePaths) {
    if (!existsSync(path.join(rootDir, indexPath))) {
      throw new Error(`${indexPath} is missing`);
    }
  }

  while (queue.length > 0) {
    const sourceRelativePath = queue.shift();
    if (reachable.has(sourceRelativePath)) {
      continue;
    }

    reachable.add(sourceRelativePath);
    const sourcePath = path.join(rootDir, sourceRelativePath);
    if (!existsSync(sourcePath)) {
      continue;
    }

    const content = readFileSync(sourcePath, "utf8");
    for (const target of linkedMarkdownTargets(content, sourceRelativePath)) {
      if (allDocs.has(target) && !reachable.has(target)) {
        queue.push(target);
      }
    }
  }

  const orphanDocs = [...allDocs].filter((docPath) => docPath !== "docs/README.md" && !reachable.has(docPath));

  const proseAccuracyIssues = checkProseAccuracy(rootDir);

  return { orphanDocs, proseAccuracyIssues };
}

async function walkContextDocs(rootDir) {
  const contextsDir = path.join(rootDir, contextDocsRootRelativePath);
  if (!existsSync(contextsDir)) {
    return [];
  }

  const results = [];
  for (const contextEntry of await readdir(contextsDir, { withFileTypes: true })) {
    if (!contextEntry.isDirectory()) {
      continue;
    }

    const docsDir = path.join(contextsDir, contextEntry.name, "docs");
    if (!existsSync(docsDir)) {
      continue;
    }

    for (const entry of await readdir(docsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(normalizeRelative(path.join(docsDir, entry.name), rootDir));
      }
    }
  }

  return results.sort((left, right) => left.localeCompare(right, "en"));
}

// A bounded-context doc counts as referenced when its filename is mentioned by any other
// Markdown file (a context README link or another doc's cross-link) or by any code/test/config
// file (a runtime or test reference). This mirrors the exhaustive reference mapping the 2026-07-02
// documentation audit used to find orphaned context docs by hand.
export async function checkContextDocReferences(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const contextDocs = await walkContextDocs(rootDir);

  if (contextDocs.length === 0) {
    return { orphanContextDocs: [] };
  }

  const relativePathByBasename = new Map(
    contextDocs.map((relativePath) => [path.basename(relativePath), relativePath]),
  );
  const referencedBasenames = new Set();

  const candidateFiles = await collectFiles(rootDir, { extensions: contextDocReferenceFileExtensions });

  for (const filePath of candidateFiles) {
    if (relativePathByBasename.size === referencedBasenames.size) {
      break;
    }

    const fileRelativePath = normalizeRelative(filePath, rootDir);
    const content = readFileSync(filePath, "utf8");

    for (const [basename, docRelativePath] of relativePathByBasename) {
      if (referencedBasenames.has(basename) || fileRelativePath === docRelativePath) {
        continue;
      }

      if (content.includes(basename)) {
        referencedBasenames.add(basename);
      }
    }
  }

  const orphanContextDocs = contextDocs.filter((relativePath) => !referencedBasenames.has(path.basename(relativePath)));

  return { orphanContextDocs };
}

function readOptional(rootDir, relativePath) {
  const filePath = path.join(rootDir, relativePath);
  if (!existsSync(filePath)) {
    return null;
  }

  return readFileSync(filePath, "utf8");
}

function checkProseAccuracy(rootDir) {
  const issues = [];
  const glossary = readOptional(rootDir, "docs/GLOSSARY.md");
  const environmentDomainNames = readOptional(rootDir, "docs/architecture/environment-domain-names.md");
  const digitalOceanRunbook = readOptional(rootDir, "docs/runbooks/digitalocean-platform-deployment.md");

  if (glossary) {
    for (const term of pushWakeGlossaryTerms) {
      if (!glossary.includes(`| ${term} |`)) {
        issues.push(`docs/GLOSSARY.md is missing push-wake glossary term: ${term}`);
      }
    }
  }

  if (environmentDomainNames) {
    for (const incidentMarker of ["May 17, 2026", "May 26, 2026", "DomainZoneInvalid", "DomainCNAMEMismatch"]) {
      if (environmentDomainNames.includes(incidentMarker)) {
        issues.push(
          `docs/architecture/environment-domain-names.md still contains DNS incident marker: ${incidentMarker}`,
        );
      }
    }

    if (!environmentDomainNames.includes("Pre-launch conditional: production proof mode")) {
      issues.push(
        "docs/architecture/environment-domain-names.md must mark production proof routing as pre-launch conditional",
      );
    }
  }

  if (digitalOceanRunbook) {
    for (const runbookMarker of ["### Staging DNS Operations", "May 17, 2026", "May 26, 2026"]) {
      if (!digitalOceanRunbook.includes(runbookMarker)) {
        issues.push(
          `docs/runbooks/digitalocean-platform-deployment.md is missing DNS operations marker: ${runbookMarker}`,
        );
      }
    }
  }

  return issues;
}

async function main() {
  const { orphanDocs, proseAccuracyIssues } = await checkDocsIndex();
  if (orphanDocs.length > 0) {
    throw new Error(`docs index is missing ${orphanDocs.length} Markdown file(s):\n${orphanDocs.join("\n")}`);
  }

  if (proseAccuracyIssues.length > 0) {
    throw new Error(
      `docs prose accuracy guard found ${proseAccuracyIssues.length} issue(s):\n${proseAccuracyIssues.join("\n")}`,
    );
  }

  const { orphanContextDocs } = await checkContextDocReferences();
  if (orphanContextDocs.length > 0) {
    throw new Error(
      `${orphanContextDocs.length} bounded-context doc(s) have no inbound reference. Every ` +
        `bounded-contexts/*/docs/*.md file needs ${contextDocAcceptedReferenceKinds}:\n` +
        orphanContextDocs.join("\n"),
    );
  }

  console.log("Docs index covers all docs Markdown files.");
  console.log("Every bounded-context doc has at least one inbound reference.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
