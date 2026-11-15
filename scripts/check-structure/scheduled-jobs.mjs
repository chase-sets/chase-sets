import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { listBoundedContextManifests, repoRoot as defaultRoot } from "../lib/repo.mjs";

const parse = (file, source) => ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
const visit = (node, callback) => {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
};
const hasAnonymousShape = (node) =>
  ts.isTypeLiteralNode(node) ||
  (ts.isUnionTypeNode(node) && node.types.some(hasAnonymousShape)) ||
  (ts.isIntersectionTypeNode(node) && node.types.some(hasAnonymousShape)) ||
  (ts.isParenthesizedTypeNode(node) && hasAnonymousShape(node.type));

export function findAnonymousServiceAssertions(source, file = "worker.ts") {
  const tree = parse(file, source);
  const tainted = new Set(["services", "runtime", "mountedContexts"]);
  const functions = new Map();
  const callableAliases = new Map();
  const typeAliases = new Map();
  visit(tree, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isTypeAliasDeclaration(node)) typeAliases.set(node.name.text, node.type);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let value = node.initializer;
      while (ts.isParenthesizedExpression(value)) value = value.expression;
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) functions.set(node.name.text, value);
      else if (ts.isIdentifier(value)) callableAliases.set(node.name.text, value.text);
    }
  });
  const serviceBagType = (node, seen = new Set()) => {
    if (/WorkerHostRuntime|Record<string,unknown>/.test(node.getText(tree).replace(/\s/g, ""))) return true;
    let found = false;
    visit(node, (child) => {
      if (!ts.isTypeReferenceNode(child) || !ts.isIdentifier(child.typeName)) return;
      const name = child.typeName.text;
      const alias = typeAliases.get(name);
      if (alias && !seen.has(name)) {
        seen.add(name);
        found ||= serviceBagType(alias, seen);
      }
    });
    return found;
  };
  const calledFunction = (name, seen = new Set()) => {
    if (functions.has(name)) return functions.get(name);
    if (seen.has(name)) return undefined;
    seen.add(name);
    const alias = callableAliases.get(name);
    return alias && calledFunction(alias, seen);
  };
  visit(tree, (node) => {
    if (ts.isParameter(node) && node.type && serviceBagType(node.type)) {
      visit(node.name, (child) => {
        if (ts.isIdentifier(child)) tainted.add(child.text);
      });
    }
  });
  const derived = (node) => {
    let found = false;
    visit(node, (child) => {
      if (ts.isIdentifier(child) && tainted.has(child.text)) found = true;
      if (ts.isPropertyAccessExpression(child) && child.name.text === "services") found = true;
    });
    return found;
  };
  let changed = true;
  while (changed) {
    changed = false;
    visit(tree, (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const fn = calledFunction(node.expression.text);
        for (const [index, argument] of node.arguments.entries())
          if (fn?.parameters[index] && derived(argument)) {
            visit(fn.parameters[index].name, (child) => {
              if (ts.isIdentifier(child) && !tainted.has(child.text)) {
                tainted.add(child.text);
                changed = true;
              }
            });
          }
      }
      if (!ts.isVariableDeclaration(node) || !node.initializer || !derived(node.initializer)) return;
      visit(node.name, (child) => {
        if (ts.isIdentifier(child) && !tainted.has(child.text)) {
          tainted.add(child.text);
          changed = true;
        }
      });
    });
  }
  const violations = [];
  visit(tree, (node) => {
    if (!ts.isAsExpression(node) || !hasAnonymousShape(node.type) || !derived(node.expression)) return;
    violations.push({
      file,
      line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
      message: "Anonymous worker service assertion; import the owning real service contract.",
    });
  });
  return violations;
}

function resolveSymbol(checker, symbol) {
  const seen = new Set();
  while (symbol && symbol.flags & ts.SymbolFlags.Alias && !seen.has(symbol)) {
    seen.add(symbol);
    symbol = checker.getAliasedSymbol(symbol);
  }
  if (symbol?.valueDeclaration && ts.isShorthandPropertyAssignment(symbol.valueDeclaration)) {
    return resolveSymbol(checker, checker.getShorthandAssignmentValueSymbol(symbol.valueDeclaration));
  }
  if (symbol?.valueDeclaration && ts.isPropertyAssignment(symbol.valueDeclaration)) {
    return resolveSymbol(checker, checker.getSymbolAtLocation(symbol.valueDeclaration.initializer));
  }
  return symbol;
}

// The compiler follows actual aliases and module capabilities. A plausible name,
// comment or unbound server export is not a registration.
export function checkScheduledJobBindings({ program, contexts, rootDir, factoryFiles = new Set() }) {
  const checker = program.getTypeChecker(),
    violations = [];
  const problem = (context, job, message) =>
    violations.push({ file: `${context.root}/context.json`, message: `${context.contextName}/${job.id}: ${message}` });
  for (const context of contexts) {
    const index = program.getSourceFile(path.resolve(rootDir, context.root, "index.ts"));
    const server = program.getSourceFile(path.resolve(rootDir, context.root, "server.ts"));
    const exported = (file) =>
      file && checker.getSymbolAtLocation(file) ? checker.getExportsOfModule(checker.getSymbolAtLocation(file)) : [];
    const moduleSymbol = exported(index).find((symbol) => symbol.name === "module");
    const moduleType = moduleSymbol && checker.getTypeOfSymbolAtLocation(moduleSymbol, index);
    const table = moduleType && checker.getPropertyOfType(moduleType, "workerJobFactories");
    const tableType = table && checker.getTypeOfSymbolAtLocation(table, index);
    for (const job of context.scheduledJobs ?? []) {
      const publicSymbol = resolveSymbol(
        checker,
        exported(server).find((symbol) => symbol.name === job.runnerExport),
      );
      const binding = tableType && checker.getPropertyOfType(tableType, job.runnerExport);
      const boundSymbol = resolveSymbol(checker, binding);
      if (!publicSymbol || !binding || publicSymbol !== boundSymbol) {
        problem(
          context,
          job,
          `factory '${job.runnerExport}' must be the identical ./server export bound on entry.module`,
        );
        continue;
      }
      const ownerRoot = path.resolve(rootDir, context.root) + path.sep;
      if (
        !(publicSymbol.declarations ?? []).some((declaration) =>
          path.resolve(declaration.getSourceFile().fileName).startsWith(ownerRoot),
        )
      ) {
        problem(context, job, `factory '${job.runnerExport}' is owned by another context`);
        continue;
      }
      const type = checker.getTypeOfSymbolAtLocation(publicSymbol, server);
      const signatures = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
      const signature = signatures[0],
        declaration = signature?.declaration;
      let arrayType = declaration?.type;
      while (arrayType && (ts.isTypeOperatorNode(arrayType) || ts.isParenthesizedTypeNode(arrayType)))
        arrayType = arrayType.type;
      const elementType =
        arrayType && ts.isArrayTypeNode(arrayType)
          ? arrayType.elementType
          : arrayType && ts.isTypeReferenceNode(arrayType) && arrayType.typeArguments?.length === 1
            ? arrayType.typeArguments[0]
            : undefined;
      const runnerSymbol =
        elementType && ts.isTypeReferenceNode(elementType)
          ? resolveSymbol(checker, checker.getSymbolAtLocation(elementType.typeName))
          : undefined;
      const canonical =
        runnerSymbol?.name === "WorkerRunner" &&
        runnerSymbol.declarations?.some(
          (d) =>
            path.resolve(d.getSourceFile().fileName) ===
            path.resolve(rootDir, "contracts/bounded-context-module/index.ts"),
        );
      if (!signature || !canonical || !checker.isArrayType(checker.getReturnTypeOfSignature(signature)))
        problem(context, job, `factory '${job.runnerExport}' must return canonical WorkerRunner[]`);
      if (declaration) {
        for (const diagnostic of program.getSemanticDiagnostics(declaration.getSourceFile())) {
          if (diagnostic.start >= declaration.pos && diagnostic.start < declaration.end) {
            problem(
              context,
              job,
              `factory '${job.runnerExport}' does not typecheck: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
            );
          }
        }
        if (
          canonical &&
          !violations.some((violation) => violation.message.startsWith(`${context.contextName}/${job.id}:`))
        )
          factoryFiles.add(path.relative(rootDir, declaration.getSourceFile().fileName).replaceAll(path.sep, "/"));
      }
    }
  }
  return violations;
}

export function loadScheduledJobContexts({ repoRoot = defaultRoot } = {}) {
  return listBoundedContextManifests({ repoRoot })
    .filter((context) => context.manifest.scheduledJobs?.length)
    .map((context) => ({ ...context.manifest, root: path.relative(repoRoot, context.dir) }));
}

export function createScheduledJobProgram(contexts, { repoRoot = defaultRoot } = {}) {
  const rootNames = contexts.flatMap((context) =>
    ["index.ts", "server.ts"].map((file) => path.resolve(repoRoot, context.root, file)),
  );
  const config = ts.readConfigFile(path.join(repoRoot, "deployables/platform-worker/tsconfig.json"), ts.sys.readFile);
  // Roots are explicit; expanding the worker's repository-wide include globs
  // only to discard that file list makes compiler setup needlessly expensive.
  const options = ts.parseJsonConfigFileContent(
    config.config,
    { ...ts.sys, readDirectory: () => [] },
    path.join(repoRoot, "deployables/platform-worker"),
  ).options;
  const program = ts.createProgram({ rootNames, options });
  program.getTypeChecker();
  return program;
}

export function validateScheduledJobs({
  repoRoot = defaultRoot,
  contexts = loadScheduledJobContexts({ repoRoot }),
  program = createScheduledJobProgram(contexts, { repoRoot }),
} = {}) {
  const factoryFiles = new Set();
  const violations = checkScheduledJobBindings({ program, contexts, rootDir: repoRoot, factoryFiles });
  violations.push(...findWorkerServiceAssertions({ repoRoot }));
  return { violations, factoryFiles };
}

export function findWorkerServiceAssertions({ repoRoot = defaultRoot } = {}) {
  const violations = [];
  const sourceDir = path.join(repoRoot, "deployables/platform-worker/src");
  function scan(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (/\.tsx?$/.test(file))
        violations.push(
          ...findAnonymousServiceAssertions(
            readFileSync(file, "utf8"),
            path.relative(repoRoot, file).replaceAll(path.sep, "/"),
          ),
        );
    }
  }
  scan(sourceDir);
  return violations;
}
