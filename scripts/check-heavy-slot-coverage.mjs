import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "@chase-sets/typescript-compiler-api";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const guardFile = "scripts/lib/heavy-slot.mjs";
const reviewedCheapNodeEntrypoints = new Set([
  "bounded-contexts/public-presence/features/developer-portal/integrations/compile-developer-articles.mjs",
  "bounded-contexts/public-presence/features/help/integrations/compile-help-articles.mjs",
  "bounded-contexts/public-presence/features/policies/integrations/compile-policy-publications.mjs",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/generate-image-variants.mjs",
  "bounded-contexts/public-presence/features/waitlist/ui/assets/generate-og-images.mjs",
  "deployables/platform-api/scripts/check-bootstrap-db-enrollment.mjs",
  "scripts/benchmark-discovery-hybrid-retrieval.mjs",
  "scripts/campaign-market-data-snippets.mjs",
  "scripts/check-buyer-seller-jargon.mjs",
  "scripts/check-design-system-color-utilities.mjs",
  "scripts/check-design-system-export-coverage.mjs",
  "scripts/check-docs-index.mjs",
  "scripts/check-docs-path-claims.mjs",
  "scripts/check-env-examples.mjs",
  "scripts/check-github-actions-runtime.mjs",
  "scripts/check-localization.mjs",
  "scripts/check-no-any.mjs",
  "scripts/check-no-legacy-forms.mjs",
  "scripts/check-operator-surface-pm-content.mjs",
  "scripts/check-package-export-targets.mjs",
  "scripts/check-postage-adapter-boundaries.mjs",
  "scripts/check-responsive-safety.mjs",
  "scripts/check-structure.mjs",
  "scripts/check-structure/kb-reference-ratchet.mjs",
  "scripts/clean-coverage.mjs",
  "scripts/clean-logs.mjs",
  "scripts/coverage-summary.mjs",
  "scripts/db-test-preflight.mjs",
  "scripts/design-system-hoc-budget.mjs",
  "scripts/design-system-legacy-evidence.mjs",
  "scripts/design-system-legacy-inventory.mjs",
  "scripts/design-system-raw-ui-budget.mjs",
  "scripts/discovery-search-embedding-backfill.mjs",
  "scripts/discovery-search-relevance-embeddings.mjs",
  "scripts/discovery-search-relevance.mjs",
  "scripts/easypost-refund-event-replay.mjs",
  "scripts/emergency-recovery-guide.mjs",
  "scripts/environment-topology-guard.mjs",
  "scripts/generate-agent-connector-packaging.mjs",
  "scripts/generate-design-system-component-index.mjs",
  "scripts/generate-readme-manifest-sections.mjs",
  "scripts/guest-buy-now-freshness-probe.mjs",
  "scripts/local-env.mjs",
  "scripts/managed-registry-authority-guard.mjs",
  "scripts/marketplace-provider-proof-status.mjs",
  "scripts/observability-stack.mjs",
  "scripts/ops.mjs",
  "scripts/platform-helm-local-boot.mjs",
  "scripts/platform-kubernetes-deployment.mjs",
  "scripts/platform-smoke.mjs",
  "scripts/remote-dev.mjs",
  "scripts/replay-projection.mjs",
  "scripts/representative-snapshot.mjs",
  "scripts/rollback-readiness.mjs",
  "scripts/run-catalog-observation-pack-capture.mjs",
  "scripts/run-catalog-real-provider-proof.mjs",
  "scripts/sandbox.mjs",
  "scripts/staging-mixed-version-wake-drill.mjs",
  "scripts/staging-wake-drills.mjs",
  "scripts/stripe-cli.mjs",
  "scripts/stripe-money-smoke-test.mjs",
  "scripts/sync-workspace-metadata.mjs",
  "scripts/verify-observation-pack.mjs",
  "scripts/verify-static-scoped.mjs",
  "scripts/verify-typecheck.mjs",
  "scripts/workflow-canonical-artifacts.mjs",
  "scripts/worktree-deps.mjs",
]);
const escapedDirectEntrypoints = [
  "scripts/check-structure/browser-e2e-disclosure-guard.mjs",
  "scripts/check-structure/provider-scope-picker-shape-guard.mjs",
  "scripts/managed-postgres-authority-guard.mjs",
];
const optionValues = new Set([
  "--config",
  "-c",
  "--dir",
  "-C",
  "--filter",
  "-F",
  "--project",
  "--reporter",
  "--testNamePattern",
  "-t",
  "--testTimeout",
  "--maxWorkers",
  "--minWorkers",
  "--pool",
  "--shard",
  "--exclude",
]);
const explicitTestFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?(?::\d+)?$/i;
const sourceExtensionPattern = /\.(?:[cm]?[jt]sx?)$/i;
const nodeOptionsWithValues = new Set([
  "--conditions",
  "--diagnostic-dir",
  "--disable-warning",
  "--env-file",
  "--env-file-if-exists",
  "--experimental-loader",
  "--import",
  "--inspect-port",
  "--loader",
  "--openssl-config",
  "--permission",
  "--redirect-warnings",
  "--require",
  "-C",
  "-r",
]);

function normalize(relativePath) {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function trackedFiles(root) {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .map(normalize);
}

function tokenize(command) {
  return command.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, "$2")) ?? [];
}

function hasExplicitTestFile(argumentsList) {
  for (let index = 0; index < argumentsList.length; index += 1) {
    const token = argumentsList[index];
    if (optionValues.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    if (explicitTestFilePattern.test(token)) return true;
  }
  return false;
}

function isDatabaseTestScript(scriptName) {
  return /^test:db(?::.+)?$/.test(scriptName);
}

function nodeScriptFrom(tokens, nodeIndex) {
  for (let index = nodeIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") return tokens[index + 1] ?? null;
    if (!token.startsWith("-")) return token;
    const optionName = token.split("=", 1)[0];
    if (nodeOptionsWithValues.has(optionName) && !token.includes("=")) index += 1;
  }
  return null;
}

function resolveTrackedModule(root, packageDirectory, specifier, tracked) {
  const candidate = normalize(path.relative(root, path.resolve(root, packageDirectory, specifier)));
  return tracked.has(candidate) ? candidate : null;
}

function configFromVitestArguments(root, packageDirectory, argumentsList, tracked) {
  const configIndex = argumentsList.findIndex((argument) => argument === "--config" || argument === "-c");
  if (configIndex >= 0) {
    return resolveTrackedModule(root, packageDirectory, argumentsList[configIndex + 1] ?? "", tracked);
  }
  const candidates = [...tracked].filter(
    (file) =>
      path.posix.dirname(file) === normalize(packageDirectory) &&
      /^vitest\.config\.[cm]?[jt]s$/.test(path.posix.basename(file)),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

function deriveFromScript(root, scriptName, command, packageDirectory, tracked, entrypoints, unresolved) {
  for (const segment of command.split(/&&|\|\||;/)) {
    const tokens = tokenize(segment);
    const normalized = tokens.map((token) => path.posix.basename(token.replaceAll("\\", "/")).toLowerCase());
    const nodeIndex = normalized.findIndex((token) => token === "node" || token === "node.exe");
    if (nodeIndex >= 0) {
      const script = nodeScriptFrom(tokens, nodeIndex);
      const resolved = script ? resolveTrackedModule(root, packageDirectory, script, tracked) : null;
      if (!resolved) {
        unresolved.add(`${packageDirectory || "."}: ${segment.trim()}`);
      } else if (!reviewedCheapNodeEntrypoints.has(resolved)) entrypoints.add(resolved);
    }

    const vitestIndex = normalized.findIndex((token) => /^vitest(?:\.(?:mjs|js|cmd))?$/.test(token));
    if (vitestIndex >= 0 && normalized.slice(vitestIndex + 1).includes("run")) {
      const runIndex = normalized.indexOf("run", vitestIndex + 1);
      const argumentsList = tokens.slice(runIndex + 1);
      if (isDatabaseTestScript(scriptName) || !hasExplicitTestFile(argumentsList)) {
        const config = configFromVitestArguments(root, packageDirectory, argumentsList, tracked);
        if (config) entrypoints.add(config);
        else unresolved.add(`${packageDirectory || "."}: ${segment.trim()}`);
      }
    }

    const playwrightIndex = normalized.findIndex((token) => /^(?:playwright|playwright\.(?:cmd|js))$/.test(token));
    if (playwrightIndex >= 0 && normalized.slice(playwrightIndex + 1).includes("test")) {
      const config = [...tracked].find((file) => file === "playwright.config.ts");
      if (config) entrypoints.add(config);
      else unresolved.add(`${packageDirectory || "."}: ${segment.trim()}`);
    }
  }
}

function relativeImports(source) {
  const imports = [];
  const pattern = /(?:from\s+|import\s*\(|require\s*\()\s*["'](\.[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

function resolveImport(importer, specifier, tracked) {
  const base = normalize(path.posix.join(path.posix.dirname(importer), specifier));
  const candidates = [base, ...[".mjs", ".cjs", ".js", ".ts", ".tsx"].map((extension) => `${base}${extension}`)];
  return candidates.find((candidate) => tracked.has(candidate)) ?? null;
}

function importGraph(entrypoint, tracked, sources) {
  const visited = new Set();
  const pending = [entrypoint];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const source = sources.get(current);
    if (!source) continue;
    for (const specifier of relativeImports(source)) {
      const resolved = resolveImport(current, specifier, tracked);
      if (resolved) pending.push(resolved);
    }
  }
  return visited;
}

function scriptKind(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".ts")) return ts.ScriptKind.TS;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".json")) return ts.ScriptKind.JSON;
  return ts.ScriptKind.JS;
}

function parseSource(file, source) {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
}

function identifierName(node) {
  return node && ts.isIdentifier(node) ? node.text : null;
}

function importedGuardBindings(file, sourceFile, tracked) {
  const acquireBindings = new Set();
  const setupPathBindings = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (resolveImport(file, statement.moduleSpecifier.text, tracked) !== guardFile) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (importedName === "acquireHeavySlot" || importedName === "acquireVitestHeavySlot") {
        acquireBindings.add(element.name.text);
      }
      if (importedName === "heavySlotVitestGlobalSetupPath") {
        setupPathBindings.add(element.name.text);
      }
    }
  }
  return { acquireBindings, setupPathBindings };
}

function collectAliases(sourceFile, initialBindings) {
  const bindings = new Set(initialBindings);
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node) => {
      if (
        (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        bindings.has(node.initializer.text) &&
        !bindings.has(node.name.text)
      ) {
        bindings.add(node.name.text);
        changed = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return bindings;
}

function containsIdentifier(node, names) {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (ts.isIdentifier(child) && names.has(child.text)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function structurallyActivatesImportedGuard(file, source, tracked) {
  if (file === guardFile) return false;
  const sourceFile = parseSource(file, source);
  const { acquireBindings, setupPathBindings } = importedGuardBindings(file, sourceFile, tracked);
  const callableBindings = collectAliases(sourceFile, acquireBindings);
  let activates = false;
  const visit = (node) => {
    if (activates) return;
    if (ts.isCallExpression(node) && callableBindings.has(identifierName(node.expression))) {
      activates = true;
      return;
    }
    if (
      ts.isPropertyAssignment(node) &&
      (identifierName(node.name) === "globalSetup" ||
        (ts.isStringLiteral(node.name) && node.name.text === "globalSetup")) &&
      containsIdentifier(node.initializer, setupPathBindings)
    ) {
      activates = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return activates;
}

function isIdentifier(node, name) {
  return Boolean(node && ts.isIdentifier(node) && node.text === name);
}

function isString(node, value) {
  return Boolean(node && ts.isStringLiteral(node) && node.text === value);
}

function isCall(node, name, argumentsList) {
  return (
    Boolean(node) &&
    ts.isCallExpression(node) &&
    isIdentifier(node.expression, name) &&
    node.arguments.length === argumentsList.length &&
    node.arguments.every((argument, index) => argumentsList[index](argument))
  );
}

function isDevSystemGuardCondition(node) {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.BarBarToken &&
    ts.isBinaryExpression(node.left) &&
    node.left.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken &&
    isIdentifier(node.left.left, "mode") &&
    isString(node.left.right, "dev") &&
    ts.isPrefixUnaryExpression(node.right) &&
    node.right.operator === ts.SyntaxKind.ExclamationToken &&
    isCall(node.right.operand, "isBrowserE2eTarget", [(argument) => isIdentifier(argument, "targetName")])
  );
}

function hasCanonicalDevSystemHelper(source) {
  const sourceFile = parseSource("scripts/dev-system-config.mjs", source);
  const helper = sourceFile.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && identifierName(statement.name) === "acquireDevSystemHeavySlot",
  );
  if (!helper?.body || helper.body.statements.length !== 2) return false;
  const [rejection, acquisition] = helper.body.statements;
  return (
    ts.isIfStatement(rejection) &&
    isDevSystemGuardCondition(rejection.expression) &&
    ts.isReturnStatement(rejection.thenStatement) &&
    rejection.thenStatement.expression?.kind === ts.SyntaxKind.FalseKeyword &&
    ts.isReturnStatement(acquisition) &&
    isCall(acquisition.expression, "acquireSlot", [(argument) => isString(argument, "script-battery")])
  );
}

function hasCanonicalDevSystemWiring(source) {
  const sourceFile = parseSource("scripts/dev-system.mjs", source);
  return sourceFile.statements.some(
    (statement) =>
      ts.isExpressionStatement(statement) &&
      isCall(statement.expression, "acquireDevSystemHeavySlot", [
        (argument) => isIdentifier(argument, "mode"),
        (argument) => isIdentifier(argument, "target"),
        (argument) => isIdentifier(argument, "acquireHeavySlot"),
      ]),
  );
}

function structurallyActivatesGuard(entrypoint, graph, sources, tracked) {
  if (entrypoint === "scripts/dev-system.mjs") {
    return (
      hasCanonicalDevSystemWiring(sources.get(entrypoint) ?? "") &&
      hasCanonicalDevSystemHelper(sources.get("scripts/dev-system-config.mjs") ?? "")
    );
  }
  return [...graph].some((file) => structurallyActivatesImportedGuard(file, sources.get(file) ?? "", tracked));
}

export function checkHeavySlotCoverage(root = repoRoot) {
  const files = trackedFiles(root);
  const tracked = new Set(files);
  const sources = new Map(
    files
      .filter((file) => sourceExtensionPattern.test(file))
      .map((file) => [file, readFileSync(path.join(root, file), "utf8")]),
  );
  const entrypoints = new Set();
  const unresolved = new Set();

  for (const entrypoint of escapedDirectEntrypoints) {
    if (tracked.has(entrypoint)) entrypoints.add(entrypoint);
  }

  for (const packageFile of files.filter((file) => path.posix.basename(file) === "package.json")) {
    const packageJson = JSON.parse(readFileSync(path.join(root, packageFile), "utf8"));
    const packageDirectory = path.posix.dirname(packageFile) === "." ? "" : path.posix.dirname(packageFile);
    for (const [scriptName, command] of Object.entries(packageJson.scripts ?? {})) {
      if (typeof command === "string") {
        deriveFromScript(root, scriptName, command, packageDirectory, tracked, entrypoints, unresolved);
      }
    }
  }

  const violations = [];
  for (const entrypoint of [...entrypoints].sort()) {
    const graph = importGraph(entrypoint, tracked, sources);
    const reachesGuard = graph.has(guardFile);
    const activates = structurallyActivatesGuard(entrypoint, graph, sources, tracked);
    if (!reachesGuard || !activates) violations.push(`${entrypoint} does not activate ${guardFile}`);
  }
  for (const command of [...unresolved].sort()) {
    violations.push(`heavy command has no tracked artifact hook: ${command}`);
  }

  return {
    entrypoints: [...entrypoints].sort(),
    unresolved: [...unresolved].sort(),
    violations,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkHeavySlotCoverage();
  if (result.violations.length > 0) {
    console.error(result.violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      `Heavy-slot coverage: ${result.entrypoints.length}/${result.entrypoints.length} derived entry points guarded.`,
    );
  }
}
