import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles, defaultSkippedDirectories } from "../lib/files.mjs";

// Every Pricing registry has a Conformance Kit run. A registry is found by its
// code shape, never by its name or path: a production (non-test) function
// whose own body (not a nested function) constructs a Map or Set and returns an
// object literal with a `register<Name>` member. A run is a call in a Pricing
// test file that resolves, through imports and re-exports, to the kit's
// `describeConformance`, with a `registry` that resolves to the factory. The
// run must `vi.mock` the factory's module through the kit's
// `recordRegistrations`; the kit then fails any entry production registers that
// the run does not exercise. A production module that calls a factory registers
// entries there, so a run of that registry must execute the module through
// value imports or re-exports.

const contextRoot = "bounded-contexts/pricing";
const kitExport = `${contextRoot}/tests/conformance/kit.ts#describeConformance`;
const harnessName = "describeConformance";
const sourceExtensions = new Set([".ts", ".tsx"]);
const moduleSuffixes = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const registerMemberPattern = /^register[A-Z0-9_]/;
const storeConstructors = new Set(["Map", "Set"]);
const guide = "bounded-contexts/pricing/docs/pricing-goal-authoring.md";

export async function validatePricingRegistryConformance({ repoRoot }) {
  const absoluteFiles = await collectFiles(path.join(repoRoot, contextRoot), {
    extensions: sourceExtensions,
    skippedDirectories: defaultSkippedDirectories,
  });
  const sources = new Map();
  for (const absolute of absoluteFiles.sort()) {
    const file = path.relative(repoRoot, absolute).replaceAll("\\", "/");
    const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    sources.set(file, ts.createSourceFile(file, await readFile(absolute, "utf8"), ts.ScriptTarget.Latest, true, kind));
  }
  const modules = new Map([...sources].map(([file, sourceFile]) => [file, moduleFacts(sourceFile, file, sources)]));
  // A local declaration or named re-export wins; otherwise each `export *` is
  // searched, and two different origins make the name ambiguous, as in ES modules.
  const resolveExport = (module, name, seen = new Set()) => {
    const facts = modules.get(module);
    if (!facts || seen.has(`${module}#${name}`)) return null;
    seen.add(`${module}#${name}`);
    const localName = facts.exportedNames.get(name);
    if (localName !== undefined) {
      const imported = facts.imports.get(localName);
      return imported ? resolveExport(imported.module, imported.name, seen) : `${module}#${localName}`;
    }
    const reExport = facts.reExports.get(name);
    if (reExport) return resolveExport(reExport.module, reExport.name, seen);
    if (name === "default") return null;
    const origins = new Set();
    for (const starModule of facts.starExports) {
      const origin = resolveExport(starModule, name, seen);
      if (origin !== null && typeof origin === "object") return origin;
      if (origin !== null) origins.add(origin);
    }
    if (origins.size <= 1) return [...origins][0] ?? null;
    return { ambiguous: [...origins].sort() };
  };
  const reachableFrom = (start) => {
    const reached = new Set([start]);
    for (const module of reached) for (const next of modules.get(module).executedModules) reached.add(next);
    return reached;
  };

  const registries = [...modules]
    .filter(([file]) => !isTestFile(file))
    .flatMap(([file, facts]) =>
      facts.registryDeclarations.map(({ name, line, exported }) => ({ id: `${file}#${name}`, line, exported })),
    );
  const registryIds = new Set(registries.map(({ id }) => id));
  const runs = [];
  const constructions = [];
  const violations = [];
  for (const [file, facts] of modules) {
    const bindingTarget = (reference) => {
      const [head, member] = reference.split(".");
      const imported = facts.imports.get(head);
      if (member !== undefined) return imported?.name === "*" ? resolveExport(imported.module, member) : null;
      return facts.locals.get(head) ?? (imported ? resolveExport(imported.module, imported.name) : null);
    };
    if (isSpecFile(file)) {
      for (const call of facts.calls) {
        const harness = bindingTarget(call.callee);
        if (harness !== kitExport) {
          const [head, member] = call.callee.split(".");
          if (member === harnessName || (member === undefined && facts.harnessAliases.has(head)))
            violations.push(
              `${file}:${call.line}: ${harnessName} resolves to '${describeTarget(harness)}', not the Conformance Kit export '${kitExport}', so this call runs nothing.`,
            );
          continue;
        }
        const reference = registryArgument(call.suite);
        const target = reference === null ? null : bindingTarget(reference);
        if (typeof target === "string" && registryIds.has(target)) {
          runs.push({ file, registry: target });
          const [factoryFile, name] = target.split("#");
          if (!facts.mockedModules.has(factoryFile))
            violations.push(
              `${file}:${call.line}: conformance run of '${name}' does not record its production registrations; vi.mock("${moduleSpecifier(file, factoryFile)}") through recordRegistrations from the kit so the run fails any registered entry it does not exercise (see ${guide}).`,
            );
        } else if (target?.ambiguous)
          violations.push(
            `${file}:${call.line}: ${harnessName} registry '${reference}' is ambiguous: export * provides it from ${target.ambiguous.join(", ")}.`,
          );
        else
          violations.push(
            `${file}:${call.line}: ${harnessName} registry '${reference ?? "<missing>"}' does not resolve to a discovered Pricing registry.`,
          );
      }
    }
    if (isTestFile(file)) continue;
    for (const call of facts.calls) {
      const target = bindingTarget(call.callee);
      if (typeof target === "string" && registryIds.has(target))
        constructions.push({ file, line: call.line, registry: target });
    }
  }

  if (registries.length === 0)
    violations.push(
      `${contextRoot}: discovered no Pricing registries; the conformance guard's shape no longer matches the code.`,
    );
  for (const { id, line, exported } of registries) {
    const [file, name] = id.split("#");
    if (!exported)
      violations.push(
        `${file}:${line}: Pricing registry '${name}' is not exported, so no conformance run can import it; export it and add a Conformance Kit run.`,
      );
    else if (!runs.some((run) => run.registry === id))
      violations.push(
        `${file}:${line}: Pricing registry '${name}' has no Conformance Kit run; call describeConformance({ registry: ${name}, ... }) from a Pricing test (see ${guide}).`,
      );
  }
  const reachable = new Map();
  for (const construction of constructions) {
    const runFiles = [...new Set(runs.filter((run) => run.registry === construction.registry).map((run) => run.file))];
    for (const file of runFiles) if (!reachable.has(file)) reachable.set(file, reachableFrom(file));
    if (runFiles.length === 0 || runFiles.some((file) => reachable.get(file).has(construction.file))) continue;
    violations.push(
      `${construction.file}:${construction.line}: constructs Pricing registry '${construction.registry.split("#")[1]}' but no conformance run of that registry executes this module through value imports or re-exports, so the entries registered here are never run; import it from the run in ${runFiles.join(", ")}.`,
    );
  }

  return {
    violations,
    registries,
    runs,
    constructions,
    discovery: { scannedFiles: sources.size, registries: registries.length, runs: runs.length },
  };
}

function isSpecFile(file) {
  return /\.test\.tsx?$/.test(file);
}

function isTestFile(file) {
  return isSpecFile(file) || file.split("/").includes("tests");
}

function describeTarget(target) {
  if (target === null) return "<unresolved>";
  return typeof target === "string" ? target : `ambiguous ${target.ambiguous.join(", ")}`;
}

function moduleSpecifier(fromFile, toFile) {
  const relative = path.posix.relative(path.posix.dirname(fromFile), toFile).replace(/\.tsx?$/, "");
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function lineOf(node) {
  const sourceFile = node.getSourceFile();
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function resolveModule(fromFile, specifier, sources) {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.join(path.posix.dirname(fromFile), specifier);
  return moduleSuffixes.map((suffix) => `${base}${suffix}`).find((candidate) => sources.has(candidate)) ?? null;
}

function moduleFacts(sourceFile, file, sources) {
  const imports = new Map();
  const executedModules = new Set();
  const valueImports = [];
  const reExports = new Map();
  const starExports = [];
  const exportedNames = new Map();
  const locals = new Map();
  const mockedModules = new Set();
  const harnessAliases = new Set([harnessName]);
  const registryDeclarations = [];
  const calls = [];

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly) continue;
      const module = resolveModule(file, statement.moduleSpecifier.text, sources);
      // The TypeScript transform drops an import none of whose value bindings is
      // used, so only a side-effect import or a used binding executes the module.
      const bindings = [];
      if (clause?.name) bindings.push(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        bindings.push(clause.namedBindings.name.text);
        if (module) imports.set(clause.namedBindings.name.text, { module, name: "*" });
      } else if (clause?.namedBindings) {
        for (const element of clause.namedBindings.elements) {
          if (element.isTypeOnly) continue;
          const importedName = (element.propertyName ?? element.name).text;
          if (importedName === harnessName) harnessAliases.add(element.name.text);
          bindings.push(element.name.text);
          if (module) imports.set(element.name.text, { module, name: importedName });
        }
      }
      if (module) valueImports.push({ module, bindings, sideEffect: clause === undefined });
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const specifier = statement.moduleSpecifier;
      const module = specifier && ts.isStringLiteral(specifier) ? resolveModule(file, specifier.text, sources) : null;
      const clause = statement.exportClause;
      const elements =
        clause && ts.isNamedExports(clause) ? clause.elements.filter((element) => !element.isTypeOnly) : [];
      if (module && (!clause || !ts.isNamedExports(clause) || elements.length > 0)) executedModules.add(module);
      if (!clause && module) starExports.push(module);
      for (const element of elements) {
        const sourceName = (element.propertyName ?? element.name).text;
        if (module) reExports.set(element.name.text, { module, name: sourceName });
        else if (!specifier) exportedNames.set(element.name.text, sourceName);
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      declare(statement.name.text, statement, statement, hasExportModifier(statement));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const initializer = declaration.initializer && unwrap(declaration.initializer);
        const functionNode =
          initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) ? initializer : null;
        declare(declaration.name.text, statement, functionNode, hasExportModifier(statement));
      }
    }
  }
  for (const localName of exportedNames.values()) {
    const declaration = registryDeclarations.find((entry) => entry.name === localName);
    if (declaration) declaration.exported = true;
  }

  function declare(name, statement, functionNode, exported) {
    locals.set(name, `${file}#${name}`);
    if (exported) exportedNames.set(name, name);
    if (functionNode && isRegistryShape(functionNode))
      registryDeclarations.push({ name, line: lineOf(statement), exported });
  }

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const [firstArgument] = node.arguments;
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        const module =
          firstArgument && ts.isStringLiteralLike(firstArgument)
            ? resolveModule(file, firstArgument.text, sources)
            : null;
        if (module) executedModules.add(module);
      } else if (ts.isIdentifier(callee)) {
        calls.push({ callee: callee.text, line: lineOf(node), suite: firstArgument });
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const reference = `${callee.expression.text}.${callee.name.text}`;
        if (reference === "vi.mock" && firstArgument && ts.isStringLiteralLike(firstArgument)) {
          const module = resolveModule(file, firstArgument.text, sources);
          if (module) mockedModules.add(module);
        } else calls.push({ callee: reference, line: lineOf(node), suite: firstArgument });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const usedValues = valueIdentifiers(sourceFile);
  for (const { module, bindings, sideEffect } of valueImports)
    if (sideEffect || bindings.some((binding) => usedValues.has(binding))) executedModules.add(module);

  return {
    imports,
    executedModules,
    reExports,
    starExports,
    exportedNames,
    locals,
    mockedModules,
    harnessAliases,
    registryDeclarations,
    calls,
  };
}

/** Identifiers read as values: type positions, imports and member or property names are skipped. */
function valueIdentifiers(sourceFile) {
  const names = new Set();
  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword)
    )
      return;
    if (ts.isExpressionWithTypeArguments(node)) return visit(node.expression);
    if (ts.isTypeNode(node)) return;
    if (ts.isIdentifier(node)) return void names.add(node.text);
    const memberName =
      ts.isPropertyAccessExpression(node) ||
      ts.isPropertyAssignment(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isPropertyDeclaration(node)
        ? node.name
        : null;
    ts.forEachChild(node, (child) => (child === memberName ? undefined : visit(child)));
  };
  visit(sourceFile);
  return names;
}

function registryArgument(suite) {
  if (!suite || !ts.isObjectLiteralExpression(suite)) return null;
  const property = suite.properties.find(
    (candidate) => candidate.name && ts.isIdentifier(candidate.name) && candidate.name.text === "registry",
  );
  if (property && ts.isShorthandPropertyAssignment(property)) return property.name.text;
  if (!property || !ts.isPropertyAssignment(property)) return null;
  const value = unwrap(property.initializer);
  if (ts.isIdentifier(value)) return value.text;
  if (ts.isPropertyAccessExpression(value) && ts.isIdentifier(value.expression))
    return `${value.expression.text}.${value.name.text}`;
  return null;
}

/** Own-body store construction plus a returned object literal exposing a `register<Name>` member. */
function isRegistryShape(functionNode) {
  let constructsStore = false;
  let exposesRegister = false;
  const inspectReturned = (expression) => {
    const value = expression && unwrap(expression);
    if (value && ts.isObjectLiteralExpression(value))
      exposesRegister ||= value.properties.some(
        (property) => property.name && ts.isIdentifier(property.name) && registerMemberPattern.test(property.name.text),
      );
  };
  const visit = (node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && storeConstructors.has(node.expression.text))
      constructsStore = true;
    if (ts.isReturnStatement(node)) inspectReturned(node.expression);
    ts.forEachChild(node, visit);
  };
  if (!functionNode.body) return false;
  if (ts.isBlock(functionNode.body)) ts.forEachChild(functionNode.body, visit);
  else inspectReturned(functionNode.body);
  return constructsStore && exposesRegister;
}

function unwrap(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  )
    current = current.expression;
  return current;
}

function hasExportModifier(statement) {
  return (ts.getModifiers(statement) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}
