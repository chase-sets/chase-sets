import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRootDir = fileURLToPath(new URL("../", import.meta.url));

function isTargetRootLog(entry) {
  return /^\.codex-.*\.log$/u.test(entry.name) || entry.name.startsWith("tmp-public-web.log");
}

function toRepoPath(filePath) {
  return filePath.split(path.sep).join("/");
}

export function findLogCleanupTargets({ rootDir = defaultRootDir } = {}) {
  if (!existsSync(rootDir)) {
    return [];
  }

  const targets = [];

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.name === ".tmp" && entry.isDirectory()) {
      const tmpDir = path.join(rootDir, entry.name);
      for (const child of readdirSync(tmpDir, { withFileTypes: true })) {
        targets.push({
          fullPath: path.join(tmpDir, child.name),
          relativePath: toRepoPath(path.join(".tmp", child.name)),
        });
      }
      continue;
    }

    if (isTargetRootLog(entry) && (entry.isFile() || entry.isSymbolicLink())) {
      targets.push({
        fullPath: path.join(rootDir, entry.name),
        relativePath: entry.name,
      });
    }
  }

  return targets.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));
}

export function cleanLogs({ rootDir = defaultRootDir } = {}) {
  const targets = findLogCleanupTargets({ rootDir });

  for (const target of targets) {
    rmSync(target.fullPath, { force: true, recursive: true });
  }

  return targets.map((target) => target.relativePath);
}

function runCli() {
  const removed = cleanLogs();
  console.log(`Removed ${removed.length} log path${removed.length === 1 ? "" : "s"}.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli();
}
