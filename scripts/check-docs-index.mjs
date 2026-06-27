import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { normalizePath, normalizeRelative, repoRoot } from "./lib/repo.mjs";

const indexRelativePaths = ["README.md", "docs/README.md"];
const docsRootRelativePath = "docs";
const markdownLinkPattern = /\[[^\]]+\]\(([^)]+)\)/g;

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

  return { orphanDocs };
}

async function main() {
  const { orphanDocs } = await checkDocsIndex();
  if (orphanDocs.length > 0) {
    throw new Error(`docs index is missing ${orphanDocs.length} Markdown file(s):\n${orphanDocs.join("\n")}`);
  }

  console.log("Docs index covers all docs Markdown files.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
