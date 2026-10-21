import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const TEST_FILE_PATTERN = /\.test\.tsx?$/u;
const DB_FILE_PATTERN = /\.db\.test\.tsx?$/u;
const DB_SCRIPT_PATTERN = /^test:db:/u;

function normalize(value) {
  return value.replaceAll("\\", "/");
}

function scriptPaths(script) {
  return [...script.matchAll(/(?:^|\s)([^\s]+\.test\.tsx?)(?=\s|$)/gu)].map((match) => normalize(match[1]));
}

function excludedPaths(script) {
  return [...script.matchAll(/(?:^|\s)--exclude\s+([^\s]+)/gu)].map((match) => normalize(match[1]));
}

function vitestFiles(catalogRoot, excludes = []) {
  const pnpm = process.platform === "win32" ? "pnpm.exe" : "pnpm";
  const args = ["exec", "vitest", "list", "--filesOnly", "--config", "./tests/vitest.config.mjs"];
  for (const exclude of excludes) args.push("--exclude", exclude);
  const output = execFileSync(pnpm, args, {
    cwd: catalogRoot,
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output
    .split(/\r?\n/u)
    .map((line) => normalize(line.trim()))
    .filter((line) => TEST_FILE_PATTERN.test(line));
}

export async function inspectCatalogUnitManifest(catalogRoot, packagePath = path.join(catalogRoot, "package.json")) {
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const scripts = packageJson.scripts ?? {};
  const unitScript = scripts["test:unit"];
  if (typeof unitScript !== "string") throw new Error("Catalog test:unit script is missing.");

  const files = vitestFiles(catalogRoot).sort();
  const fileSet = new Set(files);
  const excluded = excludedPaths(unitScript);
  const excludedSet = new Set(excluded);
  const duplicateExcludes = excluded.filter((file, index) => excluded.indexOf(file) !== index);
  const missingExcludes = excluded.filter((file) => !fileSet.has(file));
  const dbFiles = files.filter((file) => DB_FILE_PATTERN.test(file));
  const dbScriptEntries = Object.entries(scripts)
    .filter(([name]) => DB_SCRIPT_PATTERN.test(name))
    .flatMap(([, script]) => scriptPaths(script));
  const dbCounts = new Map(dbFiles.map((file) => [file, dbScriptEntries.filter((entry) => entry === file).length]));
  const dbNotExcluded = dbFiles.filter((file) => !excludedSet.has(file));
  const dbNotEnrolled = dbFiles.filter((file) => dbCounts.get(file) !== 1);
  const selected = vitestFiles(catalogRoot, excluded).sort();

  const errors = [];
  if (duplicateExcludes.length > 0) errors.push(`duplicate exclusions: ${[...new Set(duplicateExcludes)].join(", ")}`);
  if (missingExcludes.length > 0) errors.push(`missing exclusion files: ${missingExcludes.join(", ")}`);
  if (dbNotExcluded.length > 0) errors.push(`DB files selected by unit: ${dbNotExcluded.join(", ")}`);
  if (dbNotEnrolled.length > 0) errors.push(`DB files not enrolled exactly once: ${dbNotEnrolled.join(", ")}`);

  return {
    errors,
    totalFiles: files.length,
    excludedFiles: excluded.length,
    selectedFiles: selected.length,
    dbFiles: dbFiles.length,
    dbScriptEntries,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const catalogRoot = path.resolve(process.argv[2] ?? path.resolve(import.meta.dirname, ".."));
  const packagePath = process.argv[3] ? path.resolve(process.argv[3]) : path.join(catalogRoot, "package.json");
  const result = await inspectCatalogUnitManifest(catalogRoot, packagePath);
  console.log(
    `CATALOG_UNIT_MANIFEST ${JSON.stringify({
      totalFiles: result.totalFiles,
      excludedFiles: result.excludedFiles,
      selectedFiles: result.selectedFiles,
      dbFiles: result.dbFiles,
    })}`,
  );
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`CATALOG_UNIT_MANIFEST_ERROR ${error}`);
    process.exitCode = 1;
  }
}
