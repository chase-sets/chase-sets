import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyChanges } from "./change-scope.mjs";

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

describe("change-scope", () => {
  it("treats documentation-only changes as non-deployable", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["docs/runbooks/digitalocean-platform-deployment.md", "README.md"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.docsOnly).toBe(true);
    expect(scope.deployRequired).toBe(false);
    expect(scope.dockerImageRequired).toBe(false);
    expect(scope.terraformRequired).toBe(false);
    expect(scope.affectedWorkspaces).toEqual([]);
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
    expect(scope.typecheckRequired).toBe(true);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.buildRequired).toBe(true);
    expect(scope.deployRequired).toBe(true);
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

  it("routes DB-backed context acceptance coverage through the DB-profile lane", () => {
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
            scripts: { "test:db": "test:db" },
          },
        },
        workspace(baseDir, "bounded-contexts", "discovery", "@test/discovery", {
          "@test/catalog": "workspace:*",
        }),
      ],
    });

    expect(scope.affectedWorkspaces).toEqual(["@test/catalog", "@test/discovery"]);
    expect(scope.unitTestsRequired).toBe(true);
    expect(scope.dbTestsRequired).toBe(true);
  });

  it("requires DB tests only for affected workspaces that publish a DB test script", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/admin-support-api/__tests__/config.test.ts"],
      workspaces: [
        {
          ...workspace(
            baseDir,
            "deployables",
            "admin-support-api",
            "@test/admin-support-api",
            {},
            { testProfile: "db" },
          ),
          packageJson: {
            name: "@test/admin-support-api",
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

    const routeScope = classifyChanges({
      baseDir,
      changedFiles: ["bounded-contexts/marketplace/routes/account-listing.tsx"],
      workspaces: [workspace(baseDir, "bounded-contexts", "marketplace", "@test/marketplace")],
    });

    expect(routeScope.e2eTestsRequired).toBe(true);

    const deployableScope = classifyChanges({
      baseDir,
      changedFiles: ["deployables/marketplace/app/routes/account-listing.test.tsx"],
      workspaces: [workspace(baseDir, "deployables", "marketplace", "@test/marketplace-web")],
    });

    expect(deployableScope.e2eTestsRequired).toBe(true);
  });

  it("keeps workflow-only changes out of deployment", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: [".github/workflows/platform-pr.yml"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.workflowLintRequired).toBe(true);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.deployRequired).toBe(false);
  });

  it("treats Terraform and deployment helper changes as deployable infrastructure", () => {
    const baseDir = path.join(process.cwd(), "repo");
    const scope = classifyChanges({
      baseDir,
      changedFiles: ["infrastructure/digitalocean/platform/main.tf", "scripts/digitalocean-app-deployment.mjs"],
      workspaces: [workspace(baseDir, "deployables", "public-web", "@test/public-web")],
    });

    expect(scope.terraformRequired).toBe(true);
    expect(scope.deployRequired).toBe(true);
    expect(scope.dockerImageRequired).toBe(false);
  });
});
