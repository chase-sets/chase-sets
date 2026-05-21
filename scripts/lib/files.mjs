import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

export const defaultSkippedDirectories = new Set([
  ".git",
  ".react-router",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

export async function collectFiles(directory, options = {}) {
  const extensions = options.extensions ?? null;
  const skippedDirectories = options.skippedDirectories ?? defaultSkippedDirectories;

  if (!existsSync(directory)) {
    return [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        files.push(...(await collectFiles(fullPath, options)));
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!extensions || extensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}
