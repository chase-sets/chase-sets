import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";

const disclosureContracts = [
  {
    id: "catalog-import-context",
    ownerAttribute: "data-catalog-import-context-bar",
    triggerNameFragment: "Step 0 · Choose import scope",
    controls: [
      { id: "source-options", query: "text", name: "Source options" },
      { id: "provider", query: "role", role: "combobox", name: "Provider" },
    ],
  },
];

const locatorInteractionMethods = new Set([
  "check",
  "click",
  "count",
  "dblclick",
  "dispatchEvent",
  "evaluate",
  "evaluateAll",
  "fill",
  "focus",
  "getAttribute",
  "hover",
  "inputValue",
  "isChecked",
  "isDisabled",
  "isEditable",
  "isEnabled",
  "isHidden",
  "isVisible",
  "press",
  "selectOption",
  "setChecked",
  "textContent",
  "type",
  "uncheck",
  "waitFor",
]);

/**
 * Enforces disclosure state from Playwright interaction shape. Discovery mirrors
 * Playwright's deployable E2E spec surface and follows
 * sibling E2E helpers so safety does not depend on a spec filename or helper name.
 *
 * There is deliberately no allowlist. A disclosure-owned interaction must prove
 * its owner open in code; exceptions would recreate the class this guard closes.
 * The AST analysis is intentionally bounded to the registered accessible-control
 * contracts below; every contract must keep producing a discovered hit so a UI
 * rename cannot silently turn enforcement off.
 */
export async function validateBrowserE2eDisclosureGuard({ repoRoot, exemptions = [] }) {
  const discovery = await discoverBrowserE2eFiles(repoRoot);
  const parsedFiles = await Promise.all(
    discovery.sourceFiles.map(async (relativeFile) => {
      const source = await readFile(path.join(repoRoot, relativeFile), "utf8");
      return parseFile(relativeFile, source);
    }),
  );
  const filesByPath = new Map(parsedFiles.map((file) => [file.relativeFile, file]));
  const helperSummaries = summarizeHelpers(parsedFiles, filesByPath);
  const hits = [];

  for (const file of parsedFiles.filter((candidate) => discovery.candidateFiles.includes(candidate.relativeFile))) {
    analyzeSpecFile(file, helperSummaries, hits);
  }

  hits.sort(compareDiagnostics);
  const violations = hits
    .filter((hit) => hit.classification === "unsafe-collapsed-owner")
    .map(
      (hit) =>
        `${hit.file}:${hit.line}: ${hit.control} interaction has no preceding proof that disclosure '${hit.owner}' is open; scope the locator to its owner and use an executable open helper or assert aria-expanded=true first.`,
    );

  for (const contract of disclosureContracts) {
    for (const control of contract.controls) {
      if (
        !hits.some(
          (hit) =>
            hit.owner === contract.id &&
            hit.control === control.id &&
            hit.classification !== "outside-disclosure-ownership",
        )
      ) {
        violations.push(
          `browser E2E disclosure guard contract '${contract.id}/${control.id}' produced no discovered interaction; update the interaction shape or remove the contract after reviewing disclosure ownership.`,
        );
      }
    }
  }

  for (const exemption of exemptions) {
    violations.push(
      `browser E2E disclosure guard does not accept exemptions (${JSON.stringify(exemption)}); encode the owning disclosure's open/scope interaction instead.`,
    );
  }

  return {
    violations,
    hits,
    discovery: {
      scannedFiles: discovery.candidateFiles.length,
      candidateFiles: discovery.candidateFiles.length,
      tracedHelperFiles: discovery.helperFiles.length,
      files: discovery.candidateFiles,
    },
  };
}

async function discoverBrowserE2eFiles(repoRoot) {
  const deployablesRoot = path.join(repoRoot, "deployables");
  const allFiles = [];
  await walk(deployablesRoot, allFiles);
  const sourceFiles = allFiles
    .map((file) => relative(repoRoot, file))
    .filter((file) => /\/e2e\/.*\.(?:ts|tsx)$/.test(file))
    .sort();
  const candidateFiles = sourceFiles.filter((file) => /\.spec\.(?:ts|tsx)$/.test(file));
  const helperFiles = sourceFiles.filter((file) => !candidateFiles.includes(file));
  return { sourceFiles, candidateFiles, helperFiles };
}

async function walk(directory, files) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (["node_modules", "dist", "artifacts"].includes(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(entryPath, files);
    else if (entry.isFile()) files.push(entryPath);
  }
}

function parseFile(relativeFile, source) {
  return {
    relativeFile,
    source,
    sourceFile: ts.createSourceFile(relativeFile, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS),
  };
}

function summarizeHelpers(parsedFiles, filesByPath) {
  const summaries = new Map();
  for (const file of parsedFiles) {
    for (const fn of namedFunctions(file.sourceFile)) {
      const summary = summarizeHelper(fn.node, fn.name, file);
      if (summary) summaries.set(`${file.relativeFile}#${fn.name}`, summary);
    }
  }

  const bindingsByFile = new Map();
  for (const file of parsedFiles) {
    const bindings = new Map();
    for (const [key, summary] of summaries) {
      if (key.startsWith(`${file.relativeFile}#`)) bindings.set(key.slice(file.relativeFile.length + 1), summary);
    }
    for (const statement of file.sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      if (!statement.moduleSpecifier.text.startsWith(".")) continue;
      const importedFile = resolveRelativeImport(file.relativeFile, statement.moduleSpecifier.text, filesByPath);
      if (!importedFile) continue;
      const namedBindings = statement.importClause?.namedBindings;
      if (!namedBindings || !ts.isNamedImports(namedBindings)) continue;
      for (const element of namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        const summary = summaries.get(`${importedFile}#${importedName}`);
        if (summary) bindings.set(element.name.text, summary);
      }
    }
    bindingsByFile.set(file.relativeFile, bindings);
  }
  return bindingsByFile;
}

function summarizeHelper(node, name, file) {
  if (!node.body) return null;
  const parameters = node.parameters.map((parameter) => (ts.isIdentifier(parameter.name) ? parameter.name.text : null));
  const text = node.getText(file.sourceFile);
  const lastExpandedProof = text.lastIndexOf("toHaveAttribute");
  const lastTriggerClick = text.lastIndexOf(".click(");
  const hasExpandedProof =
    text.includes("aria-expanded") &&
    /["']true["']/.test(text) &&
    lastExpandedProof >= 0 &&
    lastExpandedProof > lastTriggerClick;
  const hasDisclosureClick = text.includes("aria-expanded") && text.includes(".click(");

  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index];
    if (!parameter) continue;
    const parameterFeedsTrigger = functionParameterFeedsTrigger(node, parameter);
    if (parameterFeedsTrigger && hasExpandedProof) {
      return { kind: "open-owner", name, ownerParameterIndex: index };
    }
    if ((parameterFeedsTrigger || functionParameterIsDisclosureTrigger(node, parameter)) && hasDisclosureClick) {
      const stateParameterIndex = parameters.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex !== index &&
          candidate &&
          new RegExp(`\\bString\\(\\s*${escapeRegExp(candidate)}\\s*\\)`).test(text),
      );
      if (stateParameterIndex >= 0) {
        return { kind: "set-owner-state", name, triggerParameterIndex: index, stateParameterIndex };
      }
    }
  }
  return null;
}

function functionParameterIsDisclosureTrigger(node, parameter) {
  const aliases = functionParameterAliases(node, parameter);
  let readsExpandedState = false;
  let clicksTrigger = false;
  visit(node.body, (candidate) => {
    if (!ts.isCallExpression(candidate)) return;
    const method = callMethod(candidate.expression);
    const receiver = method ? rootIdentifier(method.receiver) : null;
    if (!method || !receiver || !aliases.has(receiver)) return;
    if (method.name === "getAttribute" && literalText(candidate.arguments[0]) === "aria-expanded") {
      readsExpandedState = true;
    }
    if (method.name === "click") clicksTrigger = true;
  });
  return readsExpandedState && clicksTrigger;
}

function functionParameterFeedsTrigger(node, parameter) {
  const aliases = functionParameterAliases(node, parameter);
  let feedsTrigger = false;
  visit(node.body, (candidate) => {
    const query = locatorQuery(candidate);
    if (!query || query.method !== "getByRole" || query.role !== "button") return;
    if (!query.nameText?.includes("Step 0") || !query.nameText.includes("Choose import scope")) return;
    const receiver = rootIdentifier(query.receiver);
    if (receiver && aliases.has(receiver)) feedsTrigger = true;
  });
  return feedsTrigger;
}

function functionParameterAliases(node, parameter) {
  const aliases = new Set([parameter]);
  let changed = true;
  while (changed) {
    changed = false;
    visit(node.body, (candidate) => {
      if (!ts.isVariableDeclaration(candidate) || !ts.isIdentifier(candidate.name) || !candidate.initializer) return;
      const identifier = unwrappedIdentifier(candidate.initializer);
      if (identifier && aliases.has(identifier) && !aliases.has(candidate.name.text)) {
        aliases.add(candidate.name.text);
        changed = true;
      }
    });
  }
  return aliases;
}

function analyzeSpecFile(file, helperSummaries, hits) {
  const bindings = helperSummaries.get(file.relativeFile) ?? new Map();
  for (const fn of allFunctions(file.sourceFile)) {
    analyzeFunction(fn, file, bindings, hits);
  }
}

function analyzeFunction(fn, file, helperBindings, hits) {
  if (!fn.body) return;
  const env = buildLocatorEnvironment(fn, file);
  if (env.owners.size === 0 && env.targets.size === 0 && env.inlineTargets.length === 0) return;
  const stateEvents = disclosureStateEvents(fn, file, env, helperBindings);
  const interactions = targetInteractions(fn, file, env);

  for (const interaction of interactions) {
    const target = interaction.target;
    const contract = disclosureContracts.find((candidate) => candidate.id === target.contractId);
    if (!contract) continue;
    const owner = target.owner ?? soleOwner(env, target.contractId);
    const isOwned = target.controlId === "source-options" || Boolean(owner);
    let classification = "outside-disclosure-ownership";
    if (isOwned) {
      if (interaction.closedAssertion) {
        classification = "explicit-closed-negative-control";
      } else {
        const lastState = stateEvents
          .filter((event) => event.owner === owner && event.position < interaction.position)
          .sort((left, right) => right.position - left.position)[0];
        classification = lastState?.open === true ? "safe-open-owner" : "unsafe-collapsed-owner";
      }
    }
    const location = lineAndColumn(file.sourceFile, interaction.node);
    hits.push({
      file: file.relativeFile,
      line: location.line,
      column: location.column,
      owner: contract.id,
      control: target.controlId,
      classification,
    });
  }
}

function buildLocatorEnvironment(fn, file) {
  const pages = new Set();
  const owners = new Map();
  const triggers = new Map();
  const targets = new Map();
  const inlineTargets = [];

  for (const parameter of fn.parameters) {
    if (ts.isIdentifier(parameter.name) && parameter.type?.getText(file.sourceFile).endsWith("Page")) {
      pages.add(parameter.name.text);
    }
    if (ts.isObjectBindingPattern(parameter.name)) {
      for (const element of parameter.name.elements) {
        if (
          ts.isIdentifier(element.name) &&
          (element.propertyName?.getText(file.sourceFile) ?? element.name.text) === "page"
        ) {
          pages.add(element.name.text);
        }
      }
    }
  }

  const declarations = [];
  visit(
    fn.body,
    (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.push(node);
    },
    true,
  );

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const name = declaration.name.text;
      const initializer = unwrapExpression(declaration.initializer);
      const alias = unwrappedIdentifier(initializer);
      if (alias) {
        changed = copyClassification(alias, name, pages, owners, triggers, targets) || changed;
        continue;
      }
      const query = locatorQuery(initializer);
      if (!query) {
        const chainedTarget = targetFromExpression(initializer, { pages, owners, triggers, targets });
        if (chainedTarget && !targets.has(name)) {
          targets.set(name, chainedTarget);
          changed = true;
        }
        continue;
      }
      const receiver = classifyReceiver(query.receiver, { pages, owners, triggers, targets });
      for (const contract of disclosureContracts) {
        if (query.method === "locator" && selectorOwnsContract(query.selector, contract)) {
          if (!owners.has(name)) {
            owners.set(name, contract.id);
            changed = true;
          }
        }
        if (
          query.method === "getByRole" &&
          query.role === "button" &&
          query.nameText?.includes(contract.triggerNameFragment) &&
          receiver.kind === "owner" &&
          receiver.contractId === contract.id
        ) {
          if (!triggers.has(name)) {
            triggers.set(name, { contractId: contract.id, owner: receiver.name });
            changed = true;
          }
        }
        const target = targetFromQuery(query, receiver, contract);
        if (target && !targets.has(name)) {
          targets.set(name, target);
          changed = true;
        }
      }
    }
  }

  visit(
    fn.body,
    (node) => {
      const query = locatorQuery(node);
      if (!query) return;
      const receiver = classifyReceiver(query.receiver, { pages, owners, triggers, targets });
      for (const contract of disclosureContracts) {
        const target = targetFromQuery(query, receiver, contract);
        if (target) inlineTargets.push({ node, target });
      }
    },
    true,
  );

  return { pages, owners, triggers, targets, inlineTargets };
}

function copyClassification(from, to, pages, owners, triggers, targets) {
  if (pages.has(from) && !pages.has(to)) {
    pages.add(to);
    return true;
  }
  if (owners.has(from) && !owners.has(to)) {
    owners.set(to, owners.get(from));
    return true;
  }
  if (triggers.has(from) && !triggers.has(to)) {
    triggers.set(to, triggers.get(from));
    return true;
  }
  if (targets.has(from) && !targets.has(to)) {
    targets.set(to, targets.get(from));
    return true;
  }
  return false;
}

function disclosureStateEvents(fn, file, env, helperBindings) {
  const events = [];
  visit(
    fn.body,
    (node) => {
      if (!ts.isCallExpression(node)) return;
      const explicit = explicitExpandedExpectation(node, env);
      if (explicit) events.push({ ...explicit, position: node.getStart(file.sourceFile) });

      const directMethod = callMethod(node.expression);
      const directlyClickedTrigger =
        directMethod?.name === "click" ? triggerFromExpression(directMethod.receiver, env) : null;
      if (directlyClickedTrigger) {
        events.push({ owner: directlyClickedTrigger.owner, open: null, position: node.getStart(file.sourceFile) });
      }

      const invoked = invokedFunctionName(node.expression);
      if (!invoked) return;
      const summary = helperBindings.get(invoked);
      if (!summary) return;
      if (summary.kind === "open-owner") {
        const owner = ownerFromExpression(node.arguments[summary.ownerParameterIndex], env);
        if (owner) events.push({ owner, open: true, position: node.getStart(file.sourceFile) });
      }
      if (summary.kind === "set-owner-state") {
        const trigger = triggerFromExpression(node.arguments[summary.triggerParameterIndex], env);
        const state = booleanLiteral(node.arguments[summary.stateParameterIndex]);
        if (trigger && state !== null) {
          events.push({ owner: trigger.owner, open: state, position: node.getStart(file.sourceFile) });
        }
      }
    },
    true,
  );
  return events;
}

function explicitExpandedExpectation(node, env) {
  const matcher = callMethod(node.expression);
  if (!matcher || matcher.name !== "toHaveAttribute") return null;
  if (literalText(node.arguments[0]) !== "aria-expanded") return null;
  const openText = literalText(node.arguments[1]);
  if (openText !== "true" && openText !== "false") return null;
  const expectCall = unwrapExpectReceiver(matcher.receiver);
  const trigger = expectCall ? triggerFromExpression(expectCall.arguments[0], env) : null;
  return trigger ? { owner: trigger.owner, open: openText === "true" } : null;
}

function targetInteractions(fn, file, env) {
  const interactions = [];
  const seen = new Set();
  visit(
    fn.body,
    (node) => {
      if (!ts.isCallExpression(node)) return;
      const matcher = callMethod(node.expression);
      if (matcher) {
        const expectCall = unwrapExpectReceiver(matcher.receiver);
        if (expectCall) {
          const target = targetFromExpression(expectCall.arguments[0], env);
          if (target) {
            const key = `${node.getStart(file.sourceFile)}:${target.controlId}`;
            if (!seen.has(key)) {
              seen.add(key);
              interactions.push({
                node,
                target,
                position: node.getStart(file.sourceFile),
                closedAssertion:
                  matcher.name === "toBeHidden" ||
                  (matcher.name === "toHaveCount" && numericLiteral(node.arguments[0]) === 0) ||
                  matcher.negated,
              });
            }
          }
          return;
        }
      }

      if (!matcher || !locatorInteractionMethods.has(matcher.name)) return;
      const target = targetFromExpression(matcher.receiver, env);
      if (!target) return;
      const key = `${node.getStart(file.sourceFile)}:${target.controlId}`;
      if (seen.has(key)) return;
      seen.add(key);
      interactions.push({ node, target, position: node.getStart(file.sourceFile), closedAssertion: false });
    },
    true,
  );
  return interactions;
}

function targetFromExpression(expression, env) {
  const unwrapped = unwrapExpression(expression);
  if (!unwrapped) return null;
  if (ts.isIdentifier(unwrapped)) return env.targets.get(unwrapped.text) ?? null;
  const query = locatorQuery(unwrapped);
  if (query) {
    const receiver = classifyReceiver(query.receiver, env);
    for (const contract of disclosureContracts) {
      const target = targetFromQuery(query, receiver, contract);
      if (target) return target;
    }
  }
  const method = callMethod(ts.isCallExpression(unwrapped) ? unwrapped.expression : null);
  if (method && ["first", "last", "nth", "filter", "or"].includes(method.name)) {
    return targetFromExpression(method.receiver, env);
  }
  return null;
}

function targetFromQuery(query, receiver, contract) {
  for (const control of contract.controls) {
    const matches =
      control.query === "text"
        ? query.method === "getByText" && query.nameText === control.name
        : query.method === "getByRole" && query.role === control.role && query.nameText === control.name;
    if (!matches) continue;
    return {
      contractId: contract.id,
      controlId: control.id,
      owner: receiver.kind === "owner" && receiver.contractId === contract.id ? receiver.name : null,
      receiverKind: receiver.kind,
    };
  }
  return null;
}

function selectorOwnsContract(selector, contract) {
  if (!selector) return false;
  return new RegExp(`\\[\\s*${escapeRegExp(contract.ownerAttribute)}(?:\\s*=|\\s*\\])`).test(selector);
}

function classifyReceiver(expression, env) {
  const identifier = rootIdentifier(expression);
  if (!identifier) return { kind: "other", name: null };
  if (env.pages.has(identifier)) return { kind: "page", name: identifier };
  if (env.owners.has(identifier)) return { kind: "owner", name: identifier, contractId: env.owners.get(identifier) };
  return { kind: "other", name: identifier };
}

function ownerFromExpression(expression, env) {
  const identifier = rootIdentifier(expression);
  return identifier && env.owners.has(identifier) ? identifier : null;
}

function triggerFromExpression(expression, env) {
  const identifier = rootIdentifier(expression);
  return identifier ? (env.triggers.get(identifier) ?? null) : null;
}

function soleOwner(env, contractId) {
  const owners = [...env.owners].filter(([, candidateContract]) => candidateContract === contractId);
  return owners.length === 1 ? owners[0][0] : null;
}

function locatorQuery(node) {
  if (!ts.isCallExpression(node)) return null;
  const method = callMethod(node.expression);
  if (!method || !["locator", "getByText", "getByRole"].includes(method.name)) return null;
  if (method.name === "locator") {
    return { method: method.name, receiver: method.receiver, selector: literalText(node.arguments[0]) };
  }
  if (method.name === "getByText") {
    return { method: method.name, receiver: method.receiver, nameText: literalText(node.arguments[0]) };
  }
  return {
    method: method.name,
    receiver: method.receiver,
    role: literalText(node.arguments[0]),
    nameText: objectPropertyText(node.arguments[1], "name"),
  };
}

function callMethod(expression) {
  const unwrapped = unwrapExpression(expression);
  if (!unwrapped || !ts.isPropertyAccessExpression(unwrapped)) return null;
  let receiver = unwrapped.expression;
  let negated = false;
  if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "not") {
    negated = true;
    receiver = receiver.expression;
  }
  return { name: unwrapped.name.text, receiver, negated };
}

function unwrapExpectReceiver(expression) {
  const unwrapped = unwrapExpression(expression);
  return ts.isCallExpression(unwrapped) && invokedFunctionName(unwrapped.expression) === "expect" ? unwrapped : null;
}

function invokedFunctionName(expression) {
  const unwrapped = unwrapExpression(expression);
  return ts.isIdentifier(unwrapped) ? unwrapped.text : null;
}

function rootIdentifier(expression) {
  let current = unwrapExpression(expression);
  while (current) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isCallExpression(current)) {
      const method = callMethod(current.expression);
      current = method?.receiver ?? null;
      continue;
    }
    if (ts.isPropertyAccessExpression(current)) {
      current = current.expression;
      continue;
    }
    return null;
  }
  return null;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    current &&
    (ts.isAwaitExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current))
  ) {
    current = current.expression;
  }
  return current ?? null;
}

function unwrappedIdentifier(expression) {
  const unwrapped = unwrapExpression(expression);
  return ts.isIdentifier(unwrapped) ? unwrapped.text : null;
}

function literalText(node) {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped) return null;
  if (ts.isStringLiteralLike(unwrapped) || ts.isNoSubstitutionTemplateLiteral(unwrapped)) return unwrapped.text;
  if (ts.isRegularExpressionLiteral(unwrapped)) return unwrapped.text.slice(1, unwrapped.text.lastIndexOf("/"));
  return null;
}

function objectPropertyText(node, propertyName) {
  const unwrapped = unwrapExpression(node);
  if (!unwrapped || !ts.isObjectLiteralExpression(unwrapped)) return null;
  for (const property of unwrapped.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name.getText().replace(/["']/g, "");
    if (name === propertyName) return literalText(property.initializer);
  }
  return null;
}

function booleanLiteral(node) {
  const unwrapped = unwrapExpression(node);
  if (unwrapped?.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (unwrapped?.kind === ts.SyntaxKind.FalseKeyword) return false;
  return null;
}

function numericLiteral(node) {
  const unwrapped = unwrapExpression(node);
  return unwrapped && ts.isNumericLiteral(unwrapped) ? Number(unwrapped.text) : null;
}

function namedFunctions(sourceFile) {
  const functions = [];
  visit(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.push({ name: node.name.text, node });
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      functions.push({ name: node.name.text, node: node.initializer });
    }
  });
  return functions;
}

function allFunctions(sourceFile) {
  const functions = [];
  visit(sourceFile, (node) => {
    if (ts.isFunctionLike(node) && node.body) functions.push(node);
  });
  return functions;
}

function visit(node, callback, skipNestedFunctions = false) {
  const walkNode = (candidate, isRoot = false) => {
    if (skipNestedFunctions && !isRoot && ts.isFunctionLike(candidate)) return;
    callback(candidate);
    candidate.forEachChild((child) => walkNode(child, false));
  };
  walkNode(node, true);
}

function resolveRelativeImport(fromFile, specifier, filesByPath) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (filesByPath.has(candidate)) return candidate;
  }
  return null;
}

function lineAndColumn(sourceFile, node) {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: location.line + 1, column: location.character + 1 };
}

function compareDiagnostics(left, right) {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.column - right.column ||
    left.control.localeCompare(right.control)
  );
}

function relative(repoRoot, file) {
  return path.relative(repoRoot, file).replaceAll("\\", "/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (process.argv[1]?.endsWith("browser-e2e-disclosure-guard.mjs")) {
  const result = await validateBrowserE2eDisclosureGuard({ repoRoot: process.cwd() });
  if (process.argv.includes("--inventory")) {
    console.log(JSON.stringify({ discovery: result.discovery, hits: result.hits }, null, 2));
  }
  if (result.violations.length > 0) {
    console.error(result.violations.join("\n"));
    process.exitCode = 1;
  } else if (!process.argv.includes("--inventory")) {
    console.log(
      `browser E2E disclosure guard: scanned ${result.discovery.scannedFiles}/${result.discovery.candidateFiles} specs; traced ${result.discovery.tracedHelperFiles} helper files; ${result.hits.length} owned-control interactions are safe.`,
    );
  }
}
