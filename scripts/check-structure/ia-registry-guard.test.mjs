import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectRouteConfigLiteralPaths,
  computeContributedRouteFamilies,
  findIaRegistryViolations,
  iaFamilyKey,
  routeFamilySegment,
  validateIaRegistry,
  validateIaRegistryShape,
} from "./ia-registry-guard.mjs";

const tempRoots = [];

function createRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "cs-ia-registry-"));
  tempRoots.push(root);
  return root;
}

function writeFile(root, relativeFile, content) {
  const absolute = path.join(root, relativeFile);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function writeRegistry(root, registry) {
  writeFile(root, "scripts/check-structure/ia-registry.json", JSON.stringify(registry, null, 2));
}

function baseRegistry(overrides = {}) {
  return {
    families: [],
    infrastructureRoutes: {
      "admin-web": [],
      "marketplace-web": [],
      "public-web": [],
    },
    ...overrides,
  };
}

function contextManifest({ root, contextName, deployableContributions }) {
  return [root, { root, manifest: { contextName, deployableContributions } }];
}

function contribution(deployable, routes) {
  return { deployable, routes };
}

function routeModule(overrides = {}) {
  return {
    routeId: "widget",
    routePath: "widgets",
    fileExport: "./routes/marketplace/widgets",
    routeType: "route",
    sourceContext: "widgets",
    ...overrides,
  };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("routeFamilySegment", () => {
  it("returns the top-level path segment", () => {
    expect(routeFamilySegment("sessions/:id")).toBe("sessions");
    expect(routeFamilySegment("sessions")).toBe("sessions");
    expect(routeFamilySegment("")).toBe("");
  });
});

describe("computeContributedRouteFamilies", () => {
  it("groups nested routePaths under their top-level family regardless of owning context", () => {
    const contextManifests = new Map([
      contextManifest({
        root: "bounded-contexts/identity",
        contextName: "identity",
        deployableContributions: [
          contribution("marketplace-web", [routeModule({ routeId: "account", routePath: "account" })]),
        ],
      }),
      contextManifest({
        root: "bounded-contexts/auth",
        contextName: "auth",
        deployableContributions: [
          contribution("marketplace-web", [
            routeModule({ routeId: "account-sessions", routePath: "account/sessions" }),
          ]),
        ],
      }),
    ]);

    const families = computeContributedRouteFamilies({ contextManifests });
    expect(families.map((entry) => iaFamilyKey(entry))).toEqual([
      "marketplace-web::::account",
      "marketplace-web::::account",
    ]);
  });
});

describe("findIaRegistryViolations — registry membership (the guard's core fixture)", () => {
  it("passes a route whose family exactly matches a registered entry", () => {
    const root = createRepo();
    writeRegistry(
      root,
      baseRegistry({
        families: [
          {
            deployable: "marketplace-web",
            family: "widgets",
            owningContext: "widgets",
            purpose: "Widgets family.",
          },
        ],
      }),
    );
    const contextManifests = new Map([
      contextManifest({
        root: "bounded-contexts/widgets",
        contextName: "widgets",
        deployableContributions: [contribution("marketplace-web", [routeModule()])],
      }),
    ]);

    const violations = findIaRegistryViolations({ repoRoot: root, contextManifests, routeConfigFiles: [] });
    expect(violations).toEqual([]);
  });

  it("passes a panel/tab contributed by a different context under an already-registered family (no new entry needed)", () => {
    const root = createRepo();
    writeRegistry(
      root,
      baseRegistry({
        families: [
          {
            deployable: "marketplace-web",
            family: "account",
            owningContext: "identity",
            purpose: "Account settings family.",
          },
        ],
      }),
    );
    const contextManifests = new Map([
      contextManifest({
        root: "bounded-contexts/identity",
        contextName: "identity",
        deployableContributions: [
          contribution("marketplace-web", [routeModule({ routeId: "account", routePath: "account" })]),
        ],
      }),
      contextManifest({
        root: "bounded-contexts/auth",
        contextName: "auth",
        deployableContributions: [
          contribution("marketplace-web", [
            // A graft on the existing "account" surface, contributed by a
            // second context — must not require its own registry entry.
            routeModule({ routeId: "account-sessions", routePath: "account/sessions" }),
          ]),
        ],
      }),
    ]);

    const violations = findIaRegistryViolations({ repoRoot: root, contextManifests, routeConfigFiles: [] });
    expect(violations).toEqual([]);
  });

  // The required non-vacuous fixture: an improvised top-level route family
  // that was never declared in the registry must trip the guard.
  it("flags a brand-new, unregistered top-level route family", () => {
    const root = createRepo();
    writeRegistry(root, baseRegistry());
    const contextManifests = new Map([
      contextManifest({
        root: "bounded-contexts/widgets",
        contextName: "widgets",
        deployableContributions: [
          contribution("marketplace-web", [
            routeModule({ routeId: "widget-inbox", routePath: "widget-inbox", fileExport: "./routes/widget-inbox" }),
          ]),
        ],
      }),
    ]);

    const violations = findIaRegistryViolations({ repoRoot: root, contextManifests, routeConfigFiles: [] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("bounded-contexts/widgets/context.json");
    expect(violations[0]).toContain("widget-inbox");
    expect(violations[0]).toContain("unregistered marketplace-web route family");
  });

  it("flags an unregistered admin-web family scoped separately per section", () => {
    const root = createRepo();
    writeRegistry(
      root,
      baseRegistry({
        families: [
          {
            deployable: "admin-web",
            section: "access",
            family: "sign-in",
            owningContext: "auth",
            purpose: "Operator sign-in.",
          },
        ],
      }),
    );
    const contextManifests = new Map([
      contextManifest({
        root: "bounded-contexts/auth",
        contextName: "auth",
        deployableContributions: [
          contribution("admin-web", [
            // Keeps the registered "access" entry live so this test isolates
            // the new-section case instead of also tripping the stale-entry
            // ratchet check.
            routeModule({ routeId: "sign-in", routePath: "sign-in", section: "access" }),
            // Same family name "sign-in", but a different section: this is a
            // genuinely new (deployable, section, family) key.
            routeModule({ routeId: "catalog-sign-in", routePath: "sign-in", section: "catalog" }),
          ]),
        ],
      }),
    ]);

    const violations = findIaRegistryViolations({ repoRoot: root, contextManifests, routeConfigFiles: [] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("admin-web catalog route family 'sign-in'");
  });

  it("flags a stale registry entry whose route was removed (ratchet)", () => {
    const root = createRepo();
    writeRegistry(
      root,
      baseRegistry({
        families: [
          {
            deployable: "marketplace-web",
            family: "retired-surface",
            owningContext: "widgets",
            purpose: "No longer contributed.",
          },
        ],
      }),
    );
    const contextManifests = new Map([
      contextManifest({ root: "bounded-contexts/widgets", contextName: "widgets", deployableContributions: [] }),
    ]);

    const violations = findIaRegistryViolations({ repoRoot: root, contextManifests, routeConfigFiles: [] });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("stale");
    expect(violations[0]).toContain("retired-surface");
  });

  it("reports a missing registry file", () => {
    const root = createRepo();
    const violations = findIaRegistryViolations({ repoRoot: root, contextManifests: new Map(), routeConfigFiles: [] });
    expect(violations).toEqual(["scripts/check-structure/ia-registry.json: registry file is missing"]);
  });
});

describe("validateIaRegistryShape", () => {
  const contextNames = new Set(["widgets"]);

  it("requires owningContext to reference a real bounded context", () => {
    const violations = validateIaRegistryShape(
      baseRegistry({
        families: [{ deployable: "marketplace-web", family: "widgets", owningContext: "ghost", purpose: "x" }],
      }),
      { contextNames },
    );
    expect(violations.some((v) => v.includes("owningContext 'ghost' does not match"))).toBe(true);
  });

  it("requires a non-empty purpose", () => {
    const violations = validateIaRegistryShape(
      baseRegistry({
        families: [{ deployable: "marketplace-web", family: "widgets", owningContext: "widgets", purpose: "" }],
      }),
      { contextNames },
    );
    expect(violations.some((v) => v.includes("purpose must be a non-empty string"))).toBe(true);
  });

  it("requires a valid section for admin-web and forbids one elsewhere", () => {
    const missingSection = validateIaRegistryShape(
      baseRegistry({
        families: [{ deployable: "admin-web", family: "widgets", owningContext: "widgets", purpose: "x" }],
      }),
      { contextNames },
    );
    expect(missingSection.some((v) => v.includes("section is required for admin-web"))).toBe(true);

    const extraSection = validateIaRegistryShape(
      baseRegistry({
        families: [
          {
            deployable: "marketplace-web",
            section: "access",
            family: "widgets",
            owningContext: "widgets",
            purpose: "x",
          },
        ],
      }),
      { contextNames },
    );
    expect(extraSection.some((v) => v.includes("section must be omitted"))).toBe(true);
  });

  it("rejects a duplicate family entry", () => {
    const duplicateEntry = { deployable: "marketplace-web", family: "widgets", owningContext: "widgets", purpose: "x" };
    const violations = validateIaRegistryShape(baseRegistry({ families: [duplicateEntry, { ...duplicateEntry }] }), {
      contextNames,
    });
    expect(violations.some((v) => v.includes("duplicate family entry"))).toBe(true);
  });
});

describe("collectRouteConfigLiteralPaths / composition-root literal check", () => {
  it("collects a route() literal path regardless of nesting inside a layout's children array", () => {
    const root = createRepo();
    writeFile(
      root,
      "deployables/example-web/app/routes.ts",
      `
        import { index, layout, route } from "@react-router/dev/routes";
        const contextRoutes = [];
        export default [
          route("health/ready", "routes/health-ready.ts"),
          layout("routes/access-layout.tsx", [
            route("access", "routes/access-home.tsx"),
            ...contextRoutes,
          ]),
        ];
      `,
    );

    const literals = collectRouteConfigLiteralPaths({
      repoRoot: root,
      relativeFile: "deployables/example-web/app/routes.ts",
    });
    expect(literals.map((entry) => entry.path)).toEqual(["health/ready", "access"]);
  });

  it("flags an improvised literal route not declared in infrastructureRoutes", () => {
    const root = createRepo();
    writeRegistry(
      root,
      baseRegistry({
        infrastructureRoutes: {
          "admin-web": [],
          "marketplace-web": ["health/ready"],
          "public-web": [],
        },
      }),
    );
    writeFile(
      root,
      "deployables/example-web/app/routes.ts",
      `
        import { route } from "@react-router/dev/routes";
        export default [
          route("health/ready", "routes/health-ready.ts"),
          // Improvised: hand-added directly here instead of contributed
          // through a context's context.json deployableContributions.
          route("side-quest", "routes/side-quest.tsx"),
        ];
      `,
    );

    const violations = findIaRegistryViolations({
      repoRoot: root,
      contextManifests: new Map(),
      routeConfigFiles: [{ deployable: "marketplace-web", relativeFile: "deployables/example-web/app/routes.ts" }],
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("side-quest");
    expect(violations[0]).toContain(
      "not declared in scripts/check-structure/ia-registry.json infrastructureRoutes.marketplace-web",
    );
  });

  it("does not flag a computed (non-literal) route path argument", () => {
    const root = createRepo();
    writeRegistry(root, baseRegistry());
    writeFile(
      root,
      "deployables/example-web/app/routes.ts",
      `
        import { route } from "@react-router/dev/routes";
        const computedPath = ["bu", "yer-protection"].join("");
        export default [route(computedPath, "routes/order-protection-redirect.ts")];
      `,
    );

    const violations = findIaRegistryViolations({
      repoRoot: root,
      contextManifests: new Map(),
      routeConfigFiles: [{ deployable: "public-web", relativeFile: "deployables/example-web/app/routes.ts" }],
    });
    expect(violations).toEqual([]);
  });
});

describe("validateIaRegistry against the real repository", () => {
  it("keeps every currently-contributed route family, console/desk section, and composition-root route declared", () => {
    const result = validateIaRegistry();
    expect(result.violations, result.violations.join("\n")).toEqual([]);
    expect(result.warnings).toEqual([]);
  }, 30_000);
});
