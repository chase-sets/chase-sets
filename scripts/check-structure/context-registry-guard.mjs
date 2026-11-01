import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { listBoundedContextManifests, repoRoot } from "../lib/repo.mjs";

export const contextRegistryTargets = Object.freeze([
  {
    kind: "api",
    hostName: "platform-api",
    relativePath: "deployables/platform-api/src/context-registry.ts",
    exportName: "apiContextRegistry",
  },
  {
    kind: "worker",
    hostName: "platform-worker",
    relativePath: "deployables/platform-worker/src/context-registry.ts",
    exportName: "workerContextRegistry",
  },
  {
    kind: "web",
    hostName: "admin-web",
    relativePath: "deployables/admin-web/app/context-registry.ts",
    exportName: "webContextRegistry",
  },
  {
    kind: "web",
    hostName: "marketplace-web",
    relativePath: "deployables/marketplace/app/context-registry.ts",
    exportName: "webContextRegistry",
  },
  {
    kind: "web",
    hostName: "public-web",
    relativePath: "deployables/public-web/app/context-registry.ts",
    exportName: "webContextRegistry",
  },
]);
export const retiredContextRegistryPaths = Object.freeze([
  "deployables/platform-api/src/generated/api-context-registry.ts",
  "deployables/platform-worker/src/generated/worker-context-registry.ts",
  "deployables/admin-web/app/generated/web-context-registry.ts",
  "deployables/marketplace/app/generated/web-context-registry.ts",
  "deployables/public-web/app/generated/web-context-registry.ts",
  "infrastructure/platform-runtime/api-context-registry.generated.ts",
  "infrastructure/platform-runtime/web-context-registry.generated.ts",
]);

export const CONTEXT_REGISTRY_ADMISSION_ARMS = Object.freeze([
  Object.freeze({ kind: "api", name: "apiDeployables" }),
  Object.freeze({ kind: "api", name: "sourceRuntimeDeployables" }),
  Object.freeze({ kind: "api", name: "sourceRuntimeProfiles" }),
  Object.freeze({ kind: "worker", name: "runtimeDeployables" }),
  Object.freeze({ kind: "worker", name: "sourceRuntimeDeployables" }),
  Object.freeze({ kind: "worker", name: "sourceRuntimeProfiles" }),
  Object.freeze({ kind: "web", name: "deployableContributions" }),
  Object.freeze({ kind: "web", name: "shellContributions" }),
]);
export const registryArmNames = Object.freeze(CONTEXT_REGISTRY_ADMISSION_ARMS.map((arm) => `${arm.kind}:${arm.name}`));

function identifier(value) {
  const normalized = String(value).replace(/[^A-Za-z0-9_$]+(.)?/g, (_match, next) => (next ? next.toUpperCase() : ""));
  return normalized.replace(/^[^A-Za-z_$]+/, "") || "context";
}

function literalText(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function unwrap(node) {
  while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)))
    node = node.expression;
  return node;
}

function assertConstShape(initializer, target, file, errors, relativePath) {
  let expression = initializer;
  if (target.kind === "web") {
    if (!ts.isSatisfiesExpression(expression) || expression.type.getText(file) !== "WebContextRegistry") {
      fail(errors, `${relativePath} web registry must use 'satisfies WebContextRegistry'.`);
    }
    expression = expression.expression;
  } else if (ts.isSatisfiesExpression(expression)) {
    fail(errors, `${relativePath} registry must not use a satisfies assertion.`);
    expression = expression.expression;
  }
  if (!ts.isAsExpression(expression) || expression.type.getText(file) !== "const") {
    fail(errors, `${relativePath} registry must use 'as const'.`);
    return expression;
  }
  return expression.expression;
}

function fail(errors, message) {
  errors.push(message);
}

function parseRegistry(relativePath, target, rootDir) {
  const absolutePath = path.join(rootDir, relativePath);
  const source = readFileSync(absolutePath, "utf8");
  const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const errors = [];
  const imports = new Map();
  let registry;

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = literalText(statement.moduleSpecifier);
      if (!specifier) continue;
      const clause = statement.importClause;
      if (clause?.name) imports.set(clause.name.text, { specifier, kind: "default" });
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          imports.set(element.name.text, {
            specifier,
            kind: "named",
            imported: element.propertyName?.text ?? element.name.text,
          });
        }
      }
    }
    if (!ts.isVariableStatement(statement)) continue;
    const exported = statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const declaration = statement.declarationList.declarations.find(
      (candidate) => candidate.name.getText(file) === target.exportName,
    );
    if (exported && declaration) registry = declaration;
  }

  if (!registry) {
    fail(errors, `${relativePath} must export ${target.exportName}.`);
    return { errors };
  }
  if (!registry.initializer) {
    fail(errors, `${relativePath} registry must have an initializer.`);
    return { errors };
  }
  const array = assertConstShape(registry.initializer, target, file, errors, relativePath);
  if (!array || !ts.isArrayLiteralExpression(array)) {
    fail(errors, `${relativePath} registry must be an array literal.`);
    return { errors };
  }
  const entries = [];
  for (const [index, element] of array.elements.entries()) {
    if (ts.isSpreadElement(element)) {
      fail(errors, `${relativePath} entry ${index + 1} may not spread another registry.`);
      continue;
    }
    if (!ts.isObjectLiteralExpression(element)) {
      fail(errors, `${relativePath} entry ${index + 1} must be an object literal.`);
      continue;
    }
    const fields = new Map();
    const allowedFields =
      target.kind === "web"
        ? new Set(["contextName", "packageName", "manifest"])
        : new Set(["contextName", "packageName", "manifest", "module"]);
    for (const property of element.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
        fail(errors, `${relativePath} entry ${index + 1} has unsupported fields.`);
        continue;
      }
      if (!allowedFields.has(property.name.text))
        fail(errors, `${relativePath} entry ${index + 1} has an unexpected field '${property.name.text}'.`);
      fields.set(property.name.text, unwrap(property.initializer));
    }
    const contextName = literalText(fields.get("contextName"));
    const packageName = literalText(fields.get("packageName"));
    const manifest = fields.get("manifest");
    const module = fields.get("module");
    if (!contextName || !packageName || !manifest)
      fail(errors, `${relativePath} entry ${index + 1} has invalid identity fields.`);
    if (target.kind !== "web" && (!module || !ts.isIdentifier(module)))
      fail(errors, `${relativePath} entry ${index + 1} must retain module ownership.`);
    if (target.kind === "web" && !ts.isIdentifier(manifest))
      fail(errors, `${relativePath} web manifest is not a typed import.`);
    entries.push({
      contextName,
      packageName,
      manifestBinding: manifest?.getText?.(file),
      moduleBinding: module?.getText?.(file),
    });
  }
  return { errors, imports, entries };
}

function expectedContexts(contexts, target) {
  const admittedContexts = contexts.map((context) => {
    const contextName = context.contextName ?? context.manifest?.contextName;
    const packageName = context.packageName ?? context.manifest?.packageName;
    if (typeof contextName !== "string" || typeof packageName !== "string") {
      throw new TypeError("Admitted context must provide contextName and packageName.");
    }
    return { ...context, contextName, packageName };
  });

  return admittedContexts
    .filter(({ manifest }) => {
      if (target.kind === "api")
        return (
          manifest.apiDeployables?.includes(target.hostName) ||
          manifest.sourceRuntimeDeployables?.includes(target.hostName) ||
          (manifest.sourceRuntimeProfiles?.length ?? 0) > 0
        );
      if (target.kind === "worker")
        return (
          manifest.runtimeDeployables?.includes(target.hostName) ||
          manifest.sourceRuntimeDeployables?.includes(target.hostName) ||
          (manifest.sourceRuntimeProfiles?.length ?? 0) > 0
        );
      return (
        manifest.deployableContributions?.some((entry) => entry.deployable === target.hostName) ||
        manifest.shellContributions?.some((entry) => entry.deployable === target.hostName)
      );
    })
    .sort((left, right) => left.contextName.localeCompare(right.contextName, "en"))
    .map(({ contextName, packageName }) => ({ contextName, packageName }));
}

export function validateContextRegistries(rootDir = repoRoot, options = {}) {
  const contexts = options.contexts ?? listBoundedContextManifests({ repoRoot: rootDir });
  const errors = [];
  for (const relativePath of retiredContextRegistryPaths) {
    if (
      options.fs?.existsSync
        ? options.fs.existsSync(path.join(rootDir, relativePath))
        : readFileExists(path.join(rootDir, relativePath))
    ) {
      errors.push(`${relativePath} is a retired generated registry path.`);
    }
  }
  for (const target of contextRegistryTargets) {
    const result = parseRegistry(target.relativePath, target, rootDir);
    errors.push(...result.errors);
    if (!result.entries) continue;
    const expected = expectedContexts(contexts, target);
    if (
      JSON.stringify(result.entries.map(({ contextName, packageName }) => ({ contextName, packageName }))) !==
      JSON.stringify(expected)
    ) {
      errors.push(`${target.relativePath} membership/order does not match admitted context manifests.`);
    }
    for (const entry of result.entries) {
      const expectedImport = target.kind === "web" ? `${entry.packageName}/context` : entry.packageName;
      const binding = result.imports.get(
        `${identifier(entry.contextName)}${target.kind === "web" ? "Manifest" : "Manifest"}`,
      );
      if (!binding || binding.specifier !== expectedImport)
        errors.push(`${target.relativePath} import for ${entry.contextName} must come from ${expectedImport}.`);
      if (binding && target.kind !== "web" && (binding.kind !== "named" || binding.imported !== "contextManifest")) {
        errors.push(`${target.relativePath} manifest for ${entry.contextName} must import contextManifest.`);
      }
      if (target.kind !== "web") {
        const moduleBinding = result.imports.get(entry.moduleBinding);
        if (
          !moduleBinding ||
          moduleBinding.specifier !== expectedImport ||
          moduleBinding.kind !== "named" ||
          moduleBinding.imported !== "module"
        ) {
          errors.push(
            `${target.relativePath} module for ${entry.contextName} must import module from ${expectedImport}.`,
          );
        }
      }
    }
  }
  return errors;
}

function readFileExists(filePath) {
  try {
    readFileSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function runContextRegistryGuard(rootDir = repoRoot) {
  const errors = validateContextRegistries(rootDir);
  if (errors.length)
    throw new Error(["Context registry guard failed:", ...errors.map((error) => `- ${error}`)].join("\n"));
  return { checked: contextRegistryTargets.map((target) => target.relativePath), errors: [] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname))
  runContextRegistryGuard();
