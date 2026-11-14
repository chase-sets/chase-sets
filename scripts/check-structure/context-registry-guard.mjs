import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import {
  CONTEXT_REGISTRY_HOST_ARMS,
  contextManifestContributesToHost,
  listBoundedContextManifests,
  repoRoot as defaultRepoRoot,
} from "../lib/repo.mjs";

// The five hand-authored context registries. Membership and order come only
// from bounded-context admission (scripts/lib/repo.mjs); each registry is
// parsed, never evaluated, and no registry text is generated to compare with.
export const CONTEXT_REGISTRIES = Object.freeze(
  [
    {
      path: "deployables/platform-api/src/context-registry.ts",
      exportName: "apiContextRegistry",
      registryKind: "api",
      hostName: "platform-api",
    },
    {
      path: "deployables/platform-worker/src/context-registry.ts",
      exportName: "workerContextRegistry",
      registryKind: "worker",
      hostName: "platform-worker",
    },
    {
      path: "deployables/admin-web/app/context-registry.ts",
      exportName: "webContextRegistry",
      registryKind: "web",
      hostName: "admin-web",
    },
    {
      path: "deployables/marketplace/app/context-registry.ts",
      exportName: "webContextRegistry",
      registryKind: "web",
      hostName: "marketplace-web",
    },
    {
      path: "deployables/public-web/app/context-registry.ts",
      exportName: "webContextRegistry",
      registryKind: "web",
      hostName: "public-web",
    },
  ].map((registry) => Object.freeze(registry)),
);

export const RETIRED_CONTEXT_REGISTRY_PATHS = Object.freeze([
  "deployables/platform-api/src/generated/api-context-registry.ts",
  "deployables/platform-worker/src/generated/worker-context-registry.ts",
  "deployables/admin-web/app/generated/web-context-registry.ts",
  "deployables/marketplace/app/generated/web-context-registry.ts",
  "deployables/public-web/app/generated/web-context-registry.ts",
  "infrastructure/platform-runtime/api-context-registry.generated.ts",
  "infrastructure/platform-runtime/web-context-registry.generated.ts",
]);

const webRegistryTypeSource = "@chase-sets/platform-runtime/web";
const webRegistryTypeName = "WebContextRegistry";

function hasModifier(node, kind) {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function modifierKinds(node) {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []).map((modifier) => modifier.kind) : [];
}

function isConstTypeReference(node) {
  return ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === "const";
}

function isWebRegistryTypeReference(node) {
  return (
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    node.typeName.text === webRegistryTypeName &&
    !node.typeArguments
  );
}

// `WebContextRegistry[number]["manifest"]`, matched structurally.
function isWebManifestElementType(node) {
  return (
    ts.isIndexedAccessTypeNode(node) &&
    ts.isLiteralTypeNode(node.indexType) &&
    ts.isStringLiteral(node.indexType.literal) &&
    node.indexType.literal.text === "manifest" &&
    ts.isIndexedAccessTypeNode(node.objectType) &&
    node.objectType.indexType.kind === ts.SyntaxKind.NumberKeyword &&
    isWebRegistryTypeReference(node.objectType.objectType)
  );
}

function unwrapToArray(expression) {
  let current = expression;
  while (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current)) {
    current = current.expression;
  }
  return ts.isArrayLiteralExpression(current) ? current : null;
}

function exactExportShape(initializer, registryKind) {
  if (registryKind !== "web") {
    return (
      ts.isAsExpression(initializer) &&
      isConstTypeReference(initializer.type) &&
      ts.isArrayLiteralExpression(initializer.expression)
    );
  }
  return (
    ts.isSatisfiesExpression(initializer) &&
    isWebRegistryTypeReference(initializer.type) &&
    ts.isAsExpression(initializer.expression) &&
    isConstTypeReference(initializer.expression.type) &&
    ts.isArrayLiteralExpression(initializer.expression.expression)
  );
}

function describeExpectedShape(registry) {
  return registry.registryKind === "web"
    ? `export const ${registry.exportName} = [...] as const satisfies ${webRegistryTypeName};`
    : `export const ${registry.exportName} = [...] as const;`;
}

function findDynamicImports(sourceFile) {
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      found.push(argument && ts.isStringLiteralLike(argument) ? argument.text : "(non-literal specifier)");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function readImport(statement, registry, report) {
  const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : null;
  const clause = statement.importClause;
  if (!specifier || !clause || statement.attributes) {
    report(`unsupported import form${specifier ? ` from "${specifier}"` : ""}`);
    return [];
  }

  if (registry.registryKind === "web") {
    if (clause.isTypeOnly) {
      const named = clause.namedBindings;
      const exactTypeImport =
        specifier === webRegistryTypeSource &&
        !clause.name &&
        named &&
        ts.isNamedImports(named) &&
        named.elements.length === 1 &&
        !named.elements[0].propertyName &&
        !named.elements[0].isTypeOnly &&
        named.elements[0].name.text === webRegistryTypeName;
      if (!exactTypeImport) report(`unsupported type import from "${specifier}"`);
      return exactTypeImport ? [{ kind: "registry-type" }] : [];
    }
    if (!specifier.endsWith("/context")) {
      report(`web registries import only "<package>/context" manifests; "${specifier}" is forbidden`);
      return [];
    }
    if (!clause.name || clause.namedBindings) {
      report(`unsupported import form from "${specifier}"; expected one default manifest import`);
      return [];
    }
    return [
      {
        kind: "binding",
        local: clause.name.text,
        imported: "default",
        packageName: specifier.slice(0, -"/context".length),
        specifier,
      },
    ];
  }

  const named = clause.namedBindings;
  const elements = named && ts.isNamedImports(named) ? named.elements : null;
  const exactValueImport =
    !clause.isTypeOnly &&
    !clause.name &&
    elements?.length === 2 &&
    elements.every((element) => element.propertyName && !element.isTypeOnly) &&
    elements[0].propertyName.text === "contextManifest" &&
    elements[1].propertyName.text === "module";
  if (!exactValueImport) {
    report(`unsupported import form from "${specifier}"; expected { contextManifest as <alias>, module as <alias> }`);
    return [];
  }
  return elements.map((element) => ({
    kind: "binding",
    local: element.name.text,
    imported: element.propertyName.text,
    packageName: specifier,
    specifier,
  }));
}

function readEntry(element, index, registry, report) {
  const label = `entry ${index + 1}`;
  if (ts.isSpreadElement(element)) {
    report(`${label} is a spread; entries must be written out`);
    return null;
  }
  if (!ts.isObjectLiteralExpression(element)) {
    report(`${label} is not an object literal`);
    return null;
  }
  const expectedKeys =
    registry.registryKind === "web"
      ? ["contextName", "packageName", "manifest"]
      : ["contextName", "packageName", "manifest", "module"];
  const contextLiteral = element.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === "contextName" &&
      ts.isStringLiteral(property.initializer),
  )?.initializer;
  const subject = contextLiteral ? `"${contextLiteral.text}" (${label})` : label;
  const properties = new Map();
  const keys = [];
  for (const property of element.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
      report(`${subject} has an unsupported property form`);
      return null;
    }
    keys.push(property.name.text);
    properties.set(property.name.text, property.initializer);
  }
  if (keys.join(",") !== expectedKeys.join(",")) {
    report(`${subject} keys are [${keys.join(", ")}]; expected exactly [${expectedKeys.join(", ")}]`);
    return null;
  }
  const contextName = properties.get("contextName");
  const packageName = properties.get("packageName");
  if (!ts.isStringLiteral(contextName) || !ts.isStringLiteral(packageName)) {
    report(`${subject} contextName and packageName must be string literals`);
    return null;
  }
  const manifest = properties.get("manifest");
  const manifestIdentifier =
    registry.registryKind === "web"
      ? ts.isAsExpression(manifest) && ts.isIdentifier(manifest.expression) && isWebManifestElementType(manifest.type)
        ? manifest.expression
        : null
      : ts.isIdentifier(manifest)
        ? manifest
        : null;
  if (!manifestIdentifier) {
    report(
      `${subject} manifest must be ${
        registry.registryKind === "web"
          ? `an imported identifier as ${webRegistryTypeName}[number]["manifest"]`
          : "an imported identifier"
      }`,
    );
    return null;
  }
  const moduleValue = properties.get("module");
  if (registry.registryKind !== "web" && !ts.isIdentifier(moduleValue)) {
    report(`${subject} module must be an imported identifier`);
    return null;
  }
  return {
    index,
    contextName: contextName.text,
    packageName: packageName.text,
    uses: [
      { property: "manifest", local: manifestIdentifier.text },
      ...(registry.registryKind === "web" ? [] : [{ property: "module", local: moduleValue.text }]),
    ],
  };
}

function parseRegistry(registry, content) {
  const violations = [];
  const report = (message) => violations.push(`${registry.path}: ${message}`);
  const sourceFile = ts.createSourceFile(registry.path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (sourceFile.parseDiagnostics.length > 0) {
    report("does not parse as TypeScript");
    return { violations, entries: null, imports: [] };
  }

  for (const specifier of findDynamicImports(sourceFile)) {
    report(`dynamic import of "${specifier}" is forbidden`);
  }

  const imports = [];
  let typeImports = 0;
  let exportStatement = null;
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (exportStatement) report("imports must precede the registry export");
      for (const binding of readImport(statement, registry, report)) {
        if (binding.kind === "registry-type") typeImports += 1;
        else imports.push({ ...binding, order: imports.length });
      }
      continue;
    }
    if (ts.isVariableStatement(statement) && hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      if (exportStatement) report("declares more than one exported registry");
      exportStatement ??= statement;
      continue;
    }
    report(`unsupported top-level statement \`${statement.getText(sourceFile).split(/\r?\n/)[0]}\``);
  }
  if (registry.registryKind === "web" && typeImports !== 1) {
    report(`must import type { ${webRegistryTypeName} } from "${webRegistryTypeSource}" exactly once`);
  }

  const declarations = exportStatement?.declarationList.declarations ?? [];
  const declaration = declarations[0];
  const initializer = declaration?.initializer;
  const exactShape =
    exportStatement &&
    modifierKinds(exportStatement).join(",") === String(ts.SyntaxKind.ExportKeyword) &&
    (exportStatement.declarationList.flags & ts.NodeFlags.BlockScoped) === ts.NodeFlags.Const &&
    declarations.length === 1 &&
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === registry.exportName &&
    !declaration.type &&
    initializer &&
    exactExportShape(initializer, registry.registryKind);
  if (!exactShape) report(`registry export must be exactly \`${describeExpectedShape(registry)}\``);

  const array = initializer ? unwrapToArray(initializer) : null;
  if (!array) return { violations, entries: null, imports };
  const entries = array.elements
    .map((element, index) => readEntry(element, index, registry, report))
    .filter((entry) => entry !== null);
  return { violations, entries, imports };
}

function checkMembership(registry, parsed, expected, discovered) {
  const violations = [];
  const report = (message) => violations.push(`${registry.path}: ${message}`);
  const { entries, imports } = parsed;
  const expectedNames = expected.map((context) => context.contextName);
  const expectedSet = new Set(expectedNames);
  const seen = new Set();
  const uniqueActual = [];

  for (const entry of entries) {
    if (seen.has(entry.contextName)) {
      report(`"${entry.contextName}" has a duplicate entry`);
      continue;
    }
    seen.add(entry.contextName);
    uniqueActual.push(entry);
    const context = discovered.get(entry.contextName);
    if (!context) {
      report(`"${entry.contextName}" is not an admitted bounded context`);
      continue;
    }
    if (!expectedSet.has(entry.contextName)) {
      report(`"${entry.contextName}" is not admitted to ${registry.hostName} by its context manifest`);
    }
    if (entry.packageName !== context.packageName) {
      report(
        `"${entry.contextName}" declares packageName "${entry.packageName}" but its workspace package is "${context.packageName}"`,
      );
    }
  }
  for (const name of expectedNames.filter((candidate) => !seen.has(candidate))) {
    report(`"${name}" is admitted to ${registry.hostName} by its context manifest but has no entry`);
  }
  const admittedActual = uniqueActual.map((entry) => entry.contextName).filter((name) => expectedSet.has(name));
  const admittedExpected = expectedNames.filter((name) => seen.has(name));
  const misplaced = admittedActual.find((name, index) => name !== admittedExpected[index]);
  if (misplaced) {
    report(
      `"${misplaced}" is out of admitted context-name order; expected ${admittedExpected.map((name) => `"${name}"`).join(", ")}`,
    );
  }

  const bindings = new Map();
  for (const binding of imports) {
    if (bindings.has(binding.local)) report(`import alias ${binding.local} is declared more than once`);
    else bindings.set(binding.local, { ...binding, owners: [] });
  }
  for (const entry of entries) {
    const ownerPackage = discovered.get(entry.contextName)?.packageName ?? entry.packageName;
    for (const use of entry.uses) {
      const binding = bindings.get(use.local);
      const expectedImport =
        registry.registryKind === "web" ? "default" : use.property === "manifest" ? "contextManifest" : "module";
      if (!binding) {
        report(`"${entry.contextName}" ${use.property} ${use.local} is not an imported binding`);
        continue;
      }
      binding.owners.push(entry);
      if (binding.packageName !== ownerPackage || binding.imported !== expectedImport) {
        report(
          `"${entry.contextName}" ${use.property} ${use.local} is ${binding.imported} from "${binding.specifier}", not ${expectedImport} from "${registry.registryKind === "web" ? `${ownerPackage}/context` : ownerPackage}"`,
        );
      }
    }
  }
  let previousOwnerIndex = -1;
  for (const binding of [...bindings.values()].sort((left, right) => left.order - right.order)) {
    if (binding.owners.length !== 1) {
      report(
        `import ${binding.local} from "${binding.specifier}" is used by ${binding.owners.length} entries; each import belongs to exactly one entry`,
      );
      continue;
    }
    const [owner] = binding.owners;
    if (owner.index < previousOwnerIndex) {
      report(`import ${binding.local} for "${owner.contextName}" is out of entry order`);
    }
    previousOwnerIndex = Math.max(previousOwnerIndex, owner.index);
  }
  return violations;
}

export function validateContextRegistries(options = {}) {
  const rootDir = options.repoRoot ?? defaultRepoRoot;
  const arms = options.hostArms ?? CONTEXT_REGISTRY_HOST_ARMS;
  const contexts = listBoundedContextManifests({ repoRoot: rootDir });
  const discovered = new Map(contexts.map((context) => [context.contextName, context]));
  const violations = [];
  const registries = [];

  for (const retiredPath of RETIRED_CONTEXT_REGISTRY_PATHS) {
    if (existsSync(path.join(rootDir, ...retiredPath.split("/")))) {
      violations.push(
        `${retiredPath}: retired generated context registry must not exist; context registries are the five hand-authored context-registry.ts modules`,
      );
    }
  }

  for (const registry of CONTEXT_REGISTRIES) {
    const expected = contexts.filter((context) =>
      contextManifestContributesToHost(context.manifest, {
        registryKind: registry.registryKind,
        hostName: registry.hostName,
        arms,
      }),
    );
    const filePath = path.join(rootDir, ...registry.path.split("/"));
    if (!existsSync(filePath)) {
      violations.push(`${registry.path}: context registry is missing`);
      continue;
    }
    const parsed = parseRegistry(registry, readFileSync(filePath, "utf8"));
    violations.push(...parsed.violations);
    if (parsed.entries) violations.push(...checkMembership(registry, parsed, expected, discovered));
    registries.push({
      path: registry.path,
      hostName: registry.hostName,
      expected: expected.map((context) => context.contextName),
      actual: parsed.entries?.map((entry) => entry.contextName) ?? null,
    });
  }

  return { violations, registries };
}
