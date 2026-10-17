import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { classifyReleaseQualificationScope } from "./release-qualification-scope.mjs";
import { loadModuleResolutionContext, resolveModule } from "./check-structure/module-resolution.mjs";
import { classifySqlExecutionSurface } from "./check-structure/sql-execution-surface.mjs";

/** The evaluator's error vocabulary is deliberately closed and ordered. */
export const RELEASE_QUALIFICATION_APPLICABILITY_WITHDRAWAL_CODES = Object.freeze([
  "malformed_applicability_metadata",
  "unsupported_applicability_kind",
  "undeclared_graph_node",
  "graph_shape_drift",
  "undeclared_module_specifier",
  "undeclared_external_specifier",
  "binding_mode_drift",
  "persistent_dependency",
  "sql_execution_surface",
  "event_store_member_reference",
  "ambiguous_member_reference_key",
  "event_store_contract_unreadable",
  "unresolvable_module_specifier",
  "module_specifier_escapes_repository",
  "ambiguous_dynamic_import",
  "unparseable_module",
]);
const WITHDRAWAL_SET = new Set(RELEASE_QUALIFICATION_APPLICABILITY_WITHDRAWAL_CODES);

const EMPTY_GRAPH = Object.freeze([]);
const normalizeRepoPath = (value) => path.posix.normalize(String(value).replaceAll("\\", "/")).replace(/^\.\//, "");
const freezeDeep = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
};

function result(applies, codes, graph) {
  const unknown = [...new Set(codes)].filter((code) => !WITHDRAWAL_SET.has(code));
  if (unknown.length) throw new Error(`Unknown applicability withdrawal code: ${unknown.join(", ")}`);
  const ordered = [...new Set(codes)];
  ordered.sort(
    (a, b) =>
      RELEASE_QUALIFICATION_APPLICABILITY_WITHDRAWAL_CODES.indexOf(a) -
      RELEASE_QUALIFICATION_APPLICABILITY_WITHDRAWAL_CODES.indexOf(b),
  );
  return freezeDeep({ applies: Boolean(applies) && ordered.length === 0, withdrawalCodes: ordered, graph });
}

function malformedApplicability(applicability) {
  if (!applicability || typeof applicability !== "object" || Array.isArray(applicability)) return true;
  if (applicability.kind !== "pure-module/v1") return false;
  if (!Array.isArray(applicability.modules) || applicability.modules.length === 0) return true;
  if (Reflect.ownKeys(applicability).some((key) => !["kind", "modules"].includes(key))) return true;
  const paths = new Set();
  for (const module of applicability.modules) {
    if (
      !module ||
      typeof module !== "object" ||
      Array.isArray(module) ||
      typeof module.path !== "string" ||
      !Array.isArray(module.specifiers)
    )
      return true;
    if (paths.has(module.path) || Reflect.ownKeys(module).some((key) => !["path", "specifiers"].includes(key)))
      return true;
    paths.add(module.path);
    const specifiers = new Set();
    for (const specifier of module.specifiers) {
      if (
        !specifier ||
        typeof specifier !== "object" ||
        Array.isArray(specifier) ||
        typeof specifier.specifier !== "string" ||
        !["value", "type-only"].includes(specifier.binding)
      )
        return true;
      if (
        specifier.specifier.length === 0 ||
        specifiers.has(specifier.specifier) ||
        Reflect.ownKeys(specifier).some((key) => !["specifier", "binding"].includes(key))
      )
        return true;
      specifiers.add(specifier.specifier);
    }
  }
  return false;
}

function sourceFileFor(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return sf.parseDiagnostics?.length ? null : sf;
}

function literalText(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

function bindingModeForImportClause(clause) {
  if (!clause) return "value";
  if (clause.isTypeOnly) return "type-only";
  if (clause.name) return "value";
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    return clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((entry) => entry.isTypeOnly)
      ? "type-only"
      : "value";
  }
  return "value";
}

function bindingModeForExport(statement) {
  if (statement.isTypeOnly) return "type-only";
  if (
    statement.exportClause &&
    ts.isNamedExports(statement.exportClause) &&
    statement.exportClause.elements.length > 0
  ) {
    return statement.exportClause.elements.every((entry) => entry.isTypeOnly) ? "type-only" : "value";
  }
  return "value";
}

function enumerateSpecifiers(sourceFile) {
  const found = [];
  const add = (specifier, binding) => {
    if (specifier) found.push({ specifier, binding });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node))
      add(literalText(node.moduleSpecifier), bindingModeForImportClause(node.importClause));
    else if (ts.isExportDeclaration(node)) add(literalText(node.moduleSpecifier), bindingModeForExport(node));
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(literalText(node.moduleReference.expression), "value");
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const text = ts.isIdentifier(callee) ? callee.text : "";
      if (text === "require" && node.arguments.length === 1) {
        const value = literalText(node.arguments[0]);
        add(value, "value");
      } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1) {
        const value = literalText(node.arguments[0]);
        if (value === null) found.push({ specifier: null, binding: "value", ambiguousDynamic: true });
        else add(value, "value");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const grouped = new Map();
  for (const entry of found) {
    if (entry.ambiguousDynamic) {
      grouped.set(`__dynamic_${grouped.size}`, entry);
      continue;
    }
    const existing = grouped.get(entry.specifier);
    if (!existing) grouped.set(entry.specifier, { ...entry });
    else if (entry.binding === "value") existing.binding = "value";
  }
  return [...grouped.values()];
}

function deriveMemberNamesFromSource(source, file) {
  const parsed = sourceFileFor(file, source);
  if (!parsed) return null;
  const names = new Set();
  const membersForDeclaration = (node) => {
    if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) return node.members;
    if (!ts.isTypeAliasDeclaration(node)) return null;
    if (ts.isTypeLiteralNode(node.type)) return node.type.members;
    if (
      ts.isTypeReferenceNode(node.type) &&
      ts.isIdentifier(node.type.typeName) &&
      node.type.typeName.text === "Readonly" &&
      node.type.typeArguments?.length === 1 &&
      ts.isTypeLiteralNode(node.type.typeArguments[0])
    )
      return node.type.typeArguments[0].members;
    return null;
  };
  let found = false;
  let readable = false;
  const visit = (node) => {
    if (
      (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      (node.name?.text === "EventStore" || node.name?.text === "CompleteStreamReader")
    ) {
      found = true;
      const declarations = membersForDeclaration(node);
      if (!declarations) return;
      readable = true;
      for (const member of declarations) {
        const name =
          member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : null;
        if (name) names.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found && readable && names.size ? names : null;
}

export function deriveForbiddenEventStoreMembers({ repoRoot, readFile = null, files = {} } = {}) {
  const read = (file) => {
    if (typeof readFile === "function") return readFile(file);
    if (Object.hasOwn(files, file)) return files[file];
    const absolute = path.join(repoRoot ?? process.cwd(), ...file.split("/"));
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  };
  const eventStore = read("contracts/event-core/event-store.ts");
  const complete = read("contracts/event-core/complete-stream.ts");
  if (typeof eventStore !== "string" || typeof complete !== "string") return null;
  const eventStoreNames = deriveMemberNamesFromSource(eventStore, "event-store.ts");
  const completeNames = deriveMemberNamesFromSource(complete, "complete-stream.ts");
  if (!eventStoreNames || !completeNames) return null;
  return Object.freeze([...new Set([...eventStoreNames, ...completeNames])].sort());
}

function collectForbiddenMemberReferences(sourceFile, forbidden) {
  const codes = new Set();
  const visit = (node, inType = false) => {
    const type = inType || Boolean(ts.isTypeNode?.(node));
    if (!type && ts.isPropertyAccessExpression(node) && forbidden.has(node.name.text))
      codes.add("event_store_member_reference");
    if (!type && ts.isElementAccessExpression(node)) {
      const key = literalText(node.argumentExpression);
      if (ts.isNumericLiteral(node.argumentExpression)) {
        // Numeric indices are statically known but cannot name a contract member.
      } else if (key === null) codes.add("ambiguous_member_reference_key");
      else if (forbidden.has(key)) codes.add("event_store_member_reference");
    }
    if (!type && ts.isBindingElement(node)) {
      const key =
        literalText(node.propertyName ?? node.name) ??
        (ts.isIdentifier(node.propertyName ?? node.name) ? (node.propertyName ?? node.name).text : null);
      if (key && forbidden.has(key)) codes.add("event_store_member_reference");
    }
    if (!type && (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node))) {
      const key = literalText(node.name) ?? (ts.isIdentifier(node.name) ? node.name.text : null);
      if (key && forbidden.has(key)) codes.add("event_store_member_reference");
    }
    ts.forEachChild(node, (child) => visit(child, type));
  };
  visit(sourceFile);
  return codes;
}

function classifyNode({ repoRoot, file, source, now, readFileAt, registry }) {
  const read = readFileAt ?? ((side, name) => (side === "candidate" && name === file ? source : null));
  const record = classifyReleaseQualificationScope({
    now,
    base: { sha: "a".repeat(40), treeSha: "b".repeat(40) },
    candidate: { sha: "c".repeat(40), treeSha: "d".repeat(40) },
    changedFiles: [{ path: file, status: "added" }],
    readFileAt: read,
    registry,
  });
  return record.class === "persistent_required" ? "persistent_dependency" : null;
}

function buildContext(repoRoot, context) {
  return context ?? loadModuleResolutionContext(repoRoot);
}

/** Evaluate a pure-module/v1 applicability contract over its recursive value graph. */
export function evaluateReleaseQualificationApplicability({
  repoRoot = process.cwd(),
  rootPath,
  
  applicability,
  files = {},
  readFile = null,
  readFileAt = null,
  resolutionContext = null,
  sqlClassifier = classifySqlExecutionSurface,
  registry = undefined,
  now = () => 0,
} = {}) {
  if (!applicability || typeof applicability !== "object" || Array.isArray(applicability))
    return result(false, ["malformed_applicability_metadata"], EMPTY_GRAPH);
  if (applicability.kind !== "pure-module/v1") return result(false, ["unsupported_applicability_kind"], EMPTY_GRAPH);
  if (malformedApplicability(applicability)) return result(false, ["malformed_applicability_metadata"], EMPTY_GRAPH);
  const root = normalizeRepoPath(rootPath ?? applicability.modules[0].path);
  const declarations = new Map(applicability.modules.map((module) => [normalizeRepoPath(module.path), module]));
  const source = (file) => {
    if (typeof readFile === "function") return readFile(file);
    if (Object.hasOwn(files, file)) return files[file];
    const absolute = path.join(repoRoot, ...file.split("/"));
    return existsSync(absolute) ? readFileSync(absolute, "utf8") : null;
  };
  const loadedContext = buildContext(repoRoot, resolutionContext);
  const ctx = loadedContext;
  const forbidden = deriveForbiddenEventStoreMembers({ repoRoot, readFile: source, files });
  if (!forbidden) return result(false, ["event_store_contract_unreadable"], EMPTY_GRAPH);
  const codes = new Set();
  const discovered = new Map();
  const visited = new Set();
  const pending = [root];
  while (pending.length) {
    const file = normalizeRepoPath(pending.shift());
    if (visited.has(file)) continue;
    visited.add(file);
    const content = source(file);
    if (typeof content !== "string") {
      codes.add("unresolvable_module_specifier");
      continue;
    }
    const parsed = sourceFileFor(file, content);
    if (!parsed) {
      codes.add("unparseable_module");
      continue;
    }
    const refs = collectForbiddenMemberReferences(parsed, new Set(forbidden));
    for (const code of refs) codes.add(code);
    const sql = sqlClassifier({ repoRoot, files: [file] });
    const module = sql.modules?.[0];
    if (!module || module.outcome !== "not-sql" || sql.unresolvedMemberRoots?.fileList?.includes(file))
      codes.add("sql_execution_surface");
    const dependencyCode = classifyNode({ repoRoot, file, source: content, now, readFileAt, registry });
    if (dependencyCode) codes.add(dependencyCode);
    const specifiers = enumerateSpecifiers(parsed);
    const records = specifiers.map(({ specifier, binding, ambiguousDynamic }) => ({
      specifier,
      binding,
      ambiguousDynamic: Boolean(ambiguousDynamic),
    }));
    discovered.set(file, { path: file, specifiers: records });
    for (const item of specifiers) {
      if (item.ambiguousDynamic) {
        codes.add("ambiguous_dynamic_import");
        continue;
      }
      const resolution = resolveModule({ importerPath: file, specifierText: item.specifier, ...ctx });
      if (resolution.kind === "repo") {
        if (item.binding === "value") pending.push(normalizeRepoPath(resolution.path));
      } else if (resolution.kind === "unresolved") {
        codes.add(
          resolution.reason === "path-escapes-repository"
            ? "module_specifier_escapes_repository"
            : "unresolvable_module_specifier",
        );
      }
    }
  }

  if (!discovered.has(root)) codes.add("undeclared_graph_node");
  for (const [file, node] of discovered) {
    const declared = declarations.get(file);
    if (!declared) {
      codes.add("undeclared_graph_node");
      continue;
    }
    const declaredSpecs = new Map(declared.specifiers.map((entry) => [entry.specifier, entry.binding]));
    const seen = new Set();
    for (const spec of node.specifiers) {
      if (spec.ambiguousDynamic) continue;
      seen.add(spec.specifier);
      if (!declaredSpecs.has(spec.specifier)) {
        const resolution = resolveModule({ importerPath: file, specifierText: spec.specifier, ...ctx });
        codes.add(resolution.kind === "external" ? "undeclared_external_specifier" : "undeclared_module_specifier");
      } else if (declaredSpecs.get(spec.specifier) !== spec.binding) codes.add("binding_mode_drift");
    }
    for (const specifier of declaredSpecs.keys()) if (!seen.has(specifier)) codes.add("graph_shape_drift");
  }
  for (const file of declarations.keys()) if (!discovered.has(file)) codes.add("graph_shape_drift");
  const graph = [...discovered.values()]
    .sort((a, b) => a.path.localeCompare(b.path, "en"))
    .map((node) => ({
      path: node.path,
      specifiers: node.specifiers
        .filter((entry) => !entry.ambiguousDynamic)
        .map(({ specifier, binding }) => ({ specifier, binding })),
    }));
  return result(codes.size === 0, [...codes], graph);
}

