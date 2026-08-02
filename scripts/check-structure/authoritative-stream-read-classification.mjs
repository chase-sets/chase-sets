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

  for (const sourceFile of program.getSourceFiles()) {
    const file = normalizeRepoFile(normalizedRepoRoot, sourceFile.fileName);
    if (!rootSet.has(file)) continue;
    visit(sourceFile, (node) => {
      if (!ts.isCallExpression(node)) return;
      const candidate = classifyCall({ repoRoot: normalizedRepoRoot, sourceFile, callNode: node, checker, anchors });
      if (candidate) candidates.push(candidate);
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
    diagnostics: [],
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

  const receiverType = checker.getTypeAtLocation(receiver);
  const namedProperty = ts.isPropertyAccessExpression(callee)
    ? followAlias(checker.getSymbolAtLocation(callee.name), checker)
    : followAlias(checker.getPropertyOfType(checker.getApparentType(receiverType), "readStream"), checker);
  const namedDeclarations = declarationSet(namedProperty, checker, repoRoot);
  const constituentDeclarations = declarationSetForReceiver(receiverType, checker, repoRoot);
  const declarationsAgree = equalStringArrays(namedDeclarations, constituentDeclarations);
  const declarations = declarationsAgree ? namedDeclarations : [];
  if (keyValues === null && declarations.length === 0) return null;

  let memberOrigin = "ABSENT";
  let outcome = "INDETERMINATE";
  let admitted = false;
  let receiverWidth = null;

  if (declarations.length === 0) {
    outcome = "AUTHORITY_ABSENT_READ_STREAM_CANDIDATE";
  } else {
    const allCanonical = everyDeclarationIs(declarations, anchors.canonicalDeclarations);
    const allHelper = everyDeclarationIs(declarations, anchors.helperDeclarations);
    const allForeign = declarations.every(
      (declaration) =>
        !anchors.canonicalDeclarations.includes(declaration) && !anchors.helperDeclarations.includes(declaration),
    );

    if (!allCanonical && !allHelper && !allForeign) {
      memberOrigin = "AMBIGUOUS";
      outcome = "AMBIGUOUS_MEMBER_ORIGIN";
    } else if (allForeign) {
      memberOrigin = "FOREIGN";
      const memberType = namedProperty ? checker.getTypeOfSymbolAtLocation(namedProperty, receiver) : undefined;
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
