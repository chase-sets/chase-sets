import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyChanges, listChangedFiles, toOutputMap } from "./change-scope.mjs";
import { estimatedE2eSuiteDurationSeconds } from "./e2e-suites.mjs";

function workspace(baseDir, root, dirName, name, dependencies = {}, chaseSets) {
  return {
    name,
    dir: path.join(baseDir, root, dirName),
    dirName,
    root,
    packageJson: {
      name,
      dependencies,
      chaseSets,
    },
  };
}

function batchDurationSeconds(batch) {
  return batch
    .split(",")
    .filter(Boolean)
    .reduce((total, suiteId) => total + estimatedE2eSuiteDurationSeconds(suiteId), 0);
}

describe("change-scope", () => {
  it("diffs changed files from the merge-base instead of the moving base branch tip", () => {
    const calls = [];
    const changedFiles = listChangedFiles("origin/main", "HEAD", {
      cwd: "/repo",
      execFileSync: (_command, args, options) => {
        calls.push({ args, cwd: options.cwd });
        if (args[0] === "merge-base") {
          return "abc123\n";
        }
        if (args[0] === "diff") {
          return "bounded-contexts/catalog/domain.ts\n";
        }
        throw new Error(`Unexpected git call: ${args.join(" ")}`);
      },
    });

    expect(changedFiles).toEqual(["bounded-contexts/catalog/domain.ts"]);
    expect(calls).toEqual([
      { args: ["merge-base", "origin/main", "HEAD"], cwd: "/repo" },
      { args: ["diff", "--name-only", "abc123...HEAD"], cwd: "/repo" },
    ]);
  });

  it("treats documentation-only changes as non-deployable", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["docs/runbooks/digitalocean-platform-deployment.md", "README.md"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.docsOnly).toBe(true);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.terraformRequired).toBe(false);
    expect(scope.exposurePostureChanged).toBe(false);
    expect(scope.affectedWorkspaces).toEqual([]);
  });

  it("maps marketplace OpenAPI docs to platform-api parity coverage", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["docs/api/marketplace.openapi.json"],
      workspaces: [
        {
          ...workspace(baseDir, "deployables", "platform-api", "@test/platform-api"),
          packageJson: {
            name: "@test/platform-api",
            dependencies: {},
            scripts: { test: "vitest run" },
          },
        },
      ],
    });

    expect(scope.docsOnly).toBe(false);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.affectedWorkspaces).toEqual(["@test/platform-api"]);
    expect(scope.directlyTestOnlyAffectedWorkspaces).toEqual(["@test/platform-api"]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(false);
    expect(scope.deployRequired).toBe(false);
  });

  it("maps context metadata route changes to platform-runtime and OpenAPI parity coverage", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/inventory/context.json"],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "inventory", "@test/inventory"),
        workspace(baseDir, "infrastructure", "platform-runtime", "@test/platform-runtime"),
        workspace(baseDir, "deployables", "platform-api", "@test/app-platform-api", {
          "@test/inventory": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/inventory", "@test/platform-runtime", "@test/app-platform-api"]);
    expect(scope.directlyTestOnlyAffectedWorkspaces).toEqual(["@test/app-platform-api", "@test/platform-runtime"]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(true);
  });

  it("escalates pricing event-subscription metadata to targeted DB admission", () => {
    const scope = classifyChanges({
      changedFiles: ["bounded-contexts/pricing/context.json"],
    });

    expect(scope.integrationRiskRequired).toBe(true);
    expect(scope.integrationRiskReason).toBe("Bounded-context metadata, including event subscriptions, changed");
    expect(scope.dbTestsRequired).toBe(true);
    expect(toOutputMap(scope).integration_risk_required).toBe("true");
    expect(toOutputMap(scope).integration_risk_reason).toBe(scope.integrationRiskReason);
  });

  it("escalates cross-context runtime composition to targeted DB admission", () => {
    const scope = classifyChanges({
      changedFiles: ["infrastructure/bounded-context-runtime/subscriptions.ts"],
    });

    expect(scope.integrationRiskRequired).toBe(true);
    expect(scope.integrationRiskReason).toBe("Cross-context subscription or runtime composition changed");
    expect(scope.dbTestsRequired).toBe(true);
  });

  it("escalates shared admin shell and router changes to affected admin E2E", () => {
    const scope = classifyChanges({
      changedFiles: ["deployables/admin-web/app/admin-root-shell.tsx"],
    });

    expect(scope.integrationRiskRequired).toBe(true);
    expect(scope.integrationRiskReason).toBe("Shared application shell or router changed");
    expect(scope.e2eSuiteIds).toEqual([
      "catalog_admin_integrations",
      "catalog_admin_modeling",
      "admin_growth",
      "admin_commerce",
      "admin_support",
      "admin_platform",
      "admin_auth",
      "admin_access",
    ]);
  });

  it("escalates design-system navigation changes to affected browser E2E", () => {
    const scope = classifyChanges({
      changedFiles: ["packages/design-system/src/components/actions/section-navigation.tsx"],
    });

    expect(scope.integrationRiskRequired).toBe(true);
    expect(scope.integrationRiskReason).toBe("Design-system navigation changed");
    expect(scope.e2eSuiteIds).toEqual([
      "marketplace_browse",
      "marketplace_account",
      "marketplace_checkout",
      "marketplace_seller",
      "catalog_admin_integrations",
      "catalog_admin_modeling",
      "admin_growth",
      "admin_commerce",
      "admin_support",
      "admin_platform",
      "admin_auth",
      "admin_access",
    ]);
  });

  it("keeps docs and ordinary single-slice changes on the fast lane", () => {
    const docsScope = classifyChanges({
      changedFiles: ["docs/runbooks/integration-risk.md"],
    });
    const sliceScope = classifyChanges({
      changedFiles: ["bounded-contexts/pricing/features/recommendations/domain/recommendation.ts"],
    });

    expect(docsScope.integrationRiskRequired).toBe(false);
    expect(docsScope.integrationRiskReason).toBe("No integration-risk change detected");
    expect(sliceScope.integrationRiskRequired).toBe(false);
    expect(sliceScope.integrationRiskReason).toBe("No integration-risk change detected");
  });

  it("keeps unrelated bounded-context changes from pulling platform-runtime into scope", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/inventory/features/import-batches/domain/import-batch.ts"],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "inventory", "@test/inventory"),
        workspace(baseDir, "infrastructure", "platform-runtime", "@test/platform-runtime"),
        workspace(baseDir, "deployables", "platform-api", "@test/app-platform-api", {
          "@test/inventory": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/inventory", "@test/app-platform-api"]);
    expect(scope.directlyTestOnlyAffectedWorkspaces).toEqual([]);
    expect(scope.affectedWorkspaces).not.toContain("@test/platform-runtime");
  });

  it("expands affected workspaces through workspace dependents", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["contracts/primitives/typed-ids.ts"],
      workspaces: [
        workspace(baseDir, "contracts", "primitives", "@test/primitives"),
        workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog", {
          "@test/primitives": "workspace:*",
        }),
        workspace(baseDir, "deployables", "public-web", "@test/public-web", {
          "@test/catalog": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/primitives", "@test/catalog", "@test/public-web"]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(true);
    expect(scope.deployRequired).toBe(true);
    expect(scope.exposurePostureCategories).toEqual([]);
    // #4864: a pure app-code change (no Helm/Terraform/deploy-script/deploy-
    // workflow surface touched) still needs a docker image, but must not get
    // a chase-sets-pr-<n> cluster preview -- it gets the CI compose
    // boot+smoke job instead.
    expect(scope.dockerImageRequired).toBe(true);
    expect(scope.clusterPreviewRequired).toBe(false);
    expect(scope.composeSmokeRequired).toBe(true);
  });

  it("reruns tests for dev-dependents of runtime changes without fanning out to their dependents", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/catalog/features/catalog-items/domain/catalog-item.ts"],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog"),
        {
          ...workspace(baseDir, "bounded-contexts", "inventory", "@test/inventory"),
          packageJson: {
            name: "@test/inventory",
            dependencies: {},
            devDependencies: { "@test/catalog": "workspace:*" },
            scripts: { "test:db": "test:db" },
          },
        },
        workspace(baseDir, "bounded-contexts", "marketplace", "@test/marketplace", {
          "@test/inventory": "workspace:*",
        }),
        workspace(baseDir, "deployables", "platform-api", "@test/platform-api", {
          "@test/catalog": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/catalog", "@test/inventory", "@test/platform-api"]);
    expect(scope.runtimeAffectedWorkspaces).toEqual(["@test/catalog", "@test/platform-api"]);
    expect(scope.devDependencyTestAffectedWorkspaces).toEqual(["@test/inventory"]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.dbTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(true);
  });

  it("keeps a catalog-internal domain edit inside the catalog runtime boundary", () => {
    const scope = classifyChanges({
      changedFiles: ["bounded-contexts/catalog/features/catalog-items/domain/catalog-item.ts"],
    });

    expect(scope.affectedWorkspaces.length).toBeLessThanOrEqual(10);
    expect(scope.affectedWorkspaces).toContain("@chase-sets/catalog");
    for (const workspaceName of [
      "@chase-sets/checkout",
      "@chase-sets/payments",
      "@chase-sets/settlement",
      "@chase-sets/pricing",
      "@chase-sets/marketplace",
      "@chase-sets/ordering",
    ]) {
      expect(scope.affectedWorkspaces).not.toContain(workspaceName);
    }
    // Acceptance tests in inventory and discovery mount the catalog module, so
    // their tests rerun without dragging their own dependents along.
    expect(scope.devDependencyTestAffectedWorkspaces).toEqual(["@chase-sets/discovery", "@chase-sets/inventory"]);
    expect(scope.dbTestsRequired).toBe(true);
  });

  it("fans a catalog-seed fixture edit out to every seed consumer", () => {
    const scope = classifyChanges({
      changedFiles: ["contracts/catalog-seed/ids.ts"],
    });

    for (const workspaceName of [
      "@chase-sets/catalog",
      "@chase-sets/catalog-seed",
      "@chase-sets/checkout",
      "@chase-sets/inventory",
      "@chase-sets/marketplace",
      "@chase-sets/marketplace-seed-testing",
      "@chase-sets/ordering",
    ]) {
      expect(scope.affectedWorkspaces).toContain(workspaceName);
    }
  });

  it("detects DB tests only when an affected workspace publishes a DB test script", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const fastScope = classifyChanges({
      baseDir,
      changedFiles: ["packages/design-system/button.tsx"],
      workspaces: [
        workspace(baseDir, "packages", "design-system", "@test/design-system"),
        {
          ...workspace(baseDir, "deployables", "platform-api", "@test/platform-api", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/platform-api",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: { "test:db": "test:db" },
          },
        },
      ],
    });

    expect(fastScope.dbTestsRequired).toBe(false);

    const dbScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/platform-api/src/main.ts"],
      workspaces: [
        workspace(baseDir, "packages", "design-system", "@test/design-system"),
        {
          ...workspace(baseDir, "deployables", "platform-api", "@test/platform-api", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/platform-api",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: { "test:db": "test:db" },
          },
        },
      ],
    });

    expect(dbScope.dbTestsRequired).toBe(true);
  });

  it("keeps DB-backed context test-only changes scoped to the owning workspace", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/catalog/tests/catalog-authoring/acceptance/admin-page-projections.test.ts"],
      workspaces: [
        {
          ...workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/catalog",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: {
              "test:unit": "test:unit",
              "test:db": "vitest run tests/catalog-authoring/acceptance/admin-page-projections.test.ts",
            },
          },
        },
        workspace(baseDir, "bounded-contexts", "discovery", "@test/discovery", {
          "@test/catalog": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/catalog"]);
    expect(scope.runtimeAffectedWorkspaces).toEqual([]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.dbTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(false);
    expect(scope.e2eTestsRequired).toBe(false);
  });

  it("requires DB tests only for affected workspaces that publish a DB test script", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/platform-api/__tests__/config.test.ts"],
      workspaces: [
        {
          ...workspace(baseDir, "deployables", "platform-api", "@test/platform-api", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/platform-api",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: { test: "test", "test:unit": "test:unit" },
          },
        },
      ],
    });

    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.dbTestsRequired).toBe(false);
  });

  it("narrows E2E requirements to marketplace-facing user journey surfaces", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const domainScope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/ordering/features/orders/domain/domain.ts"],
      workspaces: [workspace(baseDir, "bounded-contexts", "ordering", "@test/ordering")],
    });

    expect(domainScope.unitTestsRequired).toBe(true);
    expect(domainScope.e2eTestsRequired).toBe(false);
    expect(domainScope.e2eSuiteIds).toEqual([]);

    const routeScope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/marketplace/routes/account-listing.tsx"],
      workspaces: [workspace(baseDir, "bounded-contexts", "marketplace", "@test/marketplace")],
    });

    expect(routeScope.e2eTestsRequired).toBe(true);
    expect(routeScope.e2eSuiteIds).toEqual(["marketplace_account", "marketplace_seller"]);

    const deployableTestScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/marketplace/app/routes/account-listing.test.tsx"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(deployableTestScope.e2eTestsRequired).toBe(false);
    expect(deployableTestScope.e2eSuiteIds).toEqual([]);

    const deployableTestSupportScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/marketplace/app/routes/test-support/http.ts"],
      workspaces: [
        {
          ...workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web"),
          packageJson: {
            name: "@test/marketplace-web",
            dependencies: {},
            scripts: { test: "vitest run" },
          },
        },
      ],
    });

    expect(deployableTestSupportScope.affectedWorkspaces).toEqual(["@test/marketplace-web"]);
    expect(deployableTestSupportScope.runtimeAffectedWorkspaces).toEqual([]);
    expect(deployableTestSupportScope.unitTestsRequired).toBe(true);
    expect(deployableTestSupportScope.buildRequired).toBe(false);
    expect(deployableTestSupportScope.dockerImageRequired).toBe(false);
    expect(deployableTestSupportScope.e2eTestsRequired).toBe(false);
    expect(deployableTestSupportScope.e2eSuiteIds).toEqual([]);

    const deployableRouteScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/marketplace/app/routes/account-listing.tsx"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(deployableRouteScope.e2eTestsRequired).toBe(true);
    expect(deployableRouteScope.e2eSuiteIds).toEqual(["marketplace_seller"]);

    const deployableUtilityScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/marketplace/app/routes/manifest.ts"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(deployableUtilityScope.e2eTestsRequired).toBe(false);
    expect(deployableUtilityScope.e2eSuiteIds).toEqual([]);

    const deployableSpecScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/marketplace/e2e/item-detail.spec.ts"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(deployableSpecScope.runtimeAffectedWorkspaces).toEqual([]);
    expect(deployableSpecScope.unitTestsRequired).toBe(true);
    expect(deployableSpecScope.buildRequired).toBe(false);
    expect(deployableSpecScope.e2eTestsRequired).toBe(true);
    expect(deployableSpecScope.e2eSuiteIds).toEqual(["marketplace_browse"]);
  });

  it("routes root browser runtime changes to browser E2E suites", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["package.json", "pnpm-lock.yaml"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual([
      "marketplace_browse",
      "marketplace_account",
      "marketplace_checkout",
      "marketplace_seller",
      "catalog_admin_integrations",
      "catalog_admin_modeling",
      "admin_growth",
      "admin_commerce",
      "admin_support",
      "admin_platform",
      "admin_auth",
      "admin_access",
    ]);
  });

  it("keeps test typecheck configuration changes out of runtime fanout", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["tsconfig.tests.json", "test-env.d.ts"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(scope.localChecksRequired).toBe(true);
    expect(scope.unitTestsRequired).toBe(false);
    expect(scope.buildRequired).toBe(false);
    expect(scope.e2eTestsRequired).toBe(false);
  });

  it("re-runs every workspace's tests for root vitest configuration changes without runtime fanout", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["vitest.shared.mjs"],
      workspaces: [
        workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web"),
        workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog"),
      ],
    });

    expect(scope.localChecksRequired).toBe(true);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.affectedWorkspaces).toEqual(["@test/marketplace-web", "@test/catalog"]);
    expect(scope.runtimeAffectedWorkspaces).toEqual([]);
    expect(scope.buildRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.deployRequired).toBe(false);
    expect(scope.e2eTestsRequired).toBe(false);
  });

  it("does not expand bounded-context unit test changes to runtime dependents or E2E", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/catalog/features/catalog-items/ui/catalog-item-list-page.test.tsx"],
      workspaces: [
        {
          ...workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog", {}, { testProfile: "db" }),
          packageJson: {
            name: "@test/catalog",
            dependencies: {},
            chaseSets: { testProfile: "db" },
            scripts: {
              "test:unit": "test:unit",
              "test:db": "vitest run tests/catalog-authoring/acceptance/admin-page-projections.test.ts",
            },
          },
        },
        workspace(baseDir, "bounded-contexts", "discovery", "@test/discovery", {
          "@test/catalog": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/catalog"]);
    expect(scope.runtimeAffectedWorkspaces).toEqual([]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.dbTestsRequired).toBe(false);
    expect(scope.buildRequired).toBe(false);
    expect(scope.deployRequired).toBe(false);
    expect(scope.e2eTestsRequired).toBe(false);
  });

  it("emits duration-balanced suite batches for E2E matrix fanout", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["package.json"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });
    const suiteBatches = JSON.parse(toOutputMap(scope).e2e_suite_batches_json);
    const oldStaticBatches = [
      "marketplace_browse,marketplace_account",
      "marketplace_checkout,marketplace_seller",
      "catalog_admin_integrations,catalog_admin_modeling",
      "admin_growth,admin_commerce",
      "admin_support,admin_platform",
      "admin_auth,admin_access",
    ];
    const batchMeanSeconds =
      suiteBatches.reduce((total, batch) => total + batchDurationSeconds(batch), 0) / suiteBatches.length;
    const longestBatchDistanceFromMean = (batches) => Math.max(...batches.map(batchDurationSeconds)) - batchMeanSeconds;

    expect(suiteBatches).toEqual([
      "catalog_admin_integrations,admin_auth",
      "catalog_admin_modeling,admin_platform",
      "marketplace_checkout,admin_support",
      "marketplace_browse,marketplace_account",
      "admin_commerce,admin_access",
      "marketplace_seller,admin_growth",
    ]);
    expect(suiteBatches.flatMap((batch) => batch.split(",")).sort()).toEqual([...scope.e2eSuiteIds].sort());
    expect(new Set(suiteBatches.flatMap((batch) => batch.split(","))).size).toBe(scope.e2eSuiteIds.length);
    expect(longestBatchDistanceFromMean(suiteBatches)).toBeLessThan(longestBatchDistanceFromMean(oldStaticBatches) / 2);
    expect(toOutputMap(scope)).not.toHaveProperty("coverage_fast");
    expect(toOutputMap(scope)).not.toHaveProperty("coverage_summary");
    expect(toOutputMap(scope).exposure_posture_changed).toBe("false");
  });

  it("routes context UI and API slices to owned E2E suites", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [
        "bounded-contexts/discovery/features/search/ui/search-page.tsx",
        "bounded-contexts/checkout/features/cart/api/cart-routes.ts",
        "bounded-contexts/inventory/features/inventory/ui/account-inventory.tsx",
        "bounded-contexts/ordering/features/postage-policies/ui/postage-policy-detail-drawer.tsx",
        "bounded-contexts/identity/features/invitations/ui/invitation-detail-page.tsx",
      ],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "discovery", "@test/discovery"),
        workspace(baseDir, "bounded-contexts", "checkout", "@test/checkout"),
        workspace(baseDir, "bounded-contexts", "inventory", "@test/inventory"),
        workspace(baseDir, "bounded-contexts", "ordering", "@test/ordering"),
        workspace(baseDir, "bounded-contexts", "identity", "@test/identity"),
      ],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual([
      "marketplace_browse",
      "marketplace_checkout",
      "marketplace_seller",
      "admin_commerce",
      "admin_access",
    ]);
  });

  it("routes catalog admin integration routes to admin E2E", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [
        "bounded-contexts/catalog/routes/admin/integrations.tsx",
        "deployables/admin-web/app/routes/catalog-layout.tsx",
      ],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog"),
        workspace(baseDir, "deployables", "admin-web", "@test/admin-web"),
      ],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual([
      "catalog_admin_integrations",
      "catalog_admin_modeling",
      "admin_growth",
      "admin_commerce",
      "admin_support",
      "admin_platform",
      "admin_auth",
      "admin_access",
    ]);
  });

  it("routes catalog admin modeling routes to modeling E2E", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [
        "bounded-contexts/catalog/routes/admin/dimensions.tsx",
        "bounded-contexts/catalog/features/dimensions/ui/dimension-list-page.tsx",
      ],
      workspaces: [workspace(baseDir, "bounded-contexts", "catalog", "@test/catalog")],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual(["catalog_admin_modeling"]);
  });

  it("routes support platform feedback admin routes to admin support E2E", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/platform-operations/routes/admin/platform-feedback.tsx"],
      workspaces: [workspace(baseDir, "bounded-contexts", "platform-operations", "@test/platform-operations")],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual(["admin_support"]);
  });

  it("routes platform projection operations admin routes to admin platform E2E", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/platform-operations/routes/admin/projection-operations.tsx"],
      workspaces: [workspace(baseDir, "bounded-contexts", "platform-operations", "@test/platform-operations")],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual(["admin_platform"]);
  });

  it("routes bounded-context marketplace and admin routes by owned journey", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const marketplaceAccountScope = classifyChanges({
      baseDir,
      changedFiles: [
        "bounded-contexts/identity/routes/marketplace/account.tsx",
        "bounded-contexts/support/routes/marketplace/account-support.tsx",
        "bounded-contexts/marketplace/routes/marketplace/account-written-reviews.tsx",
      ],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "identity", "@test/identity"),
        workspace(baseDir, "bounded-contexts", "support", "@test/support"),
        workspace(baseDir, "bounded-contexts", "marketplace", "@test/marketplace"),
      ],
    });

    expect(marketplaceAccountScope.e2eTestsRequired).toBe(true);
    expect(marketplaceAccountScope.e2eSuiteIds).toEqual(["marketplace_account"]);

    const adminScope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/identity/routes/admin/users.tsx"],
      workspaces: [workspace(baseDir, "bounded-contexts", "identity", "@test/identity")],
    });

    expect(adminScope.e2eTestsRequired).toBe(true);
    expect(adminScope.e2eSuiteIds).toEqual(["admin_access"]);
  });

  it("routes milestone-25 decomposed routes to their owning E2E suites", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [
        "bounded-contexts/discovery/routes/item-detail.tsx",
        "bounded-contexts/checkout/routes/sell-checkout-session.tsx",
        "bounded-contexts/payments/routes/marketplace/account-payment.tsx",
        "bounded-contexts/payments/routes/marketplace/checkout-payment.tsx",
      ],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "discovery", "@test/discovery"),
        workspace(baseDir, "bounded-contexts", "checkout", "@test/checkout"),
        workspace(baseDir, "bounded-contexts", "payments", "@test/payments"),
      ],
    });

    expect(scope.e2eTestsRequired).toBe(true);
    expect(scope.e2eSuiteIds).toEqual(["marketplace_browse", "marketplace_checkout"]);
  });

  it("routes context changes to the consolidated marketplace seed DB acceptance suite", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/ordering/features/orders/domain/order.ts"],
      workspaces: [
        workspace(baseDir, "bounded-contexts", "ordering", "@test/ordering"),
        {
          ...workspace(baseDir, "deployables", "marketplace-seed-testing", "@test/marketplace-seed-testing", {
            "@test/ordering": "workspace:*",
          }),
          packageJson: {
            name: "@test/marketplace-seed-testing",
            dependencies: {
              "@test/ordering": "workspace:*",
            },
            chaseSets: { testProfile: "db" },
            scripts: { "test:db": "test:db" },
          },
        },
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/ordering", "@test/marketplace-seed-testing"]);
    expect(scope.dbTestsRequired).toBe(true);
  });

  it("keeps workflow-only changes out of deployment but scopes platform-*.yml to a cluster preview", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [".github/workflows/platform-pr.yml"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.workflowLintRequired).toBe(true);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    // #4864: a deploy-pipeline workflow file is a deploy surface even though
    // it never touches app code, so it still earns the real cluster preview
    // (this is also why this issue's own PR self-tests the new rule).
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("keeps non-platform workflow changes off the cluster-preview surface", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [".github/workflows/review-cadence-digest.yml"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.workflowLintRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    expect(scope.clusterPreviewRequired).toBe(false);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("treats Terraform and deployment helper changes as deployable infrastructure needing a cluster preview", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["infrastructure/digitalocean/platform/main.tf", "scripts/render-platform-helm-values.mjs"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.terraformRequired).toBe(true);
    expect(scope.deployRequired).toBe(true);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("keeps DOKS-only Terraform changes on the plan-only lane, off the cluster-preview surface", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["infrastructure/digitalocean/doks/main.tf"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.terraformRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.clusterPreviewRequired).toBe(false);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("routes Helm chart changes through manifest validation and a cluster preview without a docker image", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["infrastructure/helm/platform/templates/deployment.yaml"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.workflowLintRequired).toBe(true);
    expect(scope.terraformRequired).toBe(false);
    expect(scope.deployRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    // #4864: Helm changes are a deploy surface in their own right, even
    // without a docker image, because they alter what the cluster preview
    // (and staging/production) actually deploys.
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("routes the platform Kubernetes Secret helper through workflow lint and a cluster preview without deploying", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["scripts/platform-kubernetes-secret.mjs"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.workflowLintRequired).toBe(true);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.terraformRequired).toBe(false);
    // #4864: this script builds the runtime Secret every preview/staging/
    // production release applies, so a change here is env plumbing that
    // needs the real cluster preview, not just the dry-run in workflow lint.
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("routes the platform ingress wait helper through workflow lint and a cluster preview without deploying", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["scripts/platform-ingress-wait.mjs"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.workflowLintRequired).toBe(true);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.terraformRequired).toBe(false);
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("routes DOKS and platform Kubernetes deploy script changes onto the cluster-preview surface", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["scripts/doks-cluster-addons.mjs", "scripts/platform-kubernetes-deployment.mjs"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);
  });

  it("classifies exposure-posture changes for targeted release gates", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [
        "scripts/marketplace-tax-readiness-evidence.mjs",
        "scripts/marketplace-stripe-money-operations-evidence.mjs",
        "scripts/release-lock.mjs",
        "docs/adr/0002-adopt-ucp-for-agent-commerce.md",
      ],
      workspaces: [workspace(baseDir, "bounded-contexts", "platform-operations", "@test/platform-operations")],
    });

    expect(scope.exposurePostureChanged).toBe(true);
    expect(scope.exposurePostureCategories).toEqual([
      "live-money-provider",
      "rollout-policy",
      "tax-posture",
      "ucp-signed-write",
    ]);
    expect(JSON.parse(toOutputMap(scope).exposure_posture_categories_json)).toEqual(scope.exposurePostureCategories);
  });
});
