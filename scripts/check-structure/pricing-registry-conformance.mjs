import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { collectFiles, defaultSkippedDirectories } from "../lib/files.mjs";

// Every Pricing registry has a Conformance Kit run. A registry is found by its
// code shape, never by its name or path: a function whose own body (not a
// nested function) constructs a Map or Set and returns an object literal with a
// `register<Name>` member. A run is a `describeConformance({ registry })` call
// in a Pricing test file whose `registry` resolves, through imports and
// re-exports, to the factory. A production module that calls a factory
// registers entries there, so a run of that registry must import the module:
// the run then reads those entries instead of a hand-written list.

const contextRoot = "bounded-contexts/pricing";
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
  const resolveExport = (module, name, depth = 0) => {
    const facts = modules.get(module);
    if (!facts || depth > 8) return null;
    const localName = facts.exportedNames.get(name);
    if (localName !== undefined) {
      const imported = facts.imports.get(localName);
      return imported ? resolveExport(imported.module, imported.name, depth + 1) : `${module}#${localName}`;
    }
    const reExport = facts.reExports.get(name);
    return reExport ? resolveExport(reExport.module, reExport.name, depth + 1) : null;
  };

  const registries = [...modules].flatMap(([file, facts]) =>
    facts.registryDeclarations.map(({ name, line, exported }) => ({ id: `${file}#${name}`, line, exported })),
  );
  const registryIds = new Set(registries.map(({ id }) => id));
  const runs = [];
  const constructions = [];
  const violations = [];
  const specImports = new Map();
  for (const [file, facts] of modules) {
    const bindingTarget = (reference) => {
      const [head, member] = reference.split(".");
      const imported = facts.imports.get(head);
      if (member !== undefined) return imported?.name === "*" ? resolveExport(imported.module, member) : null;
      return facts.locals.get(head) ?? (imported ? resolveExport(imported.module, imported.name) : null);
    };
    if (isSpecFile(file)) {
      specImports.set(file, facts.importedModules);
      for (const call of facts.conformanceCalls) {
        const target = call.registry === null ? null : bindingTarget(call.registry);
        if (target !== null && registryIds.has(target)) runs.push({ file, registry: target });
        else
          violations.push(
            `${file}:${call.line}: describeConformance registry '${call.registry ?? "<missing>"}' does not resolve to a discovered Pricing registry.`,
          );
      }
    }
    if (isTestFile(file)) continue;
    for (const call of facts.calls) {
      const target = bindingTarget(call.callee);
      if (target !== null && registryIds.has(target)) constructions.push({ file, line: call.line, registry: target });
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
  for (const construction of constructions) {
    const runFiles = [...new Set(runs.filter((run) => run.registry === construction.registry).map((run) => run.file))];
    if (runFiles.length === 0 || runFiles.some((file) => specImports.get(file).has(construction.file))) continue;
    violations.push(
      `${construction.file}:${construction.line}: constructs Pricing registry '${construction.registry.split("#")[1]}' but no conformance run of that registry imports this module, so the entries registered here are never run; import it from the run in ${runFiles.join(", ")}.`,
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
  const importedModules = new Set();
  const reExports = new Map();
  const exportedNames = new Map();
  const locals = new Map();
  const registryDeclarations = [];
  const calls = [];
  const conformanceCalls = [];
  const conformanceNames = new Set();
  const importModule = (specifier) => {
    const resolved = resolveModule(file, specifier, sources);
    if (resolved) importedModules.add(resolved);
    return resolved;
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const module = importModule(statement.moduleSpecifier.text);
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const importedName = (element.propertyName ?? element.name).text;
          if (importedName === "describeConformance") conformanceNames.add(element.name.text);
          if (module) imports.set(element.name.text, { module, name: importedName });
        }
      } else if (bindings && ts.isNamespaceImport(bindings) && module) {
        imports.set(bindings.name.text, { module, name: "*" });
      }
    } else if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      const specifier = statement.moduleSpecifier;
      const module = specifier && ts.isStringLiteral(specifier) ? importModule(specifier.text) : null;
      for (const element of statement.exportClause.elements) {
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
        if (firstArgument && ts.isStringLiteralLike(firstArgument)) importModule(firstArgument.text);
      } else if (ts.isIdentifier(callee) && conformanceNames.has(callee.text)) {
        conformanceCalls.push({ line: lineOf(node), registry: registryArgument(firstArgument) });
      } else if (ts.isIdentifier(callee)) {
        calls.push({ callee: callee.text, line: lineOf(node) });
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        calls.push({ callee: `${callee.expression.text}.${callee.name.text}`, line: lineOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { imports, importedModules, reExports, exportedNames, locals, registryDeclarations, calls, conformanceCalls };
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
