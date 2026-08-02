import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";

const productionRoots = [
  "bounded-contexts",
  "contracts",
  "deployables",
  "infrastructure",
  "packages",
  "asset-env.d.ts",
  "tailwind.config.ts",
];
const productionExclusions = [/(?:^|\/)(?:tests|__tests__|build|dist|coverage)(?:\/|$)/, /\.(?:test|spec|tmp)\.[^/]+$/];
const productionExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

export function enumerateTrackedRoots(repoRoot, roots = productionRoots, exclusions = productionExclusions) {
  const normalizedRoots = roots.map(normalizePath);
  const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--", ...normalizedRoots], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  return tracked
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .filter((file) => isUnderRoots(file, normalizedRoots))
    .filter((file) => productionExtensions.has(extensionOf(file)))
    .filter((file) => exclusions.every((exclusion) => !matchesExclusion(file, exclusion)))
    .sort(compareCodeUnits);
}

export function createClassificationProgram(repoRoot, rootFileNames) {
  const independentlyDiscoveredRoots = enumerateTrackedRoots(repoRoot, productionRoots, productionExclusions);
  assertEqualStringSets(
    independentlyDiscoveredRoots,
    rootFileNames.map((file) => normalizeRepoFile(repoRoot, file)),
    "tracked roots and Program construction roots differ",
  );

  const configPath = path.join(repoRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(formatDiagnostics([config.error], repoRoot));

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    repoRoot,
    {
      allowJs: true,
      checkJs: false,
      noEmit: true,
      skipLibCheck: true,
    },
    configPath,
  );
  if (parsed.errors.length > 0) throw new Error(formatDiagnostics(parsed.errors, repoRoot));

  const absoluteRoots = rootFileNames.map((file) =>
    path.isAbsolute(file) ? path.normalize(file) : path.join(repoRoot, ...normalizePath(file).split("/")),
  );
  const program = ts.createProgram({ rootNames: absoluteRoots, options: parsed.options });
  const optionsDiagnostics = program.getOptionsDiagnostics();
  if (optionsDiagnostics.length > 0) throw new Error(formatDiagnostics(optionsDiagnostics, repoRoot));

  assertEqualStringSets(
    independentlyDiscoveredRoots,
    program.getRootFileNames().map((file) => normalizeRepoFile(repoRoot, file)),
    "tracked roots and Program root files differ",
  );
  const unloadedRoots = independentlyDiscoveredRoots.filter(
    (file) => program.getSourceFile(path.join(repoRoot, ...file.split("/"))) === undefined,
  );
  if (unloadedRoots.length > 0) {
    throw new Error(`Program did not load tracked roots: ${unloadedRoots.join(", ")}`);
  }

  return program;
}

export function resolveClassificationAnchors(repoRoot, program, checker) {
  const canonical = resolvePropertyAnchor({
    repoRoot,
    program,
    checker,
    file: "contracts/event-core/event-store.ts",
    typeName: "EventStore",
    propertyName: "readStream",
  });
  const helper = resolvePropertyAnchor({
    repoRoot,
    program,
    checker,
    file: "contracts/event-core/complete-stream.ts",
    typeName: "CompleteStreamReader",
    propertyName: "readStream",
  });

  return {
    canonical,
    helper,
    eventStoreType: canonical.ownerType,
    canonicalDeclarations: canonical.declarations,
    helperDeclarations: helper.declarations,
  };
}

export async function withTemporaryCorpus(seed, run) {
  const temporaryRoot = mkdtempSync(path.join(tmpdir(), "chase-sets-stream-read-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: temporaryRoot, stdio: "ignore", windowsHide: true });
    execFileSync("git", ["config", "user.email", "fixture@chase-sets.test"], {
      cwd: temporaryRoot,
      stdio: "ignore",
      windowsHide: true,
    });
    execFileSync("git", ["config", "user.name", "Chase Sets Fixture"], {
      cwd: temporaryRoot,
      stdio: "ignore",
      windowsHide: true,
    });

    const entries = typeof seed === "function" ? await seed(temporaryRoot) : seed;
    if (entries && typeof entries === "object") {
      for (const [relativeFile, contents] of Object.entries(entries)) {
        const target = path.resolve(temporaryRoot, ...normalizePath(relativeFile).split("/"));
        if (target !== temporaryRoot && !target.startsWith(`${temporaryRoot}${path.sep}`)) {
          throw new Error(`Temporary corpus entry escapes its repository: ${relativeFile}`);
        }
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, String(contents), "utf8");
      }
    }
    execFileSync("git", ["add", "--all"], { cwd: temporaryRoot, stdio: "ignore", windowsHide: true });
    return await run(temporaryRoot);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export function analyzeAuthoritativeStreamReads({ repoRoot }) {
  const normalizedRepoRoot = path.resolve(repoRoot);
  const roots = enumerateTrackedRoots(normalizedRepoRoot, productionRoots, productionExclusions);
  const program = createClassificationProgram(normalizedRepoRoot, roots);
  const checker = program.getTypeChecker();
  const anchors = resolveClassificationAnchors(normalizedRepoRoot, program, checker);
  const rootSet = new Set(roots);
  const candidates = [];
  const diagnosticsByNode = new Map();
  const resolvedAggregateFragments = new Set();
  const opaqueAggregateFragments = new Set();
  const detachmentAnalysis = {
    repoRoot: normalizedRepoRoot,
    program,
    checker,
    anchors,
    diagnosticsByNode,
    resolvedAggregateFragments,
    opaqueAggregateFragments,
  };

  for (const sourceFile of program.getSourceFiles()) {
    const file = normalizeRepoFile(normalizedRepoRoot, sourceFile.fileName);
    if (!rootSet.has(file)) continue;
    visit(sourceFile, (node) => {
      if (ts.isCallExpression(node)) {
        const candidate = classifyCall({ repoRoot: normalizedRepoRoot, sourceFile, callNode: node, checker, anchors });
        if (candidate) candidates.push(candidate);
      }
      analyzeDetachmentNode(detachmentAnalysis, sourceFile, node);
    });
  }

  candidates.sort(
    (left, right) =>
      compareCodeUnits(left.file, right.file) ||
      left.sourceStart - right.sourceStart ||
      compareCodeUnits(left.outcome, right.outcome),
  );
  const extensionCounts = Object.fromEntries(
    [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => [
      extension,
      roots.filter((file) => extensionOf(file) === extension).length,
    ]),
  );
  const diagnostics = [...diagnosticsByNode.values()].sort(
    (left, right) =>
      compareCodeUnits(left.file, right.file) ||
      left.sourceStart - right.sourceStart ||
      compareCodeUnits(left.outcome, right.outcome),
  );
  const totals = {
    roots: roots.length,
    loadedRoots: roots.filter((file) => program.getSourceFile(path.join(normalizedRepoRoot, ...file.split("/"))))
      .length,
    extensionCounts,
    discoveredCallCandidates: candidates.length,
    authoritativeSites: candidates.filter((candidate) => candidate.admitted).length,
    helperSites: countOutcome(candidates, "HELPER"),
    ambiguousOriginSites: countOutcome(candidates, "AMBIGUOUS_MEMBER_ORIGIN"),
    outOfLocationHelperSites: candidates.filter(
      (candidate) => candidate.memberOrigin === "HELPER" && candidate.outcome === "INDETERMINATE",
    ).length,
    insufficientReceiverContractSites: countOutcome(candidates, "INSUFFICIENT_RECEIVER_CONTRACT"),
    authorityAbsentCandidates: countOutcome(candidates, "AUTHORITY_ABSENT_READ_STREAM_CANDIDATE"),
    optionalSyntaxOutcomes: countOutcome(candidates, "CANONICAL_VALUE_ESCAPE"),
    dynamicKeyOutcomes: countOutcome(candidates, "CANONICAL_RECEIVER_DYNAMIC_KEY"),
    detachmentEscapeSites: diagnostics.length,
    resolvedAggregateFragments: resolvedAggregateFragments.size,
    opaqueAggregateFragments: opaqueAggregateFragments.size,
  };

  return {
    repoRoot: normalizedRepoRoot,
    ts,
    program,
    checker,
    roots,
    anchors,
    candidates,
    totals,
    diagnostics,
  };
}

function classifyCall({ repoRoot, sourceFile, callNode, checker, anchors }) {
  const callee = callNode.expression;
  if (!ts.isPropertyAccessExpression(callee) && !ts.isElementAccessExpression(callee)) return null;

  const receiver = callee.expression;
  const keyValues = ts.isPropertyAccessExpression(callee)
    ? new Set([callee.name.text])
    : evaluateStaticStringValues(callee.argumentExpression, checker);
  if (keyValues !== null && !keyValues.has("readStream")) return null;

  const namedProperty = ts.isPropertyAccessExpression(callee)
    ? followAlias(checker.getSymbolAtLocation(callee.name), checker)
    : undefined;
  const resolution = resolveReadStreamAuthority({
    repoRoot,
    receiver,
    namedProperty,
    requireNamedProperty: ts.isPropertyAccessExpression(callee),
    checker,
    anchors,
  });
  const { receiverType, declarations, allCanonical, allHelper, allForeign } = resolution;
  if (keyValues === null && declarations.length === 0) return null;

  let memberOrigin = "ABSENT";
  let outcome = "INDETERMINATE";
  let admitted = false;
  let receiverWidth = null;

  if (declarations.length === 0) {
    outcome = "AUTHORITY_ABSENT_READ_STREAM_CANDIDATE";
  } else {
    if (!allCanonical && !allHelper && !allForeign) {
      memberOrigin = "AMBIGUOUS";
      outcome = "AMBIGUOUS_MEMBER_ORIGIN";
    } else if (allForeign) {
      memberOrigin = "FOREIGN";
      const memberType = resolution.namedProperty
        ? checker.getTypeOfSymbolAtLocation(resolution.namedProperty, receiver)
        : undefined;
      const canonicalMemberType = checker.getTypeOfSymbolAtLocation(
        anchors.canonical.symbol,
        anchors.canonical.declaration,
      );
      outcome =
        memberType &&
        (checker.isTypeAssignableTo(memberType, canonicalMemberType) ||
          checker.isTypeAssignableTo(canonicalMemberType, memberType))
          ? "TWIN"
          : "UNRELATED";
    } else {
      memberOrigin = allCanonical ? "CANONICAL" : "HELPER";
      if (keyValues === null) {
        outcome = "CANONICAL_RECEIVER_DYNAMIC_KEY";
      } else if (hasOptionalToken(callNode, callee)) {
        outcome = "CANONICAL_VALUE_ESCAPE";
      } else if (allHelper) {
        if (normalizeRepoFile(repoRoot, sourceFile.fileName) === "contracts/event-core/complete-stream.ts") {
          outcome = "HELPER";
          admitted = true;
        }
      } else if (allCanonical) {
        receiverWidth = receiverHasFullEventStoreWidth(receiverType, anchors.eventStoreType, checker);
        if (receiverWidth) {
          outcome = "CANONICAL";
          admitted = true;
        } else {
          outcome = "INSUFFICIENT_RECEIVER_CONTRACT";
        }
      }
    }
  }

  const sourceStart = callNode.getStart(sourceFile);
  return {
    file: normalizeRepoFile(repoRoot, sourceFile.fileName),
    sourceFile,
    callNode,
    sourceStart,
    line: sourceFile.getLineAndCharacterOfPosition(sourceStart).line + 1,
    outcome,
    admitted,
    memberOrigin,
    receiverWidth,
    declarations,
  };
}

function analyzeDetachmentNode(analysis, sourceFile, node) {
  if (ts.isObjectBindingPattern(node)) analyzeBindingPattern(analysis, sourceFile, node);
  if (ts.isObjectLiteralExpression(node)) analyzeAssignmentPattern(analysis, sourceFile, node);
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    analyzeNonCalleeMemberAccess(analysis, sourceFile, node);
  }
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) analyzeInvocation(analysis, sourceFile, node);
}

function analyzeBindingPattern(analysis, sourceFile, pattern) {
  const sourceType = bindingPatternSourceType(pattern, analysis.checker);
  const selected = selectReadStreamPatternElement(pattern.elements, analysis.checker);
  if (!selected) return;
  if (selected.dotDotDotToken && !restKeepsResolvableReadStream(pattern.elements, selected, analysis.checker)) return;
  const resolution = resolveReadStreamAuthority({
    repoRoot: analysis.repoRoot,
    receiverType: sourceType,
    checker: analysis.checker,
    anchors: analysis.anchors,
  });
  if (resolution.allCanonical || resolution.allHelper) {
    recordDetachmentDiagnostic(analysis, sourceFile, selected, "CANONICAL_VALUE_ESCAPE");
  }
}

function bindingPatternSourceType(pattern, checker) {
  const owner = pattern.parent;
  if (ts.isVariableDeclaration(owner) && owner.name === pattern && owner.initializer) {
    return checker.getTypeAtLocation(owner.initializer);
  }
  return checker.getTypeAtLocation(pattern);
}

function analyzeAssignmentPattern(analysis, sourceFile, pattern) {
  const assignment = enclosingAssignment(pattern);
  if (!assignment) return;
  const selected = selectReadStreamPatternElement(pattern.properties, analysis.checker);
  if (!selected) return;
  if (
    ts.isSpreadAssignment(selected) &&
    !restKeepsResolvableReadStream(pattern.properties, selected, analysis.checker)
  ) {
    return;
  }
  const assignmentProperty = assignmentPropertyIdentifier(selected);
  const namedProperty = assignmentProperty
    ? followAlias(analysis.checker.getPropertySymbolOfDestructuringAssignment(assignmentProperty), analysis.checker)
    : undefined;
  const resolution = resolveReadStreamAuthority({
    repoRoot: analysis.repoRoot,
    receiverType: analysis.checker.getTypeAtLocation(assignment.right),
    namedProperty,
    requireNamedProperty: !ts.isSpreadAssignment(selected),
    checker: analysis.checker,
    anchors: analysis.anchors,
  });
  if (resolution.allCanonical || resolution.allHelper) {
    recordDetachmentDiagnostic(analysis, sourceFile, selected, "CANONICAL_VALUE_ESCAPE");
  }
}

function assignmentPropertyIdentifier(element) {
  if (
    (ts.isPropertyAssignment(element) || ts.isShorthandPropertyAssignment(element)) &&
    ts.isIdentifier(element.name)
  ) {
    return element.name;
  }
  return undefined;
}

function selectReadStreamPatternElement(elements, checker) {
  let restElement;
  for (const element of elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (element.dotDotDotToken || ts.isSpreadAssignment(element)) {
      restElement ??= element;
      continue;
    }
    const name = patternPropertyName(element);
    const keyValues = name ? evaluatePatternPropertyName(name, checker) : null;
    if (keyValues?.has("readStream")) return element;
  }
  return restElement;
}

function restKeepsResolvableReadStream(elements, restElement, checker) {
  for (const element of elements) {
    if (element === restElement) return true;
    if (ts.isOmittedExpression(element) || element.dotDotDotToken || ts.isSpreadAssignment(element)) continue;
    const name = patternPropertyName(element);
    if (!name || evaluatePatternPropertyName(name, checker) === null) return false;
  }
  return true;
}

function evaluatePatternPropertyName(name, checker) {
  if (ts.isComputedPropertyName(name)) return evaluateStaticStringValues(name.expression, checker);
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return new Set([name.text]);
  }
  return null;
}

function patternPropertyName(element) {
  if (ts.isBindingElement(element)) {
    if (element.propertyName) return element.propertyName;
    return ts.isIdentifier(element.name) ? element.name : undefined;
  }
  if (
    ts.isPropertyAssignment(element) ||
    ts.isShorthandPropertyAssignment(element) ||
    ts.isMethodDeclaration(element)
  ) {
    return element.name;
  }
  return undefined;
}

function enclosingAssignment(pattern) {
  let current = pattern;
  while (current.parent && isTransparentExpression(current.parent)) current = current.parent;
  return ts.isBinaryExpression(current.parent) &&
    current.parent.left === current &&
    current.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ? current.parent
    : undefined;
}

function analyzeNonCalleeMemberAccess(analysis, sourceFile, access) {
  if (isTypePosition(access) || isExactCallCallee(access)) return;
  const receiver = access.expression;
  const keyValues = ts.isPropertyAccessExpression(access)
    ? new Set([access.name.text])
    : evaluateStaticStringValues(access.argumentExpression, analysis.checker);
  if (keyValues !== null && !keyValues.has("readStream")) return;

  const namedProperty = ts.isPropertyAccessExpression(access)
    ? followAlias(analysis.checker.getSymbolAtLocation(access.name), analysis.checker)
    : undefined;
  const resolution = resolveReadStreamAuthority({
    repoRoot: analysis.repoRoot,
    receiver,
    namedProperty,
    requireNamedProperty: ts.isPropertyAccessExpression(access),
    checker: analysis.checker,
    anchors: analysis.anchors,
  });
  if (!resolution.allCanonical && !resolution.allHelper) return;

  if (keyValues === null) {
    recordDetachmentDiagnostic(analysis, sourceFile, access, "CANONICAL_RECEIVER_DYNAMIC_KEY");
    return;
  }
  const decidingNode = ts.isPropertyAccessExpression(access) ? access.name : access.argumentExpression;
  recordDetachmentDiagnostic(analysis, sourceFile, decidingNode, "CANONICAL_VALUE_ESCAPE");
}

function isExactCallCallee(access) {
  return ts.isCallExpression(access.parent) && access.parent.expression === access;
}

function isTypePosition(node) {
  for (let current = node; current; current = current.parent) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isStatement(current) || ts.isSourceFile(current)) return false;
  }
  return false;
}

function analyzeInvocation(analysis, sourceFile, invocation) {
  const logicalArguments = normalizeLogicalArguments(analysis, invocation.expression, invocation.arguments ?? []);
  const canonicalValues = logicalArguments.filter(
    (fragment) =>
      fragment.kind === "position" &&
      fragment.expression &&
      expressionHasCanonicalAuthority(analysis, fragment.expression),
  );
  if (canonicalValues.length === 0) return;

  for (const fragment of logicalArguments) {
    if (fragment.kind !== "position" || !fragment.expression) continue;
    const expression = unwrapTransparentExpression(fragment.expression);
    const keyValues = evaluateStaticStringValues(expression, analysis.checker);
    if (keyValues?.has("readStream")) {
      recordDetachmentDiagnostic(analysis, sourceFile, expression, "CANONICAL_VALUE_ESCAPE");
    }
  }
}

function normalizeLogicalArguments(analysis, callee, argumentsList) {
  let logicalArguments = expandSyntacticArguments(analysis, argumentsList);
  let target = unwrapTransparentExpression(callee);

  while (true) {
    const adapter = resolveSanctionedAdapter(analysis, target);
    if (!adapter) return logicalArguments;
    if (logicalArguments.length === 0 || logicalArguments[0].kind === "opaque") return [];

    if (adapter.kind === "call") {
      logicalArguments = logicalArguments.slice(1);
    } else {
      if (logicalArguments.length < 2 || logicalArguments[1].kind !== "position") return [];
      const packed = logicalArguments[1];
      if (!packed.expression) return [];
      const expanded = resolveAggregate(analysis, packed.expression, { nodes: new Set(), symbols: new Set() });
      if (expanded.some((fragment) => fragment.kind === "opaque")) return [];
      logicalArguments = expanded;
    }
    target = unwrapTransparentExpression(adapter.target);
  }
}

function expandSyntacticArguments(analysis, argumentsList) {
  const logicalArguments = [];
  for (const argument of argumentsList) {
    if (ts.isSpreadElement(argument)) {
      logicalArguments.push(
        ...resolveAggregate(analysis, argument.expression, { nodes: new Set(), symbols: new Set() }),
      );
    } else {
      logicalArguments.push({ kind: "position", node: argument, expression: argument });
    }
  }
  return logicalArguments;
}

function resolveSanctionedAdapter(analysis, candidate) {
  const access = unwrapTransparentExpression(candidate);
  if (!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) return undefined;

  let kind;
  if (ts.isPropertyAccessExpression(access)) {
    if (access.name.text !== "call" && access.name.text !== "apply") return undefined;
    kind = access.name.text;
  } else {
    const keyValues = evaluateStaticStringValues(access.argumentExpression, analysis.checker);
    if (keyValues === null || keyValues.size !== 1) return undefined;
    const [onlyValue] = keyValues;
    if (onlyValue !== "call" && onlyValue !== "apply") return undefined;
    kind = onlyValue;
  }

  const target = access.expression;
  const targetType = analysis.checker.getTypeAtLocation(target);
  if (analysis.checker.getSignaturesOfType(targetType, ts.SignatureKind.Call).length === 0) return undefined;
  const symbol = followAlias(
    analysis.checker.getPropertyOfType(analysis.checker.getApparentType(targetType), kind),
    analysis.checker,
  );
  const declarations = rawDeclarations(symbol, analysis.checker);
  if (
    declarations.length === 0 ||
    !declarations.every((declaration) => isDefaultLibraryAdapterDeclaration(analysis, declaration))
  ) {
    return undefined;
  }
  return { kind, target };
}

function isDefaultLibraryAdapterDeclaration(analysis, declaration) {
  const owner = declaration.parent;
  const sourceFile = declaration.getSourceFile();
  return (
    ts.isMethodSignature(declaration) &&
    ts.isInterfaceDeclaration(owner) &&
    (owner.name.text === "Function" || owner.name.text === "CallableFunction") &&
    analysis.program.isSourceFileDefaultLibrary(sourceFile) &&
    path.basename(sourceFile.fileName) === "lib.es5.d.ts"
  );
}

function rawDeclarations(symbol, checker) {
  if (!symbol) return [];
  const roots = typeof checker.getRootSymbols === "function" ? checker.getRootSymbols(symbol) : [symbol];
  return roots.flatMap((root) => followAlias(root, checker)?.declarations ?? root.declarations ?? []);
}

function resolveAggregate(analysis, expression, visited) {
  const original = expression;
  const value = unwrapTransparentExpression(expression);
  if (visited.nodes.has(value)) return opaqueAggregate(analysis, value);

  if (ts.isArrayLiteralExpression(value)) {
    const nextVisited = { nodes: new Set(visited.nodes).add(value), symbols: new Set(visited.symbols) };
    const fragments = [];
    for (const element of value.elements) {
      if (ts.isSpreadElement(element)) {
        fragments.push(...resolveAggregate(analysis, element.expression, nextVisited));
      } else {
        analysis.resolvedAggregateFragments.add(element);
        fragments.push({
          kind: "position",
          node: element,
          expression: ts.isOmittedExpression(element) ? undefined : element,
        });
      }
    }
    return fragments;
  }

  if (!ts.isIdentifier(value)) return opaqueAggregate(analysis, original);
  const symbol = followAlias(analysis.checker.getSymbolAtLocation(value), analysis.checker);
  if (!symbol || visited.symbols.has(symbol)) return opaqueAggregate(analysis, value);
  const declarations = symbol.declarations ?? [];
  if (declarations.length !== 1 || !ts.isVariableDeclaration(declarations[0])) return opaqueAggregate(analysis, value);
  const declaration = declarations[0];
  if (
    !declaration.initializer ||
    declaration.getSourceFile() !== value.getSourceFile() ||
    declaration.getStart(declaration.getSourceFile()) >= value.getStart(value.getSourceFile()) ||
    !isConstVariableDeclaration(declaration) ||
    !isStaticallyReadonlyAggregate(analysis.checker.getTypeAtLocation(value), analysis.checker)
  ) {
    return opaqueAggregate(analysis, value);
  }

  return resolveAggregate(analysis, declaration.initializer, {
    nodes: new Set(visited.nodes).add(value),
    symbols: new Set(visited.symbols).add(symbol),
  });
}

function opaqueAggregate(analysis, node) {
  analysis.opaqueAggregateFragments.add(node);
  return [{ kind: "opaque", node }];
}

function isConstVariableDeclaration(declaration) {
  return (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
}

function isStaticallyReadonlyAggregate(type, checker) {
  if (!type) return false;
  if (checker.isTupleType(type)) return type.target?.readonly === true;
  const apparent = checker.getApparentType(type);
  return apparent.symbol?.name === "ReadonlyArray" || apparent.aliasSymbol?.name === "ReadonlyArray";
}

function expressionHasCanonicalAuthority(analysis, expression) {
  const resolution = resolveReadStreamAuthority({
    repoRoot: analysis.repoRoot,
    receiver: unwrapTransparentExpression(expression),
    checker: analysis.checker,
    anchors: analysis.anchors,
  });
  return resolution.allCanonical || resolution.allHelper;
}

function recordDetachmentDiagnostic(analysis, sourceFile, node, outcome) {
  if (analysis.diagnosticsByNode.has(node)) return;
  const sourceStart = node.getStart(sourceFile);
  analysis.diagnosticsByNode.set(node, {
    file: normalizeRepoFile(analysis.repoRoot, sourceFile.fileName),
    sourceFile,
    node,
    sourceStart,
    line: sourceFile.getLineAndCharacterOfPosition(sourceStart).line + 1,
    outcome,
  });
}

function unwrapTransparentExpression(expression) {
  let current = expression;
  while (isTransparentExpression(current)) current = current.expression;
  return current;
}

function isTransparentExpression(node) {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  );
}

function resolveReadStreamAuthority({
  repoRoot,
  receiver,
  receiverType,
  namedProperty,
  requireNamedProperty = false,
  checker,
  anchors,
}) {
  const resolvedReceiverType = receiverType ?? checker.getTypeAtLocation(receiver);
  const resolvedNamedProperty = followAlias(
    requireNamedProperty
      ? namedProperty
      : (namedProperty ?? checker.getPropertyOfType(checker.getApparentType(resolvedReceiverType), "readStream")),
    checker,
  );
  const namedDeclarations = declarationSet(resolvedNamedProperty, checker, repoRoot);
  const constituentDeclarations = declarationSetForReceiver(resolvedReceiverType, checker, repoRoot);
  const declarations = equalStringArrays(namedDeclarations, constituentDeclarations) ? namedDeclarations : [];
  const allCanonical = everyDeclarationIs(declarations, anchors.canonicalDeclarations);
  const allHelper = everyDeclarationIs(declarations, anchors.helperDeclarations);
  const allForeign =
    declarations.length > 0 &&
    declarations.every(
      (declaration) =>
        !anchors.canonicalDeclarations.includes(declaration) && !anchors.helperDeclarations.includes(declaration),
    );
  return {
    receiverType: resolvedReceiverType,
    namedProperty: resolvedNamedProperty,
    declarations,
    allCanonical,
    allHelper,
    allForeign,
  };
}

function declarationSetForReceiver(type, checker, repoRoot, seen = new Set()) {
  if (!type || seen.has(type)) return [];
  seen.add(type);

  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint ? declarationSetForReceiver(constraint, checker, repoRoot, seen) : [];
  }
  if (type.isUnion()) {
    const sets = type.types.map((constituent) =>
      declarationSetForReceiver(constituent, checker, repoRoot, new Set(seen)),
    );
    if (sets.some((set) => set.length === 0)) return [];
    return uniqueSorted(sets.flat());
  }
  if (type.isIntersection()) {
    const sets = type.types
      .map((constituent) => declarationSetForReceiver(constituent, checker, repoRoot, new Set(seen)))
      .filter((set) => set.length > 0);
    return uniqueSorted(sets.flat());
  }

  const property = followAlias(checker.getPropertyOfType(checker.getApparentType(type), "readStream"), checker);
  return declarationSet(property, checker, repoRoot);
}

function declarationSet(symbol, checker, repoRoot) {
  if (!symbol) return [];
  const roots = typeof checker.getRootSymbols === "function" ? checker.getRootSymbols(symbol) : [symbol];
  const declarations = roots.flatMap((root) => followAlias(root, checker)?.declarations ?? root.declarations ?? []);
  return uniqueSorted(
    declarations.map((declaration) => {
      const sourceFile = declaration.getSourceFile();
      const line = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line + 1;
      return `${normalizeRepoFile(repoRoot, sourceFile.fileName)}:${line}`;
    }),
  );
}

function followAlias(symbol, checker) {
  let current = symbol;
  const seen = new Set();
  while (current && (current.flags & ts.SymbolFlags.Alias) !== 0 && !seen.has(current)) {
    seen.add(current);
    current = checker.getAliasedSymbol(current);
  }
  return current;
}

function receiverHasFullEventStoreWidth(receiverType, eventStoreType, checker, seen = new Set()) {
  if (!receiverType || seen.has(receiverType)) return false;
  seen.add(receiverType);
  if (receiverType.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(receiverType);
    return constraint ? receiverHasFullEventStoreWidth(constraint, eventStoreType, checker, seen) : false;
  }
  if (receiverType.isUnion()) {
    return receiverType.types.every((constituent) =>
      receiverHasFullEventStoreWidth(constituent, eventStoreType, checker, new Set(seen)),
    );
  }
  return checker.isTypeAssignableTo(receiverType, eventStoreType);
}

function evaluateStaticStringValues(expression, checker) {
  if (!expression) return null;
  if (ts.isStringLiteralLike(expression)) return new Set([expression.text]);
  if (ts.isParenthesizedExpression(expression)) return evaluateStaticStringValues(expression.expression, checker);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluateStaticStringValues(expression.left, checker);
    const right = evaluateStaticStringValues(expression.right, checker);
    if (left === null || right === null) return null;
    return new Set([...left].flatMap((leftValue) => [...right].map((rightValue) => leftValue + rightValue)));
  }

  const values = stringLiteralValues(checker.getTypeAtLocation(expression));
  return values.length > 0 ? new Set(values) : null;
}

function stringLiteralValues(type) {
  if (!type) return [];
  if ((type.flags & ts.TypeFlags.StringLiteral) !== 0) return [type.value];
  if (type.isUnion()) {
    const values = type.types.flatMap(stringLiteralValues);
    return values.length === type.types.length ? values : [];
  }
  return [];
}

function resolvePropertyAnchor({ repoRoot, program, checker, file, typeName, propertyName }) {
  const sourceFile = program.getSourceFile(path.join(repoRoot, ...file.split("/")));
  if (!sourceFile) throw new Error(`Classification anchor source is not loaded: ${file}`);
  const declaration = sourceFile.statements.find(
    (statement) => ts.isTypeAliasDeclaration(statement) && statement.name.text === typeName,
  );
  if (!declaration) throw new Error(`Classification anchor type is missing: ${file}#${typeName}`);
  const ownerType = checker.getTypeAtLocation(declaration.name);
  const symbol = followAlias(checker.getPropertyOfType(checker.getApparentType(ownerType), propertyName), checker);
  const declarations = declarationSet(symbol, checker, repoRoot);
  if (!symbol || declarations.length === 0) {
    throw new Error(`Classification anchor property is missing: ${file}#${typeName}.${propertyName}`);
  }
  return { file, typeName, propertyName, declaration, symbol, ownerType, declarations };
}

function hasOptionalToken(callNode, callee) {
  return callNode.questionDotToken !== undefined || callee.questionDotToken !== undefined;
}

function extensionOf(file) {
  if (file.endsWith(".d.ts")) return ".ts";
  return path.posix.extname(file);
}

function isUnderRoots(file, roots) {
  return roots.some((root) => file === root || (!path.posix.extname(root) && file.startsWith(`${root}/`)));
}

function matchesExclusion(file, exclusion) {
  if (exclusion instanceof RegExp) return exclusion.test(file);
  if (typeof exclusion === "function") return exclusion(file);
  return file === normalizePath(exclusion) || file.startsWith(`${normalizePath(exclusion)}/`);
}

function everyDeclarationIs(actual, allowed) {
  return actual.length > 0 && actual.every((declaration) => allowed.includes(declaration));
}

function countOutcome(candidates, outcome) {
  return candidates.filter((candidate) => candidate.outcome === outcome).length;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort(compareCodeUnits);
}

function equalStringArrays(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertEqualStringSets(expected, actual, message) {
  const normalizedExpected = uniqueSorted(expected.map(normalizePath));
  const normalizedActual = uniqueSorted(actual.map(normalizePath));
  if (!equalStringArrays(normalizedExpected, normalizedActual)) {
    const missing = normalizedExpected.filter((value) => !normalizedActual.includes(value));
    const unexpected = normalizedActual.filter((value) => !normalizedExpected.includes(value));
    throw new Error(`${message}; missing=[${missing.join(", ")}], unexpected=[${unexpected.join(", ")}]`);
  }
}

function formatDiagnostics(diagnostics, repoRoot) {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: normalizePath,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => "\n",
  });
}

function normalizeRepoFile(repoRoot, file) {
  const absolute = path.isAbsolute(file) ? file : path.join(repoRoot, file);
  return normalizePath(path.relative(repoRoot, absolute));
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function visit(root, callback) {
  const walk = (node) => {
    callback(node);
    ts.forEachChild(node, walk);
  };
  walk(root);
}
