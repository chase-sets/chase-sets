import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "@chase-sets/typescript-compiler-api";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../lib/repo.mjs";

// Admission-removal census for #8945: every production RecordConsent
// construction and every generic Consent command-handler call, identified by
// file and owning function. Statements are selected by parsed shape and by the
// binding the compiler resolves, never by path vocabulary, so a production file
// whose name says "fixtures" is censused like any other. This is a bounded
// census of the generic recording admission, not #6399's append-position
// analyzer: it follows relative imports and does not resolve package
// specifiers.

const productionRoots = ["bounded-contexts/", "contracts/", "deployables/", "infrastructure/", "packages/"];
const nonProductionSegments = new Set([
  "__fixtures__",
  "__mocks__",
  "__tests__",
  "e2e",
  "fixtures",
  "generated",
  "node_modules",
  "test-support",
  "tests",
]);
const sourceFilePattern = /\.[cm]?tsx?$/;
const nonProductionFilePattern = /\.d\.[cm]?ts$|\.(?:test|spec|stories|test-support)\.[cm]?tsx?$/;
const candidateTokens = ["RecordConsent", "commandHandler", "consents", "ConsentServices", "createConsentRuntime"];

const identityRuntime = "bounded-contexts/identity/support/runtime-support";
const adminQaPath = `${identityRuntime}/admin-qa-actor-fixtures.ts`;
const seedPath = `${identityRuntime}/seed.ts`;
const productionBootstrapPath = `${identityRuntime}/production-bootstrap.ts`;
const termsRoutePath = "bounded-contexts/identity/features/consents/api/terms-route.ts";
const withdrawRoutePath = "bounded-contexts/identity/features/consents/api/route.ts";

const expectedConstructions = [
  "bounded-contexts/identity/api.ts :: planPersonalIdentityRegistration",
  `${termsRoutePath} :: termsOfServiceConsentRoutes`,
];
const expectedHandlerCalls = [
  `${withdrawRoutePath} :: consentRoutes`,
  `${termsRoutePath} :: termsOfServiceConsentRoutes`,
];
const removedConstructions = [
  `${adminQaPath} :: provisionAdminQaActorFixture`,
  `${seedPath} :: buildScenarioIdentityReconcilers`,
  `${seedPath} :: reconcileRepresentativeConsent`,
];
const removedHandlerCalls = [
  `${adminQaPath} :: provisionAdminQaActorFixture`,
  `${seedPath} :: buildScenarioIdentityReconcilers > consentReconciler > send`,
  `${seedPath} :: reconcileRepresentativeConsent`,
];

function isProductionSource(file) {
  if (!productionRoots.some((root) => file.startsWith(root))) return false;
  if (!sourceFilePattern.test(file) || nonProductionFilePattern.test(file)) return false;
  return !file
    .split("/")
    .slice(0, -1)
    .some((segment) => nonProductionSegments.has(segment));
}

const trackedProductionSources = execFileSync("git", ["ls-files", "-z"], {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .split("\0")
  .filter(Boolean)
  .filter(isProductionSource);

// Parsed artifacts are cached by file and text, so a control that overlays a
// few files re-parses only those files.
const diskTextCache = new Map();
const importCache = new Map();
const sourceFileCache = new Map();

function diskText(file) {
  if (!diskTextCache.has(file)) diskTextCache.set(file, readFileSync(path.join(repoRoot, file), "utf8"));
  return diskTextCache.get(file);
}

function cachedBy(cache, file, text, build) {
  const hit = cache.get(file);
  if (hit && hit.text === text) return hit.value;
  const value = build();
  cache.set(file, { text, value });
  return value;
}

function unwrap(node) {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isAwaitExpression(node))
  ) {
    node = node.expression;
  }
  return node;
}

function propertyKey(name) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(unwrap(name.expression))) {
    return unwrap(name.expression).text;
  }
  return undefined;
}

function stringKey(node) {
  const key = unwrap(node);
  return key && ts.isStringLiteralLike(key) ? key.text : undefined;
}

function annotationNamesConsentServices(typeNode) {
  return Boolean(typeNode) && /\bConsentServices\b/.test(typeNode.getText());
}

function ownerChain(node) {
  const names = [];
  for (let current = node.parent; current; current = current.parent) {
    let name;
    if (ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isClassDeclaration(current)) {
      name = propertyKey(current.name);
    } else if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const holder = current.parent;
      if (ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder)) name = propertyKey(holder.name);
    }
    if (name) names.unshift(name);
  }
  return names.join(" > ") || "<module>";
}

function isRecordConsentConstruction(node) {
  return (
    ts.isObjectLiteralExpression(node) &&
    node.properties.some(
      (member) =>
        ts.isPropertyAssignment(member) &&
        propertyKey(member.name) === "type" &&
        stringKey(member.initializer) === "RecordConsent",
    )
  );
}

/**
 * Binding-aware recognisers over one program's checker. A Consent service is
 * the Identity services' `consents` member, a binding annotated with
 * `ConsentServices`, or a `createConsentRuntime(...)` result; a handler is that
 * service's `commandHandler` reached directly, through a renamed or
 * destructured local, through an object property, or through an import alias.
 */
function createBindingRecognisers(checker) {
  const resolving = new Set();

  function declarationsOf(identifier) {
    let symbol = checker.getSymbolAtLocation(identifier);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations ?? [];
  }

  function once(node, work) {
    if (resolving.has(node)) return false;
    resolving.add(node);
    try {
      return work();
    } finally {
      resolving.delete(node);
    }
  }

  function patternSourceIsService(pattern) {
    const owner = pattern.parent;
    if (ts.isBindingElement(owner)) return propertyKey(owner.propertyName ?? owner.name) === "consents";
    if (ts.isVariableDeclaration(owner))
      return annotationNamesConsentServices(owner.type) || isService(owner.initializer);
    return ts.isParameter(owner) && annotationNamesConsentServices(owner.type);
  }

  function bindingIsService(declaration) {
    if (ts.isVariableDeclaration(declaration)) {
      return annotationNamesConsentServices(declaration.type) || isService(declaration.initializer);
    }
    if (ts.isParameter(declaration) || ts.isPropertySignature(declaration) || ts.isPropertyDeclaration(declaration)) {
      return annotationNamesConsentServices(declaration.type);
    }
    if (ts.isBindingElement(declaration))
      return propertyKey(declaration.propertyName ?? declaration.name) === "consents";
    return ts.isPropertyAssignment(declaration) && isService(declaration.initializer);
  }

  function isService(expression) {
    const node = unwrap(expression);
    if (!node) return false;
    return once(node, () => {
      if (ts.isPropertyAccessExpression(node)) {
        return node.name.text === "consents" || declarationsOf(node.name).some(bindingIsService);
      }
      if (ts.isElementAccessExpression(node)) return stringKey(node.argumentExpression) === "consents";
      if (ts.isIdentifier(node)) return declarationsOf(node).some(bindingIsService);
      if (ts.isCallExpression(node) && ts.isIdentifier(unwrap(node.expression))) {
        return declarationsOf(unwrap(node.expression)).some(
          (declaration) => ts.isFunctionDeclaration(declaration) && declaration.name?.text === "createConsentRuntime",
        );
      }
      return false;
    });
  }

  function bindingIsHandler(declaration) {
    if (ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration)) {
      return isHandler(declaration.initializer);
    }
    if (ts.isBindingElement(declaration)) {
      return (
        propertyKey(declaration.propertyName ?? declaration.name) === "commandHandler" &&
        patternSourceIsService(declaration.parent)
      );
    }
    if (ts.isParameter(declaration)) {
      return annotationNamesConsentServices(declaration.type) && /\bcommandHandler\b/.test(declaration.type.getText());
    }
    if (ts.isShorthandPropertyAssignment(declaration)) {
      return (checker.getShorthandAssignmentValueSymbol(declaration)?.declarations ?? []).some(bindingIsHandler);
    }
    return false;
  }

  function isHandler(expression) {
    const node = unwrap(expression);
    if (!node) return false;
    return once(node, () => {
      if (ts.isPropertyAccessExpression(node)) {
        if (node.name.text === "commandHandler" && isService(node.expression)) return true;
        return declarationsOf(node.name).some(bindingIsHandler);
      }
      if (ts.isElementAccessExpression(node)) {
        return stringKey(node.argumentExpression) === "commandHandler" && isService(node.expression);
      }
      return ts.isIdentifier(node) && declarationsOf(node).some(bindingIsHandler);
    });
  }

  return { isHandler };
}

function resolveRelativeImport(importer, specifier, known) {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier)).replace(/\.[cm]?js$/, "");
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.cts`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ].find((candidate) => known.has(candidate));
}

const compilerOptions = {
  noResolve: true,
  noLib: true,
  noEmit: true,
  jsx: ts.JsxEmit.Preserve,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  target: ts.ScriptTarget.Latest,
  allowImportingTsExtensions: true,
};

/**
 * Censuses the tracked production corpus, with `overlay` replacing or adding
 * file text in memory so negative controls run against the real tree without
 * writing to the checkout.
 */
function censusConsentRecordingAdmissions(overlay = new Map()) {
  const files = new Set(trackedProductionSources);
  for (const file of overlay.keys()) if (isProductionSource(file)) files.add(file);
  const textOf = (file) => (overlay.has(file) ? overlay.get(file) : diskText(file));

  // Token candidates, widened to every production module that relatively
  // imports a scanned module until nothing grows, so a renamed or re-exported
  // handler is followed to callers that never spell a token themselves.
  const scanned = new Set([...files].filter((file) => candidateTokens.some((token) => textOf(file).includes(token))));
  const importsOf = (file) =>
    cachedBy(importCache, file, textOf(file), () =>
      ts.preProcessFile(textOf(file), true, true).importedFiles.map(({ fileName }) => fileName),
    )
      .map((specifier) => resolveRelativeImport(file, specifier, files))
      .filter(Boolean);
  for (let grew = true; grew; ) {
    grew = false;
    for (const file of files) {
      if (!scanned.has(file) && importsOf(file).some((target) => scanned.has(target))) {
        scanned.add(file);
        grew = true;
      }
    }
  }

  const absolute = (file) => path.join(repoRoot, file).replaceAll("\\", "/");
  const relative = (fileName) => path.relative(repoRoot, fileName).replaceAll("\\", "/");
  const host = ts.createCompilerHost(compilerOptions, true);
  host.getSourceFile = (fileName, languageVersion) => {
    const file = relative(fileName);
    if (!scanned.has(file)) return undefined;
    return cachedBy(sourceFileCache, file, textOf(file), () =>
      ts.createSourceFile(fileName, textOf(file), languageVersion, true),
    );
  };
  host.fileExists = (fileName) => scanned.has(relative(fileName));
  host.readFile = (fileName) => (scanned.has(relative(fileName)) ? textOf(relative(fileName)) : undefined);
  const program = ts.createProgram({ rootNames: [...scanned].map(absolute), options: compilerOptions, host });
  const { isHandler } = createBindingRecognisers(program.getTypeChecker());

  const constructions = [];
  const handlerCalls = [];
  for (const file of scanned) {
    const visit = (node) => {
      if (isRecordConsentConstruction(node)) constructions.push(`${file} :: ${ownerChain(node)}`);
      if (ts.isCallExpression(node) && isHandler(node.expression)) handlerCalls.push(`${file} :: ${ownerChain(node)}`);
      ts.forEachChild(node, visit);
    };
    visit(program.getSourceFile(absolute(file)));
  }
  return {
    surface: { scanned: scanned.size, total: files.size },
    scanned,
    constructions: constructions.toSorted(),
    handlerCalls: handlerCalls.toSorted(),
  };
}

function insertBefore(text, anchor, insertion) {
  const index = text.indexOf(anchor);
  if (index < 0 || text.indexOf(anchor, index + 1) >= 0) throw new Error(`anchor must occur exactly once: ${anchor}`);
  return `${text.slice(0, index)}${insertion}${text.slice(index)}`;
}

const restoredAdminQaWrite = `  await services.consents.commandHandler({
    streamId: \`identity.consent-\${fixture.userId}\`,
    command: { type: "RecordConsent", subjectType: "user", userId: fixture.userId, accountId: fixture.accountId },
    context,
    authorization: undefined as never,
  });

`;

// The three removed writes, restored at their real paths and owners.
const restoredOverlay = new Map([
  [
    adminQaPath,
    insertBefore(diskText(adminQaPath), "  return {\n    actorAlias: fixture.actorAlias,", restoredAdminQaWrite),
  ],
  [
    seedPath,
    `${insertBefore(
      diskText(seedPath),
      "  const invitationReconciler = ",
      `  const consentReconciler = (id: string, steps: readonly unknown[]) =>
    createSeedAggregateReconciler({
      id,
      steps,
      send: (streamId: string, command: never) =>
        services.consents.commandHandler({ streamId, command, context, authorization: undefined as never }),
    } as never);
  void consentReconciler(demo.userId, [{ type: "RecordConsent", consentId: demo.userId }]);

`,
    )}
async function reconcileRepresentativeConsent(services: IdentityServices, context: IdentityBootstrapContext) {
  await services.consents.commandHandler({
    streamId: "identity.consent-restored",
    command: { type: "RecordConsent", consentId: "restored" },
    context,
    authorization: undefined as never,
  } as never);
}
`,
  ],
]);

// Writes the census must find: a removed write relocated to another
// production path, a renamed local, a destructured local, and a handler
// re-exported through two modules to a caller that spells no token.
const plantedOverlay = new Map([
  [
    productionBootstrapPath,
    `${diskText(productionBootstrapPath)}
async function relocatedConsentWrite(services: IdentityServices) {
  await services.consents.commandHandler({ command: { type: "RecordConsent" } } as never);
}
`,
  ],
  [
    adminQaPath,
    `${diskText(adminQaPath)}
async function renamedConsentWrite(services: IdentityServices) {
  const record = services.consents.commandHandler;
  await record({} as never);
}

async function destructuredConsentWrite(services: IdentityServices) {
  const { commandHandler: write } = services.consents;
  await write({} as never);
}
`,
  ],
  [
    `${identityRuntime}/zz-consent-writer.ts`,
    `import { createConsentRuntime } from "../../features/consents/api/runtime";
declare const deps: Parameters<typeof createConsentRuntime>[0];
const runtime = createConsentRuntime(deps);
export const { commandHandler: writeConsentFact } = runtime;
`,
  ],
  [
    `${identityRuntime}/zz-consent-writer-index.ts`,
    `export { writeConsentFact as recordAcceptance } from "./zz-consent-writer";\n`,
  ],
  [
    `${identityRuntime}/zz-consent-writer-caller.ts`,
    `import { recordAcceptance } from "./zz-consent-writer-index";
export async function acceptOnBehalf(input: never) {
  await recordAcceptance(input);
}
`,
  ],
]);

// Shapes that must contribute nothing: declarations, imports, comments,
// strings and comparisons in production, and real writes under test paths.
const restoredTestOnlyWrite = `import type { IdentityServices } from "./services";
export async function plantedWrite(services: IdentityServices) {
  await services.consents.commandHandler({ command: { type: "RecordConsent" } } as never);
}
`;
const inertOverlay = new Map([
  [
    `${identityRuntime}/zz-consent-inert.ts`,
    `import type { ConsentServices } from "../../features/consents/api/runtime";
// services.consents.commandHandler({ command: { type: "RecordConsent" } });
export type RestoredConsentCommand = { type: "RecordConsent"; handler: ConsentServices["commandHandler"] };
export const description = 'services.consents.commandHandler({ type: "RecordConsent" })';
export function isRecord(command: { type: string }) {
  return command.type === "RecordConsent";
}
`,
  ],
  ["bounded-contexts/identity/tests/zz-restored-write.test.ts", restoredTestOnlyWrite],
  ["bounded-contexts/identity/support/test-support/zz-restored-write.ts", restoredTestOnlyWrite],
  ["deployables/platform-api/__tests__/zz-restored-write.ts", restoredTestOnlyWrite],
  ["scripts/check-structure/fixtures/zz-restored-write.ts", restoredTestOnlyWrite],
]);

const live = censusConsentRecordingAdmissions();
const restored = censusConsentRecordingAdmissions(restoredOverlay);
const planted = censusConsentRecordingAdmissions(plantedOverlay);
const inert = censusConsentRecordingAdmissions(inertOverlay);

describe("Consent recording admission census", () => {
  it("leaves exactly the Terms and registration constructions and the Terms and withdrawal handler calls", () => {
    process.stdout.write(
      `consent-recording-admission-census=${JSON.stringify({
        surface: live.surface,
        constructions: live.constructions,
        handlerCalls: live.handlerCalls,
      })}\n`,
    );
    expect(live.constructions).toEqual(expectedConstructions);
    expect(live.handlerCalls).toEqual(expectedHandlerCalls);
  });

  it("scans the fixture-named admin-QA production module and reports scanned/total candidate files", () => {
    expect(isProductionSource(adminQaPath)).toBe(true);
    expect(live.scanned.has(adminQaPath)).toBe(true);
    expect(live.scanned.has(seedPath)).toBe(true);
    expect(live.surface.scanned).toBeGreaterThan(0);
    expect(live.surface.scanned).toBeLessThan(live.surface.total);
    expect(live.surface.total).toBe(trackedProductionSources.length);
  });

  it("reproduces the five-construction, five-call baseline when the removed writes are restored", () => {
    expect(restored.constructions).toEqual([...expectedConstructions, ...removedConstructions].toSorted());
    expect(restored.handlerCalls).toEqual([...expectedHandlerCalls, ...removedHandlerCalls].toSorted());
    expect(restored.constructions).not.toEqual(live.constructions);
    expect(restored.handlerCalls).not.toEqual(live.handlerCalls);
  });

  it("counts relocated writes, renamed and destructured locals, and re-exported handlers at their real calls", () => {
    expect(planted.constructions).toEqual(
      [...expectedConstructions, `${productionBootstrapPath} :: relocatedConsentWrite`].toSorted(),
    );
    expect(planted.handlerCalls).toEqual(
      [
        ...expectedHandlerCalls,
        `${productionBootstrapPath} :: relocatedConsentWrite`,
        `${adminQaPath} :: renamedConsentWrite`,
        `${adminQaPath} :: destructuredConsentWrite`,
        `${identityRuntime}/zz-consent-writer-caller.ts :: acceptOnBehalf`,
      ].toSorted(),
    );
  });

  it("counts nothing for declarations, imports, comments, strings, comparisons or test-path writes", () => {
    expect(inert.constructions).toEqual(expectedConstructions);
    expect(inert.handlerCalls).toEqual(expectedHandlerCalls);
    expect(inert.surface.total).toBe(live.surface.total + 1);
  });
});
