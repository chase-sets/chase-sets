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

export const softwareDeliveryConceptGuardExtensions = new Set([".ts", ".tsx"]);

const softwareDeliveryConceptGuardRoots = ["bounded-contexts/", "deployables/"];

export const softwareDeliveryConceptGuards = [
  // Removed release-dashboard slice and equivalents.
  { label: "release-dashboard deployment surface", pattern: /\brelease-dashboard\b/i },
  { label: "releaseDashboard deployment surface", pattern: /\breleaseDashboard\b/ },
  // Removed release-controls slice and equivalents.
  { label: "release-controls deployment surface", pattern: /\brelease-controls\b/i },
  { label: "releaseControls deployment surface", pattern: /\breleaseControls\b/ },
  // Production release-lock used as a deploy gate. `releaseLock` / `release-lock`
  // are deploy-only identifiers (hold-release verbs use releaseHold / releaseFunds
  // and never collide with this token), so a word-anchored match is safe.
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

export function findSoftwareDeliveryConceptViolations({ relativeFile, content }) {
  const violations = softwareDeliveryConceptGuards.filter(
    (guard) =>
      (!guard.applies || guard.applies({ relativeFile, content })) &&
      (guard.pattern.test(relativeFile) || guard.pattern.test(content)),
  );

  if (isFeatureFlagDomainFile(relativeFile)) {
    violations.push(...featureFlagDomainGuards.filter((guard) => guard.pattern.test(content)));
  }

  return violations;
}
