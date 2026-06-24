// Bars software-delivery / deployment concepts from re-entering product code.
//
// The platform removed its release-dashboard and release-controls slices: shipping,
// promotion, and rollout gating belong to delivery tooling (scripts/, .github/,
// infrastructure/, docs/), never to bounded contexts or deployables. This guard
// fails the structure gate if any in-scope source reintroduces that machinery.
//
// Scope is deliberately narrow: only `.ts`/`.tsx` under bounded-contexts/** and
// deployables/**. Delivery tooling (scripts/, .github/, infrastructure/, docs/) is
// the legitimate home for release-lock CI, freshness/SLO canaries, and the
// release-process runbooks, so it is never scanned here.
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
  // Deploy-time feature-rollout / kill-switch as a domain concept. Only the
  // `feature-rollout` / `featureRollout` deployment compound is denied: catalog
  // import governance and discovery alias rollout legitimately own runtime
  // capability stops named kill-switch / killSwitch (env/config evaluated at
  // runtime, never a deploy-time constant), so those bare tokens stay allowed.
  { label: "feature-rollout deploy gate", pattern: /\bfeature-rollout\b/i },
  { label: "featureRollout deploy gate", pattern: /\bfeatureRollout\b/ },
  // Runtime reads of the GitHub Actions / git refs API from product code. CI
  // delivery scripts may call these; bounded contexts and deployables may not.
  { label: "runtime GitHub Actions workflows API read", pattern: /\bactions\/workflows\//i },
  { label: "runtime GitHub Actions runs API read", pattern: /\bactions\/runs\//i },
  { label: "runtime GitHub git refs API read", pattern: /\bgit\/ref(?:s)?\/heads\//i },
];

export function isSoftwareDeliveryConceptGuardedFile(relativeFile, extension) {
  return (
    softwareDeliveryConceptGuardExtensions.has(extension) &&
    softwareDeliveryConceptGuardRoots.some((root) => relativeFile.startsWith(root))
  );
}

export function findSoftwareDeliveryConceptViolations({ relativeFile, content }) {
  return softwareDeliveryConceptGuards.filter(
    (guard) => guard.pattern.test(relativeFile) || guard.pattern.test(content),
  );
}
