import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles } from "./lib/files.mjs";
import { normalizeRelative, repoRoot, workspaceRoots } from "./lib/repo.mjs";

const canonicalTsconfigNames = new Set(["tsconfig.base.json", "tsconfig.vitest.json"]);

function jsonExtensionPath(value) {
  return value.endsWith(".json") ? value : `${value}.json`;
}

function resolveExtendsTarget(configPath, extendsValue) {
  if (typeof extendsValue !== "string" || !extendsValue.startsWith(".")) {
    return null;
  }

  return path.resolve(path.dirname(configPath), jsonExtensionPath(extendsValue));
}

function readJsoncConfig(filePath, content) {
  const parsed = ts.parseConfigFileTextToJson(filePath, content);
  if (parsed.error) {
    return {
      config: null,
      error: ts.flattenDiagnosticMessageText(parsed.error.messageText, "\n"),
    };
  }

  return { config: parsed.config, error: null };
}

async function listWorkspaceTsconfigFiles(rootDir, roots) {
  const files = await Promise.all(
    roots.map((workspaceRoot) => collectFiles(path.join(rootDir, workspaceRoot), { extensions: new Set([".json"]) })),
  );

  return files
    .flat()
    .filter((filePath) => path.basename(filePath) === "tsconfig.json")
    .sort((left, right) => normalizeRelative(left, rootDir).localeCompare(normalizeRelative(right, rootDir), "en"));
}

function validateConfig(options) {
  const { config, filePath, rootDir } = options;
  const relativeFile = normalizeRelative(filePath, rootDir);
  const violations = [];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return [`${relativeFile}: tsconfig must parse to an object.`];
  }

  if (typeof config.extends !== "string") {
    return [`${relativeFile}: workspace tsconfigs must extend root tsconfig.base.json or tsconfig.vitest.json.`];
  }

  const target = resolveExtendsTarget(filePath, config.extends);
  const canonicalTarget = target ? path.basename(target) : null;
  const canonicalRootTarget = target ? path.dirname(target) === path.resolve(rootDir) : false;

  if (!target || !canonicalRootTarget || !canonicalTsconfigNames.has(canonicalTarget)) {
    violations.push(
      `${relativeFile}: extends ${config.extends}; workspace tsconfigs must extend root tsconfig.base.json or tsconfig.vitest.json.`,
    );
  }

  const types = config.compilerOptions?.types;
  if (Array.isArray(types) && types.includes("vitest/globals")) {
    if (canonicalTarget !== "tsconfig.vitest.json") {
      violations.push(`${relativeFile}: vitest globals must come from tsconfig.vitest.json.`);
    }

    if (types.length === 1) {
      violations.push(`${relativeFile}: replace compilerOptions.types ["vitest/globals"] with tsconfig.vitest.json.`);
    }
  }

  return violations;
}

export async function checkWorkspaceTsconfigExtends(options = {}) {
  const rootDir = path.resolve(options.repoRoot ?? repoRoot);
  const roots = options.workspaceRoots ?? workspaceRoots;
  const violations = [];
  const canonicalConfigs = [...canonicalTsconfigNames].map((configName) => path.join(rootDir, configName));

  for (const canonicalConfig of canonicalConfigs) {
    if (!existsSync(canonicalConfig)) {
      violations.push(`${normalizeRelative(canonicalConfig, rootDir)}: canonical tsconfig root is missing.`);
    }
  }

  const files = await listWorkspaceTsconfigFiles(rootDir, roots);

  for (const filePath of files) {
    const content = await ts.sys.readFile(filePath);
    if (typeof content !== "string") {
      violations.push(`${normalizeRelative(filePath, rootDir)}: unable to read tsconfig.`);
      continue;
    }

    const { config, error } = readJsoncConfig(filePath, content);
    if (error) {
      violations.push(`${normalizeRelative(filePath, rootDir)}: invalid JSONC: ${error}`);
      continue;
    }

    violations.push(...validateConfig({ config, filePath, rootDir }));
  }

  return {
    passed: violations.length === 0,
    files: files.map((filePath) => normalizeRelative(filePath, rootDir)),
    violations,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkWorkspaceTsconfigExtends();

  if (!result.passed) {
    console.error("Workspace tsconfig extends check failed:");
    for (const violation of result.violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log(`Workspace tsconfig extends check passed for ${result.files.length} files.`);
}
