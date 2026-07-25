import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { loadModuleResolutionContext, resolveModule } from "./module-resolution.mjs";

const contractModules = new Set([
  "infrastructure/event-core-postgres/types.ts",
  "infrastructure/event-core-postgres/index.ts",
]);
const contractDeclarationModule = "infrastructure/event-core-postgres/types.ts";
const contractIndexModule = "infrastructure/event-core-postgres/index.ts";
const contractNames = new Set(["PgQueryable", "PgPoolClient", "PgTransactionalPool"]);
const transparentTypeConstructors = new Set(["Pick", "Readonly", "Promise", "NonNullable"]);
const moduleResolutionContextCache = new Map();

export const SANCTIONED_SQL_RECEIVER_RESOLUTION =
  "introduce a locally annotated binding whose type is contract-bound and resolvable to a contract module, then execute through it";

export class SqlExecutionGuardError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "SqlExecutionGuardError";
    this.code = code;
  }
}

function normalizeRepoPath(value) {
  return path.posix.normalize(value.replaceAll("\\", "/")).replace(/^\.\//, "");
}

function scriptKindFor(file) {
  return file.endsWith(".mts") ? ts.ScriptKind.TS : ts.ScriptKind.TS;
}

function parseSource(file, source) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
}

function isTypeDeclaration(node) {
  return ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node);
}

function nodeNameText(node) {
  if (!node?.name) return null;
  if (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isNumericLiteral(node.name)) {
    return node.name.text;
  }
  return null;
}

function bindingIdentifiers(name, target = []) {
  if (ts.isIdentifier(name)) {
    target.push(name);
    return target;
  }
  for (const element of name.elements ?? []) {
    if (ts.isBindingElement(element)) bindingIdentifiers(element.name, target);
  }
  return target;
}

function declarationTypeNode(node) {
  if (ts.isBindingElement(node)) {
    let current = node.parent;
    while (current && !ts.isParameter(current) && !ts.isVariableDeclaration(current)) current = current.parent;
    return current?.type;
  }
  return node.type;
}

function declarationInitializer(node) {
  if (ts.isBindingElement(node)) return undefined;
  return node.initializer;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression?.(current))
  ) {
    current = current.expression;
  }
  return current;
}

function propertyAccessParts(expression) {
  const properties = [];
  let current = unwrapExpression(expression);
  while (current && ts.isPropertyAccessExpression(current)) {
    properties.unshift(current.name.text);
    current = unwrapExpression(current.expression);
  }
  return { root: current, properties };
}

function typeReferenceName(typeNode) {
  if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return null;
  return typeNode.typeName.text;
}

function stateWithModuleResolution(state, modulePath) {
  const nextCount = state.moduleResolutions + 1;
  if (nextCount > 4) return { error: proof("unprovable-form", "bound exceeded") };
  if (state.visitedModules.has(modulePath)) return { error: proof("unprovable-form", "bound exceeded") };
  return {
    state: {
      moduleResolutions: nextCount,
      visitedModules: new Set([...state.visitedModules, modulePath]),
    },
  };
}

function proof(outcome, reason, extra = {}) {
  return { outcome, reason, ...extra };
}

function sourceLine(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function moduleResolutionContextFor(repoRoot) {
  const cached = moduleResolutionContextCache.get(repoRoot);
  if (cached) return cached;
  const context = loadModuleResolutionContext(repoRoot);
  moduleResolutionContextCache.set(repoRoot, context);
  return context;
}

class Analyzer {
  constructor(repoRoot) {
    this.repoRoot = repoRoot;
    this.resolutionContext = moduleResolutionContextFor(repoRoot);
    this.modules = new Map();
    this.sources = new Map();
    this.unresolvedMemberRoots = new Map();
  }

  readModuleSource(file) {
    const normalizedFile = normalizeRepoPath(file);
    if (this.sources.has(normalizedFile)) return this.sources.get(normalizedFile);
    const absolutePath = path.join(this.repoRoot, ...normalizedFile.split("/"));
    if (!existsSync(absolutePath)) return null;
    const source = readFileSync(absolutePath, "utf8");
    this.sources.set(normalizedFile, source);
    return source;
  }

  loadModule(file) {
    const normalizedFile = normalizeRepoPath(file);
    if (this.modules.has(normalizedFile)) return this.modules.get(normalizedFile);
    const source = this.readModuleSource(normalizedFile);
    if (source === null) return null;
    const sourceFile = parseSource(normalizedFile, source);
    const record = {
      file: normalizedFile,
      source,
      sourceFile,
      imports: new Map(),
      declarations: new Map(),
      typeDeclarations: new Map(),
      functions: new Map(),
    };
    this.modules.set(normalizedFile, record);

    const addDeclaration = (name, node) => {
      const entries = record.declarations.get(name) ?? [];
      entries.push(node);
      record.declarations.set(name, entries);
    };
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const resolution = resolveModule({
          importerPath: normalizedFile,
          specifierText: node.moduleSpecifier.text,
          ...this.resolutionContext,
        });
        const clause = node.importClause;
        if (clause?.name) {
          record.imports.set(clause.name.text, {
            importedName: "default",
            resolution,
            specifier: node.moduleSpecifier.text,
          });
        }
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            record.imports.set(element.name.text, {
              importedName: element.propertyName?.text ?? element.name.text,
              resolution,
              specifier: node.moduleSpecifier.text,
            });
          }
        }
      }

      if (isTypeDeclaration(node) && node.name) record.typeDeclarations.set(node.name.text, node);
      if (ts.isFunctionDeclaration(node) && node.name) {
        record.functions.set(node.name.text, node);
        addDeclaration(node.name.text, node);
      }
      if (
        ts.isParameter(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isBindingElement(node)
      ) {
        for (const identifier of bindingIdentifiers(node.name)) addDeclaration(identifier.text, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    for (const entries of record.declarations.values()) {
      entries.sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile));
    }
    return record;
  }

  resolveImportedDeclaration(module, localName, state, kind = "type") {
    const binding = module.imports.get(localName);
    if (!binding) return null;
    if (binding.resolution.kind === "unresolved") {
      return { error: proof("unprovable-form", "unresolved module hop") };
    }
    if (binding.resolution.kind === "external") return { external: true, binding };
    const advanced = stateWithModuleResolution(state, binding.resolution.path);
    if (advanced.error) return advanced;
    const targetModule = this.loadModule(binding.resolution.path);
    if (!targetModule) return { error: proof("unprovable-form", "unresolved module hop") };
    const declaration =
      kind === "function"
        ? targetModule.functions.get(binding.importedName)
        : targetModule.typeDeclarations.get(binding.importedName);
    if (!declaration) {
      return {
        error: contractNames.has(binding.importedName)
          ? proof("unprovable-form", "unresolvable declaration")
          : proof("not-sql", "definitively non-contract"),
      };
    }
    return { module: targetModule, declaration, state: advanced.state, binding };
  }

  contractStatus(typeNode, module, state) {
    if (!typeNode) return proof("unprovable-form", "unresolvable declaration");
    if (ts.isParenthesizedTypeNode(typeNode) || ts.isOptionalTypeNode?.(typeNode)) {
      return this.contractStatus(typeNode.type, module, state);
    }
    if (ts.isIntersectionTypeNode(typeNode)) {
      let unresolved = null;
      for (const member of typeNode.types) {
        const status = this.contractStatus(member, module, state);
        if (status.outcome === "sql-execution") return status;
        if (status.outcome === "unprovable-form") unresolved = status;
      }
      return unresolved ?? proof("not-sql", "definitively non-contract");
    }
    if (ts.isIndexedAccessTypeNode(typeNode)) {
      if (!ts.isLiteralTypeNode(typeNode.indexType) || !ts.isStringLiteral(typeNode.indexType.literal)) {
        return proof("not-sql", "definitively non-contract");
      }
      const member = this.resolveTypeMember(typeNode.objectType, typeNode.indexType.literal.text, module, state);
      if (member.error) return member.error;
      if (!member.typeNode) return proof("not-sql", "definitively non-contract");
      return this.contractStatus(member.typeNode, member.module, member.state);
    }
    if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) {
      return proof("not-sql", "definitively non-contract");
    }

    const name = typeNode.typeName.text;
    if (transparentTypeConstructors.has(name)) {
      const inner = typeNode.typeArguments?.[0];
      return inner ? this.contractStatus(inner, module, state) : proof("not-sql", "definitively non-contract");
    }

    if (contractNames.has(name)) {
      if (module.file === contractDeclarationModule && module.typeDeclarations.has(name)) {
        return proof("sql-execution", "contract declaration");
      }
      const binding = module.imports.get(name);
      if (!binding) return proof("unprovable-form", "unresolvable declaration");
      if (binding.resolution.kind === "unresolved") return proof("unprovable-form", "unresolved module hop");
      if (
        binding.resolution.kind === "repo" &&
        contractModules.has(binding.resolution.path) &&
        contractNames.has(binding.importedName)
      ) {
        const advanced = stateWithModuleResolution(state, binding.resolution.path);
        return advanced.error ?? proof("sql-execution", "contract import");
      }
      return proof("unprovable-form", "unresolvable declaration");
    }

    const aliasBinding = module.imports.get(name);
    if (
      aliasBinding &&
      contractNames.has(aliasBinding.importedName) &&
      aliasBinding.resolution.kind === "repo" &&
      contractModules.has(aliasBinding.resolution.path)
    ) {
      const advanced = stateWithModuleResolution(state, aliasBinding.resolution.path);
      return advanced.error ?? proof("sql-execution", "contract import alias");
    }
    if (aliasBinding && contractNames.has(aliasBinding.importedName)) {
      return aliasBinding.resolution.kind === "unresolved"
        ? proof("unprovable-form", "unresolved module hop")
        : proof("unprovable-form", "unresolvable declaration");
    }
    return proof("not-sql", "definitively non-contract");
  }

  resolveNamedType(name, module, state) {
    const local = module.typeDeclarations.get(name);
    if (local) return { module, declaration: local, state };
    return this.resolveImportedDeclaration(module, name, state, "type");
  }

  resolveTypeMember(typeNode, propertyName, module, state) {
    if (!typeNode) return { error: proof("unprovable-form", "unresolvable declaration") };
    if (ts.isParenthesizedTypeNode(typeNode)) return this.resolveTypeMember(typeNode.type, propertyName, module, state);
    if (ts.isIntersectionTypeNode(typeNode)) {
      let unresolved = null;
      for (const member of typeNode.types) {
        const result = this.resolveTypeMember(member, propertyName, module, state);
        if (result.typeNode) return result;
        if (result.error?.outcome === "unprovable-form") unresolved = result.error;
      }
      return unresolved ? { error: unresolved } : {};
    }
    if (ts.isIndexedAccessTypeNode(typeNode)) {
      if (!ts.isLiteralTypeNode(typeNode.indexType) || !ts.isStringLiteral(typeNode.indexType.literal)) return {};
      const indexedMember = this.resolveTypeMember(typeNode.objectType, typeNode.indexType.literal.text, module, state);
      if (indexedMember.error || !indexedMember.typeNode) return indexedMember;
      return this.resolveTypeMember(indexedMember.typeNode, propertyName, indexedMember.module, indexedMember.state);
    }
    if (ts.isTypeLiteralNode(typeNode)) return this.findMember(typeNode.members, propertyName, module, state);
    if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) return {};
    const name = typeNode.typeName.text;
    if (transparentTypeConstructors.has(name)) {
      const inner = typeNode.typeArguments?.[0];
      return inner ? this.resolveTypeMember(inner, propertyName, module, state) : {};
    }
    const resolved = this.resolveNamedType(name, module, state);
    if (!resolved) return {};
    if (resolved.error) return { error: resolved.error };
    if (resolved.external) return { external: true };
    const declaration = resolved.declaration;
    if (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
      const ownMember = this.findMember(declaration.members, propertyName, resolved.module, resolved.state);
      if (ownMember.typeNode || ownMember.error) return ownMember;
      for (const heritage of declaration.heritageClauses ?? []) {
        for (const heritageType of heritage.types) {
          const inherited = this.resolveTypeMember(heritageType, propertyName, resolved.module, resolved.state);
          if (inherited.typeNode || inherited.error) return inherited;
        }
      }
      return {};
    }
    if (ts.isTypeAliasDeclaration(declaration)) {
      return this.resolveTypeMember(declaration.type, propertyName, resolved.module, resolved.state);
    }
    return {};
  }

  findMember(members, propertyName, module, state) {
    for (const member of members) {
      if (nodeNameText(member) !== propertyName) continue;
      if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
        return { typeNode: member.type, returnType: member.type, module, state, declaration: member };
      }
      return { typeNode: member.type, module, state, declaration: member };
    }
    return {};
  }

  findValueDeclaration(identifier, module) {
    const entries = module.declarations.get(identifier.text) ?? [];
    const position = identifier.getStart(module.sourceFile);
    const candidates = entries.filter(
      (node) => node.getStart(module.sourceFile) <= position && node !== identifier.parent,
    );
    return candidates.at(-1) ?? null;
  }

  recordUnresolvedMemberRoot(module, identifier) {
    const count = this.unresolvedMemberRoots.get(module.file) ?? 0;
    this.unresolvedMemberRoots.set(module.file, count + 1);
  }

  proveDeclaration(declaration, module, state) {
    const typeNode = declarationTypeNode(declaration);
    if (typeNode) {
      const status = this.contractStatus(typeNode, module, state);
      if (status.outcome !== "not-sql") return status;
    }
    const initializer = declarationInitializer(declaration);
    if (initializer) {
      const status = this.proveValue(initializer, module, state);
      if (status.outcome !== "not-sql") return status;
    }
    return typeNode
      ? proof("not-sql", "definitively non-contract")
      : proof("unprovable-form", "unresolvable declaration");
  }

  proveIdentifier(identifier, module, state) {
    const declaration = this.findValueDeclaration(identifier, module);
    if (!declaration) return proof("unprovable-form", "unresolvable declaration");
    return this.proveDeclaration(declaration, module, state);
  }

  rootType(identifier, module, state) {
    const declaration = this.findValueDeclaration(identifier, module);
    if (!declaration) return { unresolvedRoot: true };
    const typeNode = declarationTypeNode(declaration);
    if (!typeNode) return { unresolvedRoot: true };
    return { typeNode, module, state };
  }

  proveMemberAccess(expression, module, state) {
    const { root, properties } = propertyAccessParts(expression);
    if (properties.length > 3) return proof("unprovable-form", "bound exceeded");
    if (!root || !ts.isIdentifier(root)) return proof("unprovable-form", "unsupported shape");
    let current = this.rootType(root, module, state);
    if (current.unresolvedRoot) {
      this.recordUnresolvedMemberRoot(module, root);
      return proof("not-sql", "unresolved member root");
    }
    for (const propertyName of properties) {
      const member = this.resolveTypeMember(current.typeNode, propertyName, current.module, current.state);
      if (member.error) return member.error;
      if (member.external) return proof("not-sql", "definitively non-contract");
      if (!member.typeNode) return proof("not-sql", "definitively non-contract");
      current = member;
    }
    return this.contractStatus(current.typeNode, current.module, current.state);
  }

  resolveFunction(expression, module, state) {
    const callee = unwrapExpression(expression);
    if (ts.isIdentifier(callee)) {
      const local = module.functions.get(callee.text);
      if (local) return { module, declaration: local, state };
      return this.resolveImportedDeclaration(module, callee.text, state, "function");
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const receiver = callee.expression;
      const { root, properties } = propertyAccessParts(receiver);
      let current;
      if (ts.isIdentifier(root) && properties.length === 0) current = this.rootType(root, module, state);
      else return null;
      if (current.unresolvedRoot) return null;
      const member = this.resolveTypeMember(current.typeNode, callee.name.text, current.module, current.state);
      if (!member.declaration) return member.error ? { error: member.error } : null;
      return {
        module: member.module,
        declaration: member.declaration,
        state: member.state,
      };
    }
    return null;
  }

  proveCall(call, module, state) {
    const resolved = this.resolveFunction(call.expression, module, state);
    if (!resolved) return proof("unprovable-form", "unsupported shape");
    if (resolved.error) return resolved.error;
    if (resolved.external) return proof("not-sql", "definitively non-contract");
    const declaration = resolved.declaration;
    const returnType =
      (ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)) &&
      declaration.type &&
      ts.isFunctionTypeNode(declaration.type)
        ? declaration.type.type
        : declaration.type;
    if (!returnType) return proof("unprovable-form", "unresolvable declaration");

    if (ts.isTypeReferenceNode(returnType) && ts.isIdentifier(returnType.typeName)) {
      const typeParameterName = returnType.typeName.text;
      const isTypeParameter = declaration.typeParameters?.some(
        (parameter) => parameter.name.text === typeParameterName,
      );
      if (isTypeParameter) {
        const matchingParameters = declaration.parameters
          .map((parameter, index) => ({ parameter, index }))
          .filter(({ parameter }) => typeReferenceName(parameter.type) === typeParameterName);
        if (matchingParameters.length === 1) {
          const argument = call.arguments[matchingParameters[0].index];
          return argument
            ? this.proveValue(argument, module, resolved.state)
            : proof("unprovable-form", "unresolvable declaration");
        }
      }
    }
    return this.contractStatus(returnType, resolved.module, resolved.state);
  }

  proveValue(expression, module, state) {
    const value = unwrapExpression(expression);
    if (!value) return proof("unprovable-form", "unsupported shape");
    if (ts.isAsExpression(value) || ts.isTypeAssertionExpression(value)) {
      const castStatus = this.contractStatus(value.type, module, state);
      if (castStatus.outcome === "sql-execution") return castStatus;
      const expressionStatus = this.proveValue(value.expression, module, state);
      return expressionStatus.outcome === "not-sql" && castStatus.outcome === "unprovable-form"
        ? castStatus
        : expressionStatus;
    }
    if (ts.isIdentifier(value)) return this.proveIdentifier(value, module, state);
    if (ts.isPropertyAccessExpression(value)) return this.proveMemberAccess(value, module, state);
    if (ts.isCallExpression(value)) return this.proveCall(value, module, state);
    return proof("unprovable-form", "unsupported shape");
  }

  analyzeModule(file) {
    const source = this.readModuleSource(file);
    if (source === null) return null;
    if (!/\.(?:query|execute)\b/.test(source)) {
      return { file: normalizeRepoPath(file), outcome: "not-sql", calls: [] };
    }
    const module = this.loadModule(file);
    if (!module) return null;
    const calls = [];
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === "query" || node.expression.name.text === "execute")
      ) {
        const receiverNode = node.expression.expression;
        const result = this.proveValue(receiverNode, module, {
          moduleResolutions: 0,
          visitedModules: new Set([module.file]),
        });
        calls.push({
          line: sourceLine(module.sourceFile, node),
          call: `.${node.expression.name.text}()`,
          receiver: receiverNode.getText(module.sourceFile),
          outcome: result.outcome,
          reason: result.reason,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(module.sourceFile);
    const outcome = calls.some((call) => call.outcome === "sql-execution")
      ? "sql-executing"
      : calls.some((call) => call.outcome === "unprovable-form")
        ? "unprovable-form"
        : "not-sql";
    return { file: module.file, outcome, calls };
  }
}

function assertContractSurface(repoRoot) {
  const typesPath = path.join(repoRoot, ...contractDeclarationModule.split("/"));
  const indexPath = path.join(repoRoot, ...contractIndexModule.split("/"));
  if (!existsSync(typesPath) || !existsSync(indexPath)) {
    throw new SqlExecutionGuardError("SQL_CONTRACT_MODULE_MISSING", "the DB-client contract modules must exist");
  }
  const typesSource = parseSource(contractDeclarationModule, readFileSync(typesPath, "utf8"));
  const declaredNames = new Set();
  for (const statement of typesSource.statements) {
    if (isTypeDeclaration(statement) && statement.name) declaredNames.add(statement.name.text);
  }
  for (const contractName of contractNames) {
    if (!declaredNames.has(contractName)) {
      throw new SqlExecutionGuardError(
        "SQL_CONTRACT_NAME_MISSING",
        `${contractDeclarationModule} must declare ${contractName}`,
      );
    }
  }

  const indexSource = parseSource(contractIndexModule, readFileSync(indexPath, "utf8"));
  const reexportsTypes = indexSource.statements.some(
    (statement) =>
      ts.isExportDeclaration(statement) &&
      !statement.exportClause &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./types",
  );
  if (!reexportsTypes) {
    throw new SqlExecutionGuardError("SQL_CONTRACT_REEXPORT_MISSING", `${contractIndexModule} must re-export ./types`);
  }
}

function formatViolation(module, call) {
  return (
    `${module.file}:${call.line}: call ${call.call}; receiver ${call.receiver}; reason: ${call.reason}; ` +
    `resolution: ${SANCTIONED_SQL_RECEIVER_RESOLUTION}`
  );
}

export function classifySqlExecutionSurface({ repoRoot, files }) {
  assertContractSurface(repoRoot);
  const analyzer = new Analyzer(repoRoot);
  const modules = [...new Set(files.map(normalizeRepoPath))]
    .sort()
    .map((file) => analyzer.analyzeModule(file))
    .filter(Boolean);
  const violations = modules.flatMap((module) =>
    module.outcome === "unprovable-form"
      ? module.calls.filter((call) => call.outcome === "unprovable-form").map((call) => formatViolation(module, call))
      : [],
  );
  const unresolvedFiles = [...analyzer.unresolvedMemberRoots.keys()].sort();
  return {
    modules,
    violations,
    unresolvedMemberRoots: {
      count: unresolvedFiles.reduce((total, file) => total + analyzer.unresolvedMemberRoots.get(file), 0),
      fileList: unresolvedFiles,
    },
  };
}

function defaultExecGit(args, repoRoot) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseChangedFilesJson(changedFilesJson) {
  let parsed;
  try {
    parsed = JSON.parse(changedFilesJson);
  } catch {
    throw new SqlExecutionGuardError("SQL_CHANGED_FILES_INVALID_JSON", "CHANGED_FILES_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new SqlExecutionGuardError(
      "SQL_CHANGED_FILES_NOT_ARRAY",
      "CHANGED_FILES_JSON must be an array of file paths",
    );
  }
  return parsed;
}

export function deriveChangedSqlExecutionFiles({
  repoRoot,
  changedFilesJson = process.env.CHANGED_FILES_JSON,
  execGit = (args) => defaultExecGit(args, repoRoot),
} = {}) {
  let files;
  if (changedFilesJson !== undefined) {
    files = parseChangedFilesJson(changedFilesJson);
  } else {
    let mergeBase;
    try {
      mergeBase = execGit(["merge-base", "origin/main", "HEAD"]).trim();
    } catch {
      throw new SqlExecutionGuardError(
        "SQL_MERGE_BASE_FAILED",
        "could not derive git merge-base for origin/main and HEAD",
      );
    }
    if (!mergeBase) {
      throw new SqlExecutionGuardError("SQL_MERGE_BASE_FAILED", "git merge-base for origin/main and HEAD was empty");
    }
    try {
      files = execGit(["diff", "--name-only", "--diff-filter=ACMR", mergeBase, "HEAD"]).split(/\r?\n/).filter(Boolean);
    } catch {
      throw new SqlExecutionGuardError("SQL_DIFF_FAILED", "could not derive changed files from git diff");
    }
  }
  return files
    .map(normalizeRepoPath)
    .filter((file) => /\.(?:ts|mts)$/.test(file) && !/\.(?:test|spec|d)\.(?:ts|mts)$/.test(file))
    .sort();
}

export function listNonTestTypeScriptModules(repoRoot, { execGit = (args) => defaultExecGit(args, repoRoot) } = {}) {
  return execGit(["ls-files", "-z", "--cached"])
    .split("\0")
    .filter(Boolean)
    .map(normalizeRepoPath)
    .filter((file) => /\.(?:ts|mts)$/.test(file))
    .filter((file) => !/\.(?:test|spec|d)\.(?:ts|mts)$/.test(file))
    .filter((file) => !/(^|\/)(?:__tests__|e2e|fixtures|tests)(\/|$)/.test(file))
    .sort();
}

export function runSqlExecutionSurfaceGuard({ repoRoot, changedFilesJson, execGit } = {}) {
  const files = deriveChangedSqlExecutionFiles({ repoRoot, changedFilesJson, execGit });
  return classifySqlExecutionSurface({ repoRoot, files });
}
