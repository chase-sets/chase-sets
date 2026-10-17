// Bars software-delivery / deployment concepts from re-entering product code.
//
// The platform removed its release-dashboard and release-controls slices: shipping,
// promotion, and rollout gating belong to delivery tooling (scripts/, .github/,
// infrastructure/, docs/). Feature flags are the deliberate exception: they may
// gate surfaces at composition edges, but must never enter domain decision code.
// This guard fails the structure gate if any in-scope source reintroduces
// delivery machinery or evaluates flags from domain code.
//
// Scope is deliberately narrow: only `.ts`/`.tsx` under bounded-contexts/** and
// deployables/**. Delivery tooling (scripts/, .github/, infrastructure/, docs/)
// is the legitimate home for release-lock CI, freshness/SLO canaries, and the
// release-process runbooks, so it is never scanned here. OpenFeature usage is
// allowed only at bounded-context composition edges (routes/api/ui) and thin
// deployable roots; bounded-context feature domain code stays deterministic.
//
// The deny patterns target deployment nouns only. Legitimate "release" vocabulary
// must keep passing: catalog card-set release dates (releaseDate / releasedAt /
// release-date) and inventory/ordering/settlement hold-release verbs (releaseHold /
// releaseReservation / releaseAllocation / releaseFunds). The word "canary" on its
// own is also allowed (freshness canaries are documented operational checks); only
// deployment-canary promote/abort/decision forms are denied.

import ts from "@chase-sets/typescript-compiler-api";

export const softwareDeliveryConceptGuardExtensions = new Set([".ts", ".tsx"]);

const softwareDeliveryConceptGuardRoots = ["bounded-contexts/", "deployables/"];

export const softwareDeliveryConceptGuards = [
  // Removed release-dashboard slice and equivalents.
  { label: "release-dashboard deployment surface", pattern: /\brelease-dashboard\b/i },
  { label: "releaseDashboard deployment surface", pattern: /\breleaseDashboard\b/ },
  // Removed release-controls slice and equivalents.
  { label: "release-controls deployment surface", pattern: /\brelease-controls\b/i },
  { label: "releaseControls deployment surface", pattern: /\breleaseControls\b/ },
  // Production release-lock used as a deploy gate. Only proven Web Streams reader
  // cleanup in the operator request codec is removed from the token scan below.
  { label: "PRODUCTION_RELEASE_LOCKED deploy gate", pattern: /\bPRODUCTION_RELEASE_LOCKED\b/ },
  { label: "release-lock deploy gate", pattern: /\brelease-lock\b/i },
  { label: "releaseLock deploy gate", pattern: /\breleaseLock\b/ },
  // Production marker promotion gate.
  { label: "production-marker promotion gate", pattern: /\bproduction-marker\b/i },
  { label: "productionMarker promotion gate", pattern: /\bproductionMarker\b/ },
  // Deployment canary machinery. The bare word "canary" stays allowed; only
  // promote/abort/decision deployment forms are denied.
  { label: "deployment canary decision", pattern: /\bcanaryDecision\b/ },
  { label: "deployment canary promote", pattern: /\b(?:canaryPromote|promoteCanary)\b/ },
  { label: "deployment canary abort", pattern: /\b(?:canaryAbort|abortCanary)\b/ },
  { label: "deployment canary promote/abort/decision (kebab)", pattern: /\bcanary-(?:promote|abort|decision)\b/i },
  { label: "deployment canary phrase", pattern: /\b(?:deployment|release)[- ]canary\b/i },
  // Deploy-time feature-rollout / kill-switch as a domain concept. Feature
  // rollout is now allowed at composition edges as the explicit m114 amendment,
  // but it is still banned everywhere else in bounded-context/deployable source.
  {
    label: "feature-rollout deploy gate",
    pattern: /\bfeature-rollout\b/i,
    applies: ({ relativeFile }) => !isFeatureFlagCompositionEdgeFile(relativeFile),
  },
  {
    label: "featureRollout deploy gate",
    pattern: /\bfeatureRollout\b/,
    applies: ({ relativeFile }) => !isFeatureFlagCompositionEdgeFile(relativeFile),
  },
  // Runtime reads of the GitHub Actions / git refs API from product code. CI
  // delivery scripts may call these; bounded contexts and deployables may not.
  { label: "runtime GitHub Actions workflows API read", pattern: /\bactions\/workflows\//i },
  { label: "runtime GitHub Actions runs API read", pattern: /\bactions\/runs\//i },
  { label: "runtime GitHub git refs API read", pattern: /\bgit\/ref(?:s)?\/heads\//i },
];

const featureFlagDomainGuards = [
  { label: "OpenFeature evaluation in domain code", pattern: /\bOpenFeature\b|@openfeature\//i },
  { label: "feature flag evaluation in domain code", pattern: /\bfeatureFlags?\b|\bflagClient\b/i },
  {
    label: "typed flag-value evaluation in domain code",
    pattern: /\bget(?:Boolean|String|Number|Object)Value\b/,
  },
];

function hasPathSegment(relativeFile, segment) {
  return relativeFile.split("/").includes(segment);
}

export function isFeatureFlagDomainFile(relativeFile) {
  return (
    relativeFile.startsWith("bounded-contexts/") &&
    (relativeFile.includes("/features/") || relativeFile.includes("/domain/")) &&
    (hasPathSegment(relativeFile, "domain") || /(?:^|\/)(?:decider|evolver|domain)(?:[-.]|$)/i.test(relativeFile))
  );
}

export function isFeatureFlagCompositionEdgeFile(relativeFile) {
  return (
    relativeFile.startsWith("deployables/") ||
    (relativeFile.startsWith("bounded-contexts/") &&
      (hasPathSegment(relativeFile, "routes") ||
        hasPathSegment(relativeFile, "api") ||
        hasPathSegment(relativeFile, "ui")))
  );
}

export function isSoftwareDeliveryConceptGuardedFile(relativeFile, extension) {
  return (
    softwareDeliveryConceptGuardExtensions.has(extension) &&
    softwareDeliveryConceptGuardRoots.some((root) => relativeFile.startsWith(root))
  );
}

function withoutOperatorRequestReaderCleanup(relativeFile, content) {
  if (
    relativeFile !== "bounded-contexts/catalog/features/operator-session/api/request.ts" ||
    !content.includes("releaseLock")
  )
    return content;
  const fileName = "operator-request-guard.ts";
  const options = { target: ts.ScriptTarget.ES2022, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], types: [], noEmit: true };
  const host = ts.createCompilerHost(options);
  const source = ts.createSourceFile(fileName, content, options.target, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...args) => (name === fileName ? source : getSourceFile(name, ...args));
  host.resolveModuleNames = (names) => names.map(() => undefined);
  const program = ts.createProgram([fileName], options, host);
  const checker = program.getTypeChecker();
  const nodes = [];
  function visit(node) {
    nodes.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const fromDom = (symbol) =>
    symbol?.declarations?.length > 0 &&
    symbol.declarations.every((declaration) => /[/\\]lib\.dom\.d\.ts$/.test(declaration.getSourceFile().fileName));
  const references = (symbol) =>
    nodes.filter((node) => ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol);
  const ranges = [];
  for (const node of nodes) {
    if (
      !ts.isCallExpression(node) ||
      node.arguments.length ||
      !ts.isPropertyAccessExpression(node.expression) ||
      node.expression.name.text !== "releaseLock"
    )
      continue;
    const receiver = node.expression.expression;
    if (!ts.isIdentifier(receiver)) continue;
    const symbol = checker.getSymbolAtLocation(receiver);
    const declaration = symbol?.valueDeclaration;
    if (
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !(declaration.parent.flags & ts.NodeFlags.Const) ||
      symbol.declarations.length !== 1
    )
      continue;
    const initializer = declaration.initializer;
    if (
      !initializer ||
      !ts.isCallExpression(initializer) ||
      initializer.arguments.length ||
      !ts.isPropertyAccessExpression(initializer.expression) ||
      initializer.expression.name.text !== "getReader"
    )
      continue;
    const body = initializer.expression.expression;
    if (!ts.isPropertyAccessExpression(body) || body.name.text !== "body" || !ts.isIdentifier(body.expression))
      continue;
    const requestSymbol = checker.getSymbolAtLocation(body.expression);
    const parameter = requestSymbol?.valueDeclaration;
    if (
      !parameter ||
      !ts.isParameter(parameter) ||
      !parameter.type ||
      parameter.type.getText(source) !== "Request" ||
      !fromDom(checker.getSymbolAtLocation(parameter.type.typeName))
    )
      continue;
    if (
      !fromDom(checker.getSymbolAtLocation(initializer.expression.name)) ||
      !fromDom(checker.getSymbolAtLocation(node.expression.name))
    )
      continue;
    // Neither the Request binding nor the const reader may escape or be mutated.
    if (
      !references(requestSymbol).every(
        (ref) =>
          ref === parameter.name ||
          (ts.isPropertyAccessExpression(ref.parent) &&
            ref.parent.expression === ref &&
            ref.parent.name.text === "body" &&
            ((ts.isPrefixUnaryExpression(ref.parent.parent) &&
              ref.parent.parent.operator === ts.SyntaxKind.ExclamationToken) ||
              ref.parent === body)),
      )
    )
      continue;
    if (
      !references(symbol).every(
        (ref) =>
          ref === declaration.name ||
          (ts.isPropertyAccessExpression(ref.parent) &&
            ref.parent.expression === ref &&
            ["read", "cancel", "releaseLock"].includes(ref.parent.name.text) &&
            ts.isCallExpression(ref.parent.parent) &&
            ref.parent.parent.expression === ref.parent),
      )
    )
      continue;
    ranges.push([node.expression.name.getStart(source), node.expression.name.end]);
  }
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0]))
    content = content.slice(0, start) + " ".repeat(end - start) + content.slice(end);
  return content;
}

export function findSoftwareDeliveryConceptViolations({ relativeFile, content }) {
  const readerCleanupContent = withoutOperatorRequestReaderCleanup(relativeFile, content);
  const violations = softwareDeliveryConceptGuards.filter(
    (guard) =>
      (!guard.applies || guard.applies({ relativeFile, content })) &&
      (guard.pattern.test(relativeFile) ||
        guard.pattern.test(guard.label === "releaseLock deploy gate" ? readerCleanupContent : content)),
  );

  if (isFeatureFlagDomainFile(relativeFile)) {
    violations.push(...featureFlagDomainGuards.filter((guard) => guard.pattern.test(content)));
  }

  return violations;
}
