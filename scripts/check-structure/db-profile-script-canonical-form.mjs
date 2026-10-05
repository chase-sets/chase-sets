import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { defineBoundedContextTestConfig, defineWorkspaceTestConfig } from "../../vitest.shared.mjs";
import { listWorkspacePackages, repoRoot as defaultRepoRoot } from "../lib/repo.mjs";
import { validateDurationHintRegistry } from "../run-workspaces.mjs";

function profileConfigPath(fileName, workspaceRoot) {
  const directory =
    workspaceRoot && path.basename(path.dirname(path.resolve(workspaceRoot))) === "bounded-contexts" ? "tests/" : "";
  return `${directory}${fileName}`;
}

export function unitProfileConfigPath(workspaceRoot) {
  return profileConfigPath("vitest.unit.config.mjs", workspaceRoot);
}

export function dbProfileConfigPath(scriptName, workspaceRoot) {
  if (scriptName === "test:db") return profileConfigPath("vitest.db.config.mjs", workspaceRoot);
  if (/^test:db:[1-9]\d*$/.test(scriptName))
    return profileConfigPath(`vitest.db.${scriptName.split(":").at(-1)}.config.mjs`, workspaceRoot);
  throw new Error(`unsupported DB execution unit ${scriptName}; expected test:db or test:db:<number>`);
}

export function canonicalDbProfileCommand(scriptName, workspaceRoot) {
  return `vitest run --config ./${dbProfileConfigPath(scriptName, workspaceRoot)}`;
}

function literal(node, label) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((element) => literal(element, label));
  if (ts.isObjectLiteralExpression(node)) {
    const value = Object.create(null);
    for (const property of node.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name))
      ) {
        throw new Error(`${label}: configuration must be declarative`);
      }
      if (Object.hasOwn(value, property.name.text)) throw new Error(`${label}: duplicate ${property.name.text}`);
      value[property.name.text] = literal(property.initializer, label);
    }
    return value;
  }
  throw new Error(`${label}: configuration must use literal values`);
}

function globs(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (glob) =>
        typeof glob !== "string" ||
        !/\.test\.tsx?$/.test(glob) ||
        glob.startsWith("/") ||
        glob.split("/").includes("..") ||
        /[\\{}()!\[\]]/.test(glob),
    )
  ) {
    throw new Error(`${label}: expected nonempty relative include globs in the supported *, **, ? dialect`);
  }
  return value;
}

// Interpret only the shared factories' declarative selection contract. Never
// import a workspace config: structural discovery must not start test setup.
export function readTestSelectionConfig(configPath, active = new Set(), cache = new Map()) {
  const file = path.resolve(configPath);
  if (cache.has(file)) return cache.get(file);
  if (active.has(file)) throw new Error(`${file}: cyclic config import`);
  active.add(file);
  try {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    if (source.parseDiagnostics.length) throw new Error(`${file}: malformed config`);
    const imports = new Map();
    let expression;
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
        const clause = statement.importClause;
        if (clause?.name) imports.set(clause.name.text, { module: statement.moduleSpecifier.text, name: "default" });
        for (const specifier of clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements
          : []) {
          imports.set(specifier.name.text, {
            module: statement.moduleSpecifier.text,
            name: specifier.propertyName?.text ?? specifier.name.text,
          });
        }
      } else if (ts.isExportAssignment(statement) && !statement.isExportEquals && !expression) {
        expression = statement.expression;
      } else {
        throw new Error(`${file}: expected imports and one declarative default factory call`);
      }
    }
    if (!expression || !ts.isCallExpression(expression) || !ts.isIdentifier(expression.expression)) {
      throw new Error(`${file}: expected a shared test-config factory`);
    }
    const factory = imports.get(expression.expression.text);
    if (
      !factory ||
      path.resolve(path.dirname(file), factory.module) !== path.resolve(defaultRepoRoot, "vitest.shared.mjs")
    )
      throw new Error(`${file}: expected a shared test-config factory`);
    const args = expression.arguments;
    const importedConfig = (node) => {
      const binding = node && ts.isIdentifier(node) ? imports.get(node.text) : null;
      if (!binding || binding.name !== "default" || !binding.module.startsWith("."))
        throw new Error(`${file}: expected a relative default config import`);
      return readTestSelectionConfig(path.resolve(path.dirname(file), binding.module), active, cache);
    };
    if (factory.name === "defineDbTestConfig") {
      if (args.length < 2 || args.length > 3)
        throw new Error(`${file}: expected base config, include globs and optional setup/worker overrides`);
      const base = importedConfig(args[0]);
      if (base.kind !== "base") throw new Error(`${file}: DB config must import an unfiltered shared base config`);
      const include = globs(literal(args[1], file), file);
      const overrides = args[2] ? literal(args[2], file) : {};
      if (Object.keys(overrides).some((key) => !["maxWorkers", "globalSetup"].includes(key)))
        throw new Error(`${file}: DB membership cannot be overridden or excluded`);
      const result = {
        ...base,
        include,
        ...overrides,
        globalSetup: [...base.globalSetup, ...(overrides.globalSetup ?? [])],
        kind: "db",
        configPath: file,
        baseConfigPath: base.configPath,
      };
      cache.set(file, result);
      return result;
    }
    if (factory.name === "defineUnitTestConfig") {
      if (args.length !== 2) throw new Error(`${file}: expected base and DB config`);
      const base = importedConfig(args[0]);
      const db = importedConfig(args[1]);
      if (db.kind !== "db") throw new Error(`${file}: complement must import a DB config`);
      if (base.configPath !== db.baseConfigPath)
        throw new Error(`${file}: complement and DB must share the same base config`);
      const result = { ...base, exclude: [...base.exclude, ...db.include], kind: "unit", configPath: file };
      cache.set(file, result);
      return result;
    }
    if (!["defineWorkspaceTestConfig", "defineBoundedContextTestConfig"].includes(factory.name) || args.length > 1)
      throw new Error(`${file}: unsupported test-config factory`);
    const defaults =
      factory.name === "defineWorkspaceTestConfig"
        ? defineWorkspaceTestConfig().test
        : defineBoundedContextTestConfig().test;
    // Vite plugins and aliases do not select tests. The test object does, and
    // must be literal; no spread, computed property or executable override.
    const options = args[0];
    if (options && !ts.isObjectLiteralExpression(options))
      throw new Error(`${file}: expected literal config overrides`);
    let test = {};
    const keys = new Set();
    for (const property of options?.properties ?? []) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || keys.has(property.name.text))
        throw new Error(`${file}: unsupported config override`);
      keys.add(property.name.text);
      if (property.name.text === "test") test = literal(property.initializer, file);
      else if (!["plugins", "resolve"].includes(property.name.text))
        throw new Error(`${file}: unsupported Vite option ${property.name.text}`);
    }
    if (
      Object.keys(test).some(
        (key) =>
          ![
            "include",
            "exclude",
            "globalSetup",
            "setupFiles",
            "fileParallelism",
            "testTimeout",
            "hookTimeout",
            "environment",
            "globals",
            "pool",
            "maxWorkers",
            "css",
          ].includes(key),
      )
    )
      throw new Error(`${file}: unsupported test-selection option`);
    const result = {
      ...defaults,
      ...test,
      include: globs(test.include ?? defaults.include, file),
      exclude: [...defaults.exclude, ...(test.exclude ?? [])],
      globalSetup: [...defaults.globalSetup, ...(test.globalSetup ?? [])],
      kind: "base",
      configPath: file,
    };
    cache.set(file, result);
    return result;
  } finally {
    active.delete(file);
  }
}

export function listTestFiles(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const files = [];
  const directoryExcludes = defineWorkspaceTestConfig().test.exclude.filter((glob) => glob.endsWith("/**"));
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = path.relative(root, path.join(directory, entry.name)).replaceAll("\\", "/");
      if (directoryExcludes.some((glob) => path.matchesGlob(`${relativePath}/__inventory_entry__`, glob))) continue;
      if (entry.isSymbolicLink())
        throw new Error(`${path.join(directory, entry.name)}: symlink prevents complete test inventory`);
      if (entry.isDirectory()) {
        visit(path.join(directory, entry.name));
      } else if (entry.isFile() && /\.test\.tsx?$/.test(entry.name))
        files.push(path.relative(root, path.join(directory, entry.name)).replaceAll("\\", "/"));
    }
  }
  visit(root);
  return files.sort();
}

export function discoverConfigTests(
  workspaceRoot,
  configPath,
  files = listTestFiles(workspaceRoot),
  cache = new Map(),
) {
  const config = readTestSelectionConfig(path.resolve(workspaceRoot, configPath), new Set(), cache);
  const matches = (file, patterns) => patterns.some((glob) => path.matchesGlob(file, glob));
  return { config, files: files.filter((file) => matches(file, config.include) && !matches(file, config.exclude)) };
}

// Script strings are deliberately absent from this interface. Consumers pass
// the numbered unit identities selected by the existing workspace runner.
export function discoverDbProfile(workspaceRoot, unitNames = []) {
  const files = listTestFiles(workspaceRoot);
  const cache = new Map();
  const discover = (configPath) => discoverConfigTests(workspaceRoot, configPath, files, cache);
  const aggregate = discover(dbProfileConfigPath("test:db", workspaceRoot));
  if (aggregate.config.kind !== "db") throw new Error("aggregate must use defineDbTestConfig");
  const base = discover(aggregate.config.baseConfigPath);
  const units = (unitNames.length ? unitNames : ["test:db"]).map((name) => ({
    name,
    ...discover(dbProfileConfigPath(name, workspaceRoot)),
  }));
  const violations = [];
  const membership = new Map();
  for (const unit of units) {
    if (unit.config.baseConfigPath !== aggregate.config.baseConfigPath)
      violations.push(`${unit.name}: DB units must share the aggregate base config`);
    if (unit.config.kind !== "db" || !unit.files.length) violations.push(`${unit.name}: expected a nonempty DB config`);
    for (const file of unit.files) membership.set(file, [...(membership.get(file) ?? []), unit.name]);
  }
  if (!aggregate.files.length) violations.push("aggregate DB profile must remain nonempty");
  if (
    aggregate.config.include.some((glob) => !/\.db\.test\.tsx?$/.test(glob)) &&
    JSON.stringify(aggregate.files) !== JSON.stringify(base.files)
  ) {
    violations.push("exceptional non-suffix DB profile must retain every base-config test suite");
  }
  for (const file of files.filter((file) => /\.db\.test\.tsx?$/.test(file))) {
    if (!aggregate.files.includes(file))
      violations.push(`${file}: DB glob file omitted or excluded by aggregate config`);
  }
  for (const file of new Set([...aggregate.files, ...membership.keys()])) {
    const owners = membership.get(file) ?? [];
    if (!aggregate.files.includes(file) || owners.length !== 1)
      violations.push(
        `${file}: must belong to aggregate and exactly one runner-selected DB unit; found ${owners.join(", ") || "none"}`,
      );
  }
  const unit = discover(unitProfileConfigPath(workspaceRoot));
  const expected = base.files.filter((file) => !aggregate.files.includes(file));
  if (unit.config.kind !== "unit") violations.push("unit config must use defineUnitTestConfig");
  for (const file of unit.files)
    if (aggregate.files.includes(file)) violations.push(`${file}: DB file leaks into unit complement`);
  if (JSON.stringify(unit.files) !== JSON.stringify(expected))
    violations.push("unit selection must be the complete DB complement");
  return { files, aggregate, units, unit, violations };
}

export function validateDbProfileScripts(workspace) {
  const scripts = workspace.packageJson.scripts ?? {};
  const profile = workspace.packageJson.chaseSets?.testProfile;
  const names = Object.keys(scripts).filter((name) => name.startsWith("test:db"));
  const violations = [];
  if (profile !== undefined && !["db", "unit"].includes(profile))
    violations.push(`${workspace.name}: unsupported testProfile ${profile}; expected db or unit`);
  if (profile !== "db") {
    if (names.length) violations.push(`${workspace.name}: DB commands require testProfile db`);
    return { violations, inventory: null };
  }
  for (const name of new Set(["test:db", ...names])) {
    try {
      const expected = canonicalDbProfileCommand(name, workspace.dir);
      if (scripts[name] !== expected)
        violations.push(`${workspace.name} ${name}: expected canonical form '${expected}'`);
    } catch (error) {
      violations.push(`${workspace.name}: ${error.message}`);
    }
  }
  for (const name of ["test:unit", "test", "test:fast", "test:watch"]) {
    if (name !== "test:unit" && scripts[name] === undefined) continue;
    const expected = `vitest${name === "test:watch" ? "" : " run"} --config ./${unitProfileConfigPath(workspace.dir)}`;
    if (scripts[name] !== expected) violations.push(`${workspace.name} ${name}: expected canonical form '${expected}'`);
  }
  let inventory = null;
  try {
    inventory = discoverDbProfile(
      workspace.dir,
      names.filter((name) => /^test:db:[1-9]\d*$/.test(name)),
    );
    violations.push(...inventory.violations.map((violation) => `${workspace.name}: ${violation}`));
  } catch (error) {
    violations.push(
      `${workspace.name}: cannot derive DB execution; ${error.message}; expected canonical config '${dbProfileConfigPath("test:db", workspace.dir)}'`,
    );
  }
  return { violations, inventory };
}

export function validateDbProfiles({
  repoRoot = defaultRepoRoot,
  workspaces = listWorkspacePackages({
    repoRoot,
    onSkippedWorkspace: ({ packageJsonPath, reason }) => {
      throw new Error(`${packageJsonPath}: ${reason}`);
    },
  }),
} = {}) {
  const violations = [];
  const inventory = [];
  for (const workspace of workspaces) {
    const result = validateDbProfileScripts(workspace);
    violations.push(...result.violations);
    if (result.inventory) inventory.push({ workspace: workspace.name, ...result.inventory });
  }
  try {
    const registry = JSON.parse(
      readFileSync(path.join(repoRoot, "scripts/workspace-test-duration-hints-v1.json"), "utf8"),
    );
    validateDurationHintRegistry(registry, workspaces);
    for (const workspace of workspaces) {
      const script = workspace.packageJson.chaseSets?.testProfile === "db" ? "test:unit" : "test";
      if (
        workspace.packageJson.scripts?.[script] &&
        !registry.entries.some((entry) => entry.workspace === workspace.name && entry.script === script)
      )
        violations.push(`${workspace.name} ${script}: missing duration owner`);
    }
  } catch (error) {
    violations.push(`duration ownership: ${error.message}`);
  }
  return { violations, inventory, scanned: workspaces.length, total: workspaces.length };
}
