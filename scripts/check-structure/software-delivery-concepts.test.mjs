import { describe, expect, it } from "vitest";
import {
  findSoftwareDeliveryConceptViolations,
  isSoftwareDeliveryConceptGuardedFile,
} from "./software-delivery-concepts.mjs";

function labelsFor(relativeFile, content) {
  return findSoftwareDeliveryConceptViolations({ relativeFile, content }).map((guard) => guard.label);
}

describe("software delivery concepts guard", () => {
  it("guards only bounded-context and deployable .ts/.tsx source", () => {
    expect(isSoftwareDeliveryConceptGuardedFile("bounded-contexts/platform-operations/routes/admin/x.ts", ".ts")).toBe(
      true,
    );
    expect(isSoftwareDeliveryConceptGuardedFile("deployables/admin-web/app/routes/x.tsx", ".tsx")).toBe(true);
    // Delivery tooling stays out of scope: scripts/, .github/, infrastructure/, docs/.
    expect(isSoftwareDeliveryConceptGuardedFile("scripts/release-lock.mjs", ".mjs")).toBe(false);
    expect(isSoftwareDeliveryConceptGuardedFile("scripts/release-health.mjs", ".mjs")).toBe(false);
    expect(isSoftwareDeliveryConceptGuardedFile("infrastructure/digitalocean/platform/main.tf", ".tf")).toBe(false);
    expect(isSoftwareDeliveryConceptGuardedFile("docs/runbooks/release-process-evolution.md", ".md")).toBe(false);
    // Non-source extensions inside scope are not scanned.
    expect(isSoftwareDeliveryConceptGuardedFile("bounded-contexts/platform-operations/context.json", ".json")).toBe(
      false,
    );
    expect(isSoftwareDeliveryConceptGuardedFile("bounded-contexts/platform-operations/README.md", ".md")).toBe(false);
  });

  it("flags reintroduced release-dashboard and release-controls surfaces", () => {
    expect(
      labelsFor(
        "bounded-contexts/platform-operations/features/release-dashboard/ui/page.tsx",
        "export function ReleaseDashboardPage() {}",
      ),
    ).toEqual(expect.arrayContaining(["release-dashboard deployment surface"]));
    expect(
      labelsFor("deployables/admin-web/app/routes/release.tsx", "import { releaseDashboard } from '@x';"),
    ).toContain("releaseDashboard deployment surface");
    expect(
      labelsFor(
        "bounded-contexts/platform-operations/routes/admin/release-controls.tsx",
        "export const action = async () => null;",
      ),
    ).toContain("release-controls deployment surface");
    expect(labelsFor("deployables/admin-web/app/x.ts", "const releaseControls = {};")).toContain(
      "releaseControls deployment surface",
    );
  });

  it("flags production release-lock and production-marker deploy gates", () => {
    expect(
      labelsFor("bounded-contexts/platform-operations/domain/gate.ts", "if (PRODUCTION_RELEASE_LOCKED) {}"),
    ).toContain("PRODUCTION_RELEASE_LOCKED deploy gate");
    expect(labelsFor("deployables/platform-api/src/x.ts", "import '@x/release-lock';")).toContain(
      "release-lock deploy gate",
    );
    expect(labelsFor("bounded-contexts/platform-operations/domain/gate.ts", "const releaseLock = read();")).toContain(
      "releaseLock deploy gate",
    );
    expect(labelsFor("deployables/admin-web/app/x.ts", "const productionMarker = true;")).toContain(
      "productionMarker promotion gate",
    );
    expect(labelsFor("bounded-contexts/platform-operations/x.ts", "// production-marker promotion gate")).toContain(
      "production-marker promotion gate",
    );
  });

  it("flags deployment-canary promote/abort/decision machinery", () => {
    expect(labelsFor("bounded-contexts/platform-operations/domain/x.ts", "const r = canaryDecision();")).toContain(
      "deployment canary decision",
    );
    expect(labelsFor("deployables/platform-api/src/x.ts", "promoteCanary();")).toContain("deployment canary promote");
    expect(labelsFor("deployables/platform-api/src/x.ts", "abortCanary();")).toContain("deployment canary abort");
    expect(labelsFor("bounded-contexts/platform-operations/x.ts", "// canary-promote step")).toContain(
      "deployment canary promote/abort/decision (kebab)",
    );
    expect(labelsFor("bounded-contexts/platform-operations/x.ts", "// run a deployment canary")).toContain(
      "deployment canary phrase",
    );
  });

  it("flags deploy-time feature-rollout gates", () => {
    expect(labelsFor("bounded-contexts/platform-operations/domain/x.ts", "const featureRollout = {};")).toContain(
      "featureRollout deploy gate",
    );
    expect(labelsFor("deployables/admin-web/app/feature-rollout/page.tsx", "")).toContain(
      "feature-rollout deploy gate",
    );
  });

  it("flags runtime reads of the GitHub Actions and git refs API", () => {
    expect(
      labelsFor(
        "bounded-contexts/platform-operations/integrations/ci/source.ts",
        "await fetch('https://api.github.com/repos/o/r/actions/workflows/deploy.yml/runs');",
      ),
    ).toContain("runtime GitHub Actions workflows API read");
    expect(labelsFor("deployables/platform-api/src/x.ts", "await fetch(`${base}/actions/runs/${id}`);")).toContain(
      "runtime GitHub Actions runs API read",
    );
    expect(labelsFor("deployables/platform-api/src/x.ts", "await fetch(`${base}/git/refs/heads/main`);")).toContain(
      "runtime GitHub git refs API read",
    );
  });

  it("allows legitimate catalog release dates and inventory hold-release verbs", () => {
    const catalogReleaseDates = `
      interface CardSet { releaseDate: string; releasedAt: Date | null; }
      const sortKey = "release-date";
      export function nextRelease(set: CardSet) { return set.releaseDate; }
    `;
    expect(labelsFor("bounded-contexts/catalog/features/card-sets/domain/card-set.ts", catalogReleaseDates)).toEqual(
      [],
    );

    const inventoryReleaseVerbs = `
      export function releaseHold(holdId: string) {}
      export function releaseReservation(reservationId: string) {}
      export function releaseAllocation(allocationId: string) {}
      export function releaseFunds(walletId: string) {}
    `;
    expect(labelsFor("bounded-contexts/inventory/features/holds/domain/hold.ts", inventoryReleaseVerbs)).toEqual([]);
  });

  it("allows freshness canaries and bare release vocabulary in product code", () => {
    const freshnessCanary = `
      // Guest Buy Now freshness canary covers the signed-out path.
      const runbook = "docs/runbooks/guest-buy-now-freshness-probe.md";
      const note = "release the cart hold after checkout";
    `;
    expect(labelsFor("bounded-contexts/checkout/features/cart/domain/cart.ts", freshnessCanary)).toEqual([]);
  });

  it("allows catalog/discovery domain rollout-control and kill-switch vocabulary", () => {
    // These mirror real in-tree catalog import governance and discovery alias
    // rollout terms: runtime capability stops, not deploy-time gating.
    const governanceControls = `
      // Rollout kill-switch for alias contribution, an env/config value evaluated at runtime.
      const importKillSwitchActive = hasCapabilityStop(rolloutControls, "import");
      const blockers = paused ? ["kill-switch-active"] : [];
      function commandKey() { return "promotion-kill-switch"; }
    `;
    expect(
      labelsFor(
        "bounded-contexts/catalog/features/source-observations/ui/primary-workbench-governance-controls.ts",
        governanceControls,
      ),
    ).toEqual([]);
    expect(
      labelsFor(
        "bounded-contexts/discovery/features/search/domain/alias-rollout.ts",
        "// Rollout kill-switch for alias contribution to Discovery search.",
      ),
    ).toEqual([]);
  });
});
