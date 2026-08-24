import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectMutationConsistencySurfaces,
  validateReadAfterWriteRouteInventory,
} from "./read-after-write-inventory.mjs";

const tempRoots = [];

function createTempRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "cs-raw-inventory-"));
  tempRoots.push(root);
  mkdirSync(path.join(root, "bounded-contexts", "checkout", "routes"), { recursive: true });
  mkdirSync(path.join(root, "bounded-contexts", "checkout", "features", "sessions", "api"), { recursive: true });
  writeFileSync(
    path.join(root, "bounded-contexts", "checkout", "api.ts"),
    [
      'import { Hono } from "hono";',
      "export function buildCheckoutApi() {",
      "  const app = new Hono();",
      '  app.route("/account", sessionRoutes());',
      "  return app;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(root, "bounded-contexts", "checkout", "features", "sessions", "api", "route.ts"),
    [
      'import { Hono } from "hono";',
      "export function sessionRoutes() {",
      "  const app = new Hono();",
      '  app.get("/checkout-sessions/:sessionId", async (c) => c.json({}));',
      "  return app;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

function writeRoute(root, relativeFile, helpers) {
  const absolute = path.join(root, relativeFile);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const platformRuntimeHelpers = new Set(["loadAfterWrite", "navigateAfterWrite", "navigateAfterWriteFromSources"]);
  const importModule = helpers.some((helper) => platformRuntimeHelpers.has(helper))
    ? "@chase-sets/platform-runtime/http"
    : "@chase-sets/http/responses";
  const exportName = helpers.some((helper) => helper === "loadFreshlyWrittenResource" || helper === "loadAfterWrite")
    ? "loader"
    : "action";
  writeFileSync(
    absolute,
    [
      `import { ${helpers.join(", ")} } from "${importModule}";`,
      `export async function ${exportName}() {`,
      ...helpers.map((helper) => {
        if (helper === "loadAfterWrite") {
          return `  return ${helper}<{ ok: boolean }>({ request: new Request("http://test"), load: async () => ({ ok: true }), isNotFound: () => false });`;
        }

        return helper === "loadFreshlyWrittenResource"
          ? `  return ${helper}({ request: new Request("http://test"), load: async () => ({ ok: true }) });`
          : platformRuntimeHelpers.has(helper)
            ? `  return ${helper}({ context: "checkout", globalPosition: "1" }, "/next");`
            : `  return ${helper}("/next", { context: "checkout", globalPosition: "1" });`;
      }),
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
}

function writeBareRedirectAction(root, relativeFile, destination = "/checkout/buy/session/chk_123") {
  const absolute = path.join(root, relativeFile);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    [
      'import { redirect } from "react-router";',
      "export async function action() {",
      `  return redirect("${destination}");`,
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
}

function writeMutationBaseline(root, surfaces) {
  const absolute = path.join(root, "scripts", "check-structure", "mutation-consistency-baseline.json");
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(
    absolute,
    JSON.stringify(
      {
        issue: "#1809",
        owner: "bounded-context owners",
        reviewBy: "2026-07-31",
        reason: "Test mutation consistency audit baseline.",
        surfaces,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function recovery(kinds, behavior = "temporary checkout recovery") {
  return { kinds, behavior };
}

function semanticSessionHandoff(overrides = {}) {
  return {
    kind: "checkout.cart.add-line",
    expectation: "collection-non-empty",
    surface: "account-cart",
    sourceContextName: "checkout",
    receiptSourceContextName: "checkout",
    actorOwnership: "The Checkout command receipt belongs to the actor continuing to the destination route.",
    destinationRead: {
      apiContextName: "checkout",
      apiRoutePath: "/account/checkout-sessions/:sessionId",
      readModelTables: ["checkout_session_pages"],
    },
    ...overrides,
  };
}

function createContextManifest(root, overrides = {}) {
  const manifest = {
    contextName: "checkout",
    packageName: "@chase-sets/checkout",
    projectionGroups: [
      {
        projectionName: "checkout.session-projection",
        sourceContextNames: ["checkout"],
        ownedTables: ["checkout_session_pages"],
      },
    ],
    apiMounts: [
      {
        mountPath: "/api/marketplace",
        kind: "primary",
        requiresAuth: true,
        readFreshnessRoutes: [
          {
            routePath: "/account/checkout-sessions/:sessionId",
            methods: ["GET", "HEAD"],
            dependencies: [{ readModelTable: "checkout_session_pages" }],
          },
        ],
      },
    ],
    deployableContributions: [
      {
        deployable: "marketplace-web",
        routes: [
          {
            routeId: "buy-checkout-readiness",
            routePath: "checkout/buy/readiness",
            fileExport: "./routes/checkout-start",
          },
          {
            routeId: "buy-checkout-session",
            routePath: "checkout/buy/session/:sessionId",
            fileExport: "./routes/checkout-session",
          },
        ],
      },
    ],
    readAfterWriteRouteInventory: [
      {
        id: "checkout.session-start-to-detail",
        owner: "checkout",
        risk: "critical",
        freshnessSlo: {
          flowClass: "critical-customer-handoff",
          p95Ms: 1000,
          p99Ms: 2250,
        },
        source: {
          routeId: "buy-checkout-readiness",
          helperUses: ["appendFreshWriteToken"],
        },
        destination: {
          routeId: "buy-checkout-session",
          apiContextName: "checkout",
          apiRoutePath: "/account/checkout-sessions/:sessionId",
          readModelTables: ["checkout_session_pages"],
          helperUses: ["loadFreshlyWrittenResource"],
          transientRecovery: recovery("refreshable-catching-up"),
        },
      },
    ],
    mutationConsistencyInventory: [
      {
        id: "checkout.session-start-action",
        owner: "checkout",
        risk: "critical",
        strategy: "fresh-read",
        surfaces: ["route-action:bounded-contexts/checkout/routes/checkout-start.tsx"],
        visibleDestination: {
          routeId: "buy-checkout-session",
          apiContextName: "checkout",
          apiRoutePath: "/account/checkout-sessions/:sessionId",
          readModelTables: ["checkout_session_pages"],
          transientRecovery: recovery("refreshable-catching-up"),
        },
      },
    ],
    ...overrides,
  };

  return new Map([
    [
      "bounded-contexts/checkout",
      {
        root: "bounded-contexts/checkout",
        rootAbs: path.join(root, "bounded-contexts", "checkout"),
        manifest,
        packageName: manifest.packageName,
      },
    ],
  ]);
}

async function validate(root, contextManifests, options = {}) {
  return validateReadAfterWriteRouteInventory({
    repoRoot: root,
    contextManifests,
    reportOutputPath: "artifacts/test-read-after-write-route-inventory.md",
    ...options,
  });
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("read-after-write route inventory guard", () => {
  it("issue-7171-complete-caller-census rejects added or removed raw fetches outside the shipped inventory", async () => {
    const root = createTempRepo();
    const relative = "bounded-contexts/checkout/features/sessions/ui/recovery.ts";
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(
      absolute,
      'export async function recover() {\n  return fetch("/recovery", { method: "GET" });\n}\n',
      "utf8",
    );
    const baseManifests = createContextManifest(root, {
      rawFetchCensus: "complete",
      readAfterWriteRouteInventory: [],
      mutationConsistencyInventory: [],
    });
    const [surface] = (
      await collectMutationConsistencySurfaces({ repoRoot: root, contextManifests: baseManifests })
    ).filter((candidate) => candidate.kind === "raw-fetch");
    expect(surface).toBeDefined();
    const classified = createContextManifest(root, {
      rawFetchCensus: "complete",
      readAfterWriteRouteInventory: [],
      mutationConsistencyInventory: [
        {
          id: "checkout.owner-recovery-read",
          owner: "checkout",
          risk: "important",
          strategy: "snapshot-return",
          surfaces: [surface.id],
          visibleDestination: { description: "The recovery GET returns the owner snapshot." },
          proof: { authoritativeResponse: "The owner route returns its receipt.", tests: [relative] },
        },
      ],
    });
    const classifiedResult = await validate(root, classified);
    expect(classifiedResult.violations.some((violation) => violation.includes("raw-fetch is unclassified"))).toBe(
      false,
    );

    writeFileSync(
      absolute,
      'export async function recover() {\n  await fetch("/recovery", { method: "GET" });\n  return fetch("/retry", { method: "POST" });\n}\n',
      "utf8",
    );
    const addedResult = await validate(root, classified);
    expect(addedResult.violations.some((violation) => violation.includes("raw-fetch is unclassified"))).toBe(true);

    rmSync(absolute);
    const removedResult = await validate(root, classified);
    expect(removedResult.violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`surface '${surface.id}' was not discovered by the mutation inventory scanner`),
      ]),
    );
  });

  it("accepts helper usage represented by exact freshness inventory", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(root, createContextManifest(root));

    expect(result.violations).toEqual([]);
    expect(result.reportEntries).toHaveLength(1);
    expect(result.reportEntries[0]).toMatchObject({
      flowClass: "critical-customer-handoff",
      freshnessSlo: "critical-customer-handoff p95<=1000ms p99<=2250ms",
    });
    expect(result.mutationRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "route-action:bounded-contexts/checkout/routes/checkout-start.tsx",
          strategy: "fresh-read",
          dependencies: ["checkout_session_pages"],
        }),
      ]),
    );
  });

  it("accepts read-model table dependencies resolved through single-owner projection ownership", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(root, createContextManifest(root));

    expect(result.violations).toEqual([]);
    expect(result.reportEntries[0].dependencies).toEqual(["checkout_session_pages"]);
  });

  it("fails when a live freshness route omits runtime dependencies", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(
      root,
      createContextManifest(root, {
        apiMounts: [
          {
            mountPath: "/api/marketplace",
            kind: "primary",
            requiresAuth: true,
            readFreshnessRoutes: [
              {
                routePath: "/account/checkout-sessions/:sessionId",
                methods: ["GET", "HEAD"],
              },
            ],
          },
        ],
      }),
    );

    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json readFreshnessRoutes /account/checkout-sessions/:sessionId: readFreshnessRoutes entry '/account/checkout-sessions/:sessionId' must declare dependencies",
    );
    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json readAfterWriteRouteInventory[0]: destination.readModelTables includes 'checkout_session_pages' but the matching readFreshnessRoutes dependencies do not",
    );
  });

  it("accepts explicit projection dependencies when inventory explains the multi-group exception", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(
      root,
      createContextManifest(root, {
        projectionGroups: [
          {
            projectionName: "checkout.session-projection",
            sourceContextNames: ["checkout"],
            ownedTables: ["checkout_session_pages"],
          },
          {
            projectionName: "checkout.payment-input-projection",
            sourceContextNames: ["payments"],
            ownedTables: ["checkout_payment_inputs"],
          },
        ],
        apiMounts: [
          {
            mountPath: "/api/marketplace",
            kind: "primary",
            requiresAuth: true,
            readFreshnessRoutes: [
              {
                routePath: "/account/checkout-sessions/:sessionId",
                methods: ["GET", "HEAD"],
                dependencies: [
                  { projectionName: "checkout.session-projection" },
                  { projectionName: "checkout.payment-input-projection" },
                ],
              },
            ],
          },
        ],
        readAfterWriteRouteInventory: [
          {
            id: "checkout.session-start-to-detail",
            owner: "checkout",
            risk: "critical",
            freshnessSlo: {
              flowClass: "critical-customer-handoff",
              p95Ms: 1000,
              p99Ms: 2250,
            },
            source: {
              routeId: "buy-checkout-readiness",
              helperUses: ["appendFreshWriteToken"],
            },
            destination: {
              routeId: "buy-checkout-session",
              apiContextName: "checkout",
              apiRoutePath: "/account/checkout-sessions/:sessionId",
              projectionDependencies: ["checkout.session-projection", "checkout.payment-input-projection"],
              freshnessDependencyReason:
                "The session detail route reads two projection groups before either exposes one canonical owned table for the whole read.",
              helperUses: ["loadFreshlyWrittenResource"],
              transientRecovery: recovery("refreshable-catching-up"),
            },
          },
        ],
        mutationConsistencyInventory: [
          {
            id: "checkout.session-start-action",
            owner: "checkout",
            risk: "critical",
            strategy: "fresh-read",
            surfaces: ["route-action:bounded-contexts/checkout/routes/checkout-start.tsx"],
            visibleDestination: {
              routeId: "buy-checkout-session",
              apiContextName: "checkout",
              apiRoutePath: "/account/checkout-sessions/:sessionId",
              projectionDependencies: ["checkout.session-projection", "checkout.payment-input-projection"],
              freshnessDependencyReason:
                "The session detail route reads two projection groups before either exposes one canonical owned table for the whole read.",
              transientRecovery: recovery("refreshable-catching-up"),
            },
          },
        ],
      }),
    );

    expect(result.violations).toEqual([]);
  });

  it("fails when derived freshness dependencies have ambiguous table ownership", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(
      root,
      createContextManifest(root, {
        projectionGroups: [
          {
            projectionName: "checkout.session-projection",
            sourceContextNames: ["checkout"],
            ownedTables: ["checkout_session_pages"],
          },
          {
            projectionName: "checkout.duplicate-session-projection",
            sourceContextNames: ["checkout"],
            ownedTables: ["checkout_session_pages"],
          },
        ],
      }),
    );

    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json readAfterWriteRouteInventory[0]: destination: readModelTable 'checkout.checkout_session_pages' is owned by multiple projection groups (checkout.duplicate-session-projection, checkout.session-projection)",
    );
  });

  it("fails when explicit projection dependencies omit the structure justification", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(
      root,
      createContextManifest(root, {
        apiMounts: [
          {
            mountPath: "/api/marketplace",
            kind: "primary",
            requiresAuth: true,
            readFreshnessRoutes: [
              {
                routePath: "/account/checkout-sessions/:sessionId",
                methods: ["GET", "HEAD"],
                dependencies: [{ projectionName: "checkout.session-projection" }],
              },
            ],
          },
        ],
        readAfterWriteRouteInventory: [
          {
            id: "checkout.session-start-to-detail",
            owner: "checkout",
            risk: "critical",
            source: {
              routeId: "buy-checkout-readiness",
              helperUses: ["appendFreshWriteToken"],
            },
            destination: {
              routeId: "buy-checkout-session",
              apiContextName: "checkout",
              apiRoutePath: "/account/checkout-sessions/:sessionId",
              projectionDependencies: ["checkout.session-projection"],
              helperUses: ["loadFreshlyWrittenResource"],
              transientRecovery: recovery("refreshable-catching-up"),
            },
          },
        ],
      }),
    );

    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json readAfterWriteRouteInventory[0]: destination.freshnessDependencyReason is required when declaring projectionDependencies instead of readModelTables",
    );
  });

  it("accepts the default-safe platform runtime helpers in freshness inventory", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["navigateAfterWrite"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadAfterWrite"]);

    const result = await validate(
      root,
      createContextManifest(root, {
        readAfterWriteRouteInventory: [
          {
            id: "checkout.session-start-to-detail",
            owner: "checkout",
            risk: "critical",
            freshnessSlo: {
              flowClass: "critical-customer-handoff",
              p95Ms: 1000,
              p99Ms: 2250,
            },
            source: {
              routeId: "buy-checkout-readiness",
              helperUses: ["navigateAfterWrite"],
            },
            destination: {
              routeId: "buy-checkout-session",
              apiContextName: "checkout",
              apiRoutePath: "/account/checkout-sessions/:sessionId",
              readModelTables: ["checkout_session_pages"],
              helperUses: ["loadAfterWrite"],
              transientRecovery: recovery("refreshable-catching-up"),
            },
          },
        ],
      }),
    );

    expect(result.violations).toEqual([]);
    expect(result.helperUsages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "bounded-contexts/checkout/routes/checkout-start.tsx",
          helpers: ["navigateAfterWrite"],
        }),
        expect.objectContaining({
          file: "bounded-contexts/checkout/routes/checkout-session.tsx",
          helpers: ["loadAfterWrite"],
        }),
      ]),
    );
  });

  it("fails when transient recovery declares an unknown recovery kind", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const manifest = createContextManifest(root);
    manifest.get("bounded-contexts/checkout").manifest.readAfterWriteRouteInventory[0].destination.transientRecovery =
      recovery("temporary checkout recovery");

    const result = await validate(root, manifest);

    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json readAfterWriteRouteInventory[0]: destination.transientRecovery.kinds must be a canonical post-write recovery kind or non-empty array of kinds (action-required, expired-handoff, pending-projection, refreshable-catching-up, stale-projection, terminal-failure)",
    );
  });

  it("fails when a migrated route omits freshness SLO classification", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const manifest = createContextManifest(root);
    delete manifest.get("bounded-contexts/checkout").manifest.readAfterWriteRouteInventory[0].freshnessSlo;

    const result = await validate(root, manifest);

    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json readAfterWriteRouteInventory[0]: freshnessSlo with flowClass, p95Ms, and p99Ms is required",
    );
  });

  it("maps route-support helper usage to the matching deployable route id", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/support/route-support/buy-checkout-readiness/action.ts", [
      "appendFreshWriteToken",
    ]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(
      root,
      createContextManifest(root, {
        mutationConsistencyInventory: [
          {
            id: "checkout.session-start-action",
            owner: "checkout",
            risk: "critical",
            strategy: "fresh-read",
            surfaces: ["route-action:bounded-contexts/checkout/support/route-support/buy-checkout-readiness/action.ts"],
            visibleDestination: {
              routeId: "buy-checkout-session",
              apiContextName: "checkout",
              apiRoutePath: "/account/checkout-sessions/:sessionId",
              readModelTables: ["checkout_session_pages"],
              transientRecovery: recovery("refreshable-catching-up"),
            },
          },
        ],
      }),
    );

    expect(result.violations).toEqual([]);
    expect(result.helperUsages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "bounded-contexts/checkout/support/route-support/buy-checkout-readiness/action.ts",
          helpers: ["appendFreshWriteToken"],
          routeIds: ["buy-checkout-readiness"],
        }),
      ]),
    );
  });

  it("accepts semantic post-write handoff helpers represented by the same freshness inventory", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendPostWriteHandoff"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", [
      "loadFreshlyWrittenResource",
      "evaluatePostWriteHandoff",
    ]);

    const result = await validate(
      root,
      createContextManifest(root, {
        readAfterWriteRouteInventory: [
          {
            id: "checkout.session-start-to-detail",
            owner: "checkout",
            risk: "critical",
            freshnessSlo: {
              flowClass: "critical-customer-handoff",
              p95Ms: 1000,
              p99Ms: 2250,
            },
            source: {
              routeId: "buy-checkout-readiness",
              helperUses: ["appendPostWriteHandoff"],
              postWriteHandoffs: [semanticSessionHandoff()],
            },
            destination: {
              routeId: "buy-checkout-session",
              apiContextName: "checkout",
              apiRoutePath: "/account/checkout-sessions/:sessionId",
              readModelTables: ["checkout_session_pages"],
              helperUses: ["loadFreshlyWrittenResource", "evaluatePostWriteHandoff"],
              postWriteHandoffs: [semanticSessionHandoff()],
              transientRecovery: recovery(["refreshable-catching-up", "pending-projection"]),
            },
          },
        ],
      }),
    );

    expect(result.violations).toEqual([]);
    expect(result.helperUsages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: "bounded-contexts/checkout/routes/checkout-start.tsx",
          helpers: ["appendPostWriteHandoff"],
        }),
        expect.objectContaining({
          file: "bounded-contexts/checkout/routes/checkout-session.tsx",
          helpers: ["evaluatePostWriteHandoff", "loadFreshlyWrittenResource"],
        }),
      ]),
    );
  });

  it("discovers API freshness routes registered through nested route support modules", async () => {
    const root = createTempRepo();
    writeFileSync(
      path.join(root, "bounded-contexts", "checkout", "api.ts"),
      [
        'import { Hono } from "hono";',
        "export function buildCheckoutApi() {",
        "  const app = new Hono();",
        "  registerSessionApiRoutes(app);",
        "  return app;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    mkdirSync(path.join(root, "bounded-contexts", "checkout", "support", "api-support"), { recursive: true });
    writeFileSync(
      path.join(root, "bounded-contexts", "checkout", "support", "api-support", "session-routes.ts"),
      ["export function registerSessionApiRoutes(app) {", '  app.route("/sessions", sessionRoutes());', "}", ""].join(
        "\n",
      ),
      "utf8",
    );
    writeFileSync(
      path.join(root, "bounded-contexts", "checkout", "features", "sessions", "api", "route.ts"),
      [
        'import { Hono } from "hono";',
        "export function sessionRoutes() {",
        "  const app = new Hono();",
        '  app.get("/:sessionId", async (c) => c.json({}));',
        "  return app;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(
      root,
      createContextManifest(root, {
        apiMounts: [
          {
            mountPath: "/api/marketplace",
            kind: "primary",
            requiresAuth: true,
            readFreshnessRoutes: [
              {
                routePath: "/sessions/:sessionId",
                methods: ["GET", "HEAD"],
                dependencies: [{ readModelTable: "checkout_session_pages" }],
              },
            ],
          },
        ],
        readAfterWriteRouteInventory: [
          {
            id: "checkout.session-self-refresh",
            owner: "checkout",
            risk: "critical",
            freshnessSlo: {
              flowClass: "critical-customer-handoff",
              p95Ms: 1000,
              p99Ms: 2250,
            },
            source: {
              routeId: "buy-checkout-readiness",
              helperUses: ["appendFreshWriteToken"],
            },
            destination: {
              routeId: "buy-checkout-session",
              apiContextName: "checkout",
              apiRoutePath: "/sessions/:sessionId",
              readModelTables: ["checkout_session_pages"],
              helperUses: ["loadFreshlyWrittenResource"],
              transientRecovery: recovery("refreshable-catching-up"),
            },
          },
        ],
        mutationConsistencyInventory: [
          {
            id: "checkout.session-start-action",
            owner: "checkout",
            risk: "critical",
            strategy: "fresh-read",
            surfaces: ["route-action:bounded-contexts/checkout/routes/checkout-start.tsx"],
            visibleDestination: {
              routeId: "buy-checkout-session",
              apiContextName: "checkout",
              apiRoutePath: "/sessions/:sessionId",
              readModelTables: ["checkout_session_pages"],
              transientRecovery: recovery("refreshable-catching-up"),
            },
          },
        ],
      }),
    );

    expect(result.violations).toEqual([]);
  });

  it("fails when a helper-using route is missing inventory coverage", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(
      root,
      createContextManifest(root, {
        readAfterWriteRouteInventory: [],
      }),
    );

    expect(result.violations).toContain(
      "bounded-contexts/checkout/routes/checkout-start.tsx: fresh-write helper(s) appendFreshWriteToken on route 'buy-checkout-readiness' must be declared in readAfterWriteRouteInventory or an exception",
    );
  });

  it("fails when semantic handoff helper usage is missing inventory coverage", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendPostWriteHandoff"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(
      root,
      createContextManifest(root, {
        readAfterWriteRouteInventory: [],
      }),
    );

    expect(result.violations).toContain(
      "bounded-contexts/checkout/routes/checkout-start.tsx: fresh-write helper(s) appendPostWriteHandoff on route 'buy-checkout-readiness' must be declared in readAfterWriteRouteInventory or an exception",
    );
  });

  it("fails when semantic handoff helper coverage omits the portable receipt declaration", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendPostWriteHandoff"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", [
      "loadFreshlyWrittenResource",
      "evaluatePostWriteHandoff",
    ]);

    const result = await validate(
      root,
      createContextManifest(root, {
        readAfterWriteRouteInventory: [
          {
            id: "checkout.session-start-to-detail",
            owner: "checkout",
            risk: "critical",
            freshnessSlo: {
              flowClass: "critical-customer-handoff",
              p95Ms: 1000,
              p99Ms: 2250,
            },
            source: {
              routeId: "buy-checkout-readiness",
              helperUses: ["appendPostWriteHandoff"],
            },
            destination: {
              routeId: "buy-checkout-session",
              apiContextName: "checkout",
              apiRoutePath: "/account/checkout-sessions/:sessionId",
              readModelTables: ["checkout_session_pages"],
              helperUses: ["loadFreshlyWrittenResource", "evaluatePostWriteHandoff"],
              postWriteHandoffs: [semanticSessionHandoff()],
              transientRecovery: recovery(["refreshable-catching-up", "pending-projection"]),
            },
          },
        ],
      }),
    );

    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json readAfterWriteRouteInventory[0]: source.postWriteHandoffs must declare portable handoff receipts when using appendPostWriteHandoff",
    );
  });

  it("fails when semantic handoff receipt declarations do not match the portable contract", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendPostWriteHandoff"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", [
      "loadFreshlyWrittenResource",
      "evaluatePostWriteHandoff",
    ]);

    const result = await validate(
      root,
      createContextManifest(root, {
        readAfterWriteRouteInventory: [
          {
            id: "checkout.session-start-to-detail",
            owner: "checkout",
            risk: "critical",
            freshnessSlo: {
              flowClass: "critical-customer-handoff",
              p95Ms: 1000,
              p99Ms: 2250,
            },
            source: {
              routeId: "buy-checkout-readiness",
              helperUses: ["appendPostWriteHandoff"],
              postWriteHandoffs: [
                semanticSessionHandoff({
                  kind: "checkout cart add line",
                  expectation: "cart-has-line",
                  payload: "line-id",
                }),
              ],
            },
            destination: {
              routeId: "buy-checkout-session",
              apiContextName: "checkout",
              apiRoutePath: "/account/checkout-sessions/:sessionId",
              readModelTables: ["checkout_session_pages"],
              helperUses: ["loadFreshlyWrittenResource", "evaluatePostWriteHandoff"],
              postWriteHandoffs: [semanticSessionHandoff()],
              transientRecovery: recovery(["refreshable-catching-up", "pending-projection"]),
            },
          },
        ],
      }),
    );

    expect(result.violations).toEqual(
      expect.arrayContaining([
        "bounded-contexts/checkout/context.json readAfterWriteRouteInventory[0]: source.postWriteHandoffs[0] contains unsupported field(s): payload",
        "bounded-contexts/checkout/context.json readAfterWriteRouteInventory[0]: source.postWriteHandoffs[0].kind must use portable handoff text",
        "bounded-contexts/checkout/context.json readAfterWriteRouteInventory[0]: source.postWriteHandoffs[0].expectation must be one of collection-non-empty, resource-absent, resource-present, resource-updated",
      ]),
    );
  });

  it("fails when semantic handoff receipt declarations omit route-read binding evidence", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendPostWriteHandoff"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", [
      "loadFreshlyWrittenResource",
      "evaluatePostWriteHandoff",
    ]);

    const result = await validate(
      root,
      createContextManifest(root, {
        readAfterWriteRouteInventory: [
          {
            id: "checkout.session-start-to-detail",
            owner: "checkout",
            risk: "critical",
            freshnessSlo: {
              flowClass: "critical-customer-handoff",
              p95Ms: 1000,
              p99Ms: 2250,
            },
            source: {
              routeId: "buy-checkout-readiness",
              helperUses: ["appendPostWriteHandoff"],
              postWriteHandoffs: [semanticSessionHandoff({ actorOwnership: "" })],
            },
            destination: {
              routeId: "buy-checkout-session",
              apiContextName: "checkout",
              apiRoutePath: "/account/checkout-sessions/:sessionId",
              readModelTables: ["checkout_session_pages"],
              helperUses: ["loadFreshlyWrittenResource", "evaluatePostWriteHandoff"],
              postWriteHandoffs: [
                semanticSessionHandoff({
                  destinationRead: {
                    apiContextName: "marketplace",
                    apiRoutePath: "/account/cart",
                    readModelTables: ["checkout_cart_line_pages"],
                  },
                }),
              ],
              transientRecovery: "temporary checkout recovery from projection lag or unmet semantic handoff",
            },
          },
        ],
      }),
    );

    expect(result.violations).toEqual(
      expect.arrayContaining([
        "bounded-contexts/checkout/context.json readAfterWriteRouteInventory[0]: source.postWriteHandoffs[0].actorOwnership must describe the actor/account ownership guard",
        "bounded-contexts/checkout/context.json readAfterWriteRouteInventory[0]: destination.postWriteHandoffs[0].destinationRead.apiContextName must match destination.apiContextName",
        "bounded-contexts/checkout/context.json readAfterWriteRouteInventory[0]: destination.postWriteHandoffs[0].destinationRead.apiRoutePath must match destination.apiRoutePath",
        "bounded-contexts/checkout/context.json readAfterWriteRouteInventory[0]: destination.postWriteHandoffs[0].destinationRead.readModelTables includes 'checkout_cart_line_pages' not declared by destination.readModelTables",
      ]),
    );
  });

  it("fails when production code writes raw postWriteHandoff metadata without the shared response helper", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);
    mkdirSync(path.join(root, "bounded-contexts", "checkout", "support", "request-support"), { recursive: true });
    writeFileSync(
      path.join(root, "bounded-contexts", "checkout", "support", "request-support", "raw-handoff.ts"),
      [
        "export function unsafeHandoff(path) {",
        "  const url = new URL(path, 'https://chase-sets.local');",
        "  url.searchParams.set('postWriteHandoff', '{}');",
        "  return url.pathname + url.search;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await validate(root, createContextManifest(root));

    expect(result.violations).toContain(
      "bounded-contexts/checkout/support/request-support/raw-handoff.ts: raw postWriteHandoff query metadata is not allowed; use appendPostWriteHandoff or appendPostWriteHandoffFromSources",
    );
  });

  it("fails when a mutating route action lacks mutation consistency classification", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);
    writeFileSync(
      path.join(root, "bounded-contexts", "checkout", "routes", "unclassified.tsx"),
      ["export async function action() {", "  return null;", "}", ""].join("\n"),
      "utf8",
    );

    const result = await validate(root, createContextManifest(root));

    expect(result.violations).toContain(
      "bounded-contexts/checkout/routes/unclassified.tsx: mutating route-action is unclassified; add mutationConsistencyInventory with strategy proof",
    );
  });

  it("fails when a fresh-read route action lacks a declared afterWrite receipt source", async () => {
    const root = createTempRepo();
    writeBareRedirectAction(root, "bounded-contexts/checkout/routes/checkout-start.tsx");
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(
      root,
      createContextManifest(root, {
        readAfterWriteRouteInventory: [
          {
            id: "checkout.session-start-to-detail",
            owner: "checkout",
            risk: "critical",
            source: {
              routeId: "buy-checkout-readiness",
            },
            destination: {
              routeId: "buy-checkout-session",
              apiContextName: "checkout",
              apiRoutePath: "/account/checkout-sessions/:sessionId",
              readModelTables: ["checkout_session_pages"],
              helperUses: ["loadFreshlyWrittenResource"],
              transientRecovery: recovery("refreshable-catching-up"),
            },
          },
        ],
      }),
    );

    expect(result.violations).toContain(
      "bounded-contexts/checkout/routes/checkout-start.tsx: fresh-read route action 'buy-checkout-readiness' redirects to projection-backed destination 'checkout./account/checkout-sessions/:sessionId' without a declared afterWrite receipt source; use navigateAfterWrite or appendFreshWriteToken on the redirect/redirectDocument and cover it in readAfterWriteRouteInventory, or classify the mutation with a non-fresh-read mutationConsistencyInventory strategy and proof. See docs/architecture/read-after-write-route-author-checklist.md",
    );
  });

  it("accepts a fresh-read route action with a declared default-safe receipt source", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["navigateAfterWrite"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(
      root,
      createContextManifest(root, {
        readAfterWriteRouteInventory: [
          {
            id: "checkout.session-start-to-detail",
            owner: "checkout",
            risk: "critical",
            freshnessSlo: {
              flowClass: "critical-customer-handoff",
              p95Ms: 1000,
              p99Ms: 2250,
            },
            source: {
              routeId: "buy-checkout-readiness",
              helperUses: ["navigateAfterWrite"],
            },
            destination: {
              routeId: "buy-checkout-session",
              apiContextName: "checkout",
              apiRoutePath: "/account/checkout-sessions/:sessionId",
              readModelTables: ["checkout_session_pages"],
              helperUses: ["loadFreshlyWrittenResource"],
              transientRecovery: recovery("refreshable-catching-up"),
            },
          },
        ],
      }),
    );

    expect(result.violations).toEqual([]);
  });

  it("does not require afterWrite receipt sources for non-fresh-read route action strategies", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);
    writeBareRedirectAction(root, "bounded-contexts/checkout/routes/snapshot.tsx");

    const manifest = createContextManifest(root);
    manifest.get("bounded-contexts/checkout").manifest.mutationConsistencyInventory.push({
      id: "checkout.snapshot-route",
      owner: "checkout",
      risk: "important",
      strategy: "snapshot-return",
      surfaces: ["route-action:bounded-contexts/checkout/routes/snapshot.tsx"],
      visibleDestination: {
        description: "The action response carries the committed checkout snapshot without a projection read.",
      },
      proof: {
        authoritativeResponse: "The action returns the command result snapshot and does not navigate to a read model.",
        tests: ["bounded-contexts/checkout/routes/checkout-session-loader.test.ts"],
      },
    });

    const result = await validate(root, manifest);

    expect(result.violations).toEqual([]);
  });

  it("fails when a new discovered mutation surface is added to the frozen baseline", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);
    writeFileSync(
      path.join(root, "bounded-contexts", "checkout", "routes", "unclassified.tsx"),
      ["export async function action() {", "  return null;", "}", ""].join("\n"),
      "utf8",
    );
    writeMutationBaseline(root, ["route-action:bounded-contexts/checkout/routes/unclassified.tsx"]);

    const result = await validate(root, createContextManifest(root), { frozenBaselineSurfaces: new Set() });

    expect(result.violations).toContain(
      "scripts/check-structure/mutation-consistency-baseline.json: mutation baseline surface 'route-action:bounded-contexts/checkout/routes/unclassified.tsx' is not in the frozen #1809 baseline; classify the surface in mutationConsistencyInventory instead of adding migration debt",
    );
  });

  it("allows existing frozen baseline rows to cover migration debt until they are burned down", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);
    writeFileSync(
      path.join(root, "bounded-contexts", "checkout", "routes", "unclassified.tsx"),
      ["export async function action() {", "  return null;", "}", ""].join("\n"),
      "utf8",
    );
    writeMutationBaseline(root, ["route-action:bounded-contexts/checkout/routes/unclassified.tsx"]);

    const result = await validate(root, createContextManifest(root), {
      frozenBaselineSurfaces: new Set(["route-action:bounded-contexts/checkout/routes/unclassified.tsx"]),
    });

    expect(result.violations).toEqual([]);
    expect(result.mutationRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "route-action:bounded-contexts/checkout/routes/unclassified.tsx",
          strategy: "migration",
          issueOrException: "#1809",
        }),
      ]),
    );
  });

  it("allows the baseline to shrink without changing the frozen baseline", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);
    writeMutationBaseline(root, []);

    const result = await validate(root, createContextManifest(root), {
      frozenBaselineSurfaces: new Set(["route-action:bounded-contexts/checkout/routes/removed.tsx"]),
    });

    expect(result.violations).toEqual([]);
  });

  it("still fails when a baseline row no longer maps to discovered code", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);
    writeMutationBaseline(root, ["route-action:bounded-contexts/checkout/routes/removed.tsx"]);

    const result = await validate(root, createContextManifest(root), {
      frozenBaselineSurfaces: new Set(["route-action:bounded-contexts/checkout/routes/removed.tsx"]),
    });

    expect(result.violations).toContain(
      "scripts/check-structure/mutation-consistency-baseline.json: stale mutation baseline surface 'route-action:bounded-contexts/checkout/routes/removed.tsx' was not discovered",
    );
  });

  it("accepts declared optimistic-with-correction mutations with reconciliation proof", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);
    writeFileSync(
      path.join(root, "bounded-contexts", "checkout", "routes", "cart.tsx"),
      ["export async function action() {", "  return null;", "}", ""].join("\n"),
      "utf8",
    );

    const manifest = createContextManifest(root);
    manifest.get("bounded-contexts/checkout").manifest.mutationConsistencyInventory.push({
      id: "checkout.cart-quantity",
      owner: "checkout",
      risk: "important",
      strategy: "optimistic-with-correction",
      surfaces: ["route-action:bounded-contexts/checkout/routes/cart.tsx"],
      visibleDestination: {
        routeId: "account-cart",
        description:
          "Cart quantity and subtotal are updated optimistically, then reconciled from the authoritative cart read.",
      },
      proof: {
        correction: "The route revalidates after submit and rolls back to server quantity on mismatch.",
        tests: ["bounded-contexts/checkout/routes/account-cart-route.test.ts"],
      },
    });

    const result = await validate(root, manifest);

    expect(result.violations).toEqual([]);
  });

  it("fails when optimistic-with-correction proof fields are missing", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);
    writeFileSync(
      path.join(root, "bounded-contexts", "checkout", "routes", "cart.tsx"),
      ["export async function action() {", "  return null;", "}", ""].join("\n"),
      "utf8",
    );

    const manifest = createContextManifest(root);
    manifest.get("bounded-contexts/checkout").manifest.mutationConsistencyInventory.push({
      id: "checkout.cart-quantity",
      owner: "checkout",
      risk: "important",
      strategy: "optimistic-with-correction",
      surfaces: ["route-action:bounded-contexts/checkout/routes/cart.tsx"],
      visibleDestination: {
        routeId: "account-cart",
      },
    });

    const result = await validate(root, manifest);

    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json mutationConsistencyInventory[1]: optimistic-with-correction requires visibleDestination.description",
    );
    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json mutationConsistencyInventory[1]: optimistic-with-correction requires proof.correction",
    );
    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json mutationConsistencyInventory[1]: optimistic-with-correction requires proof.tests",
    );
  });

  it("accepts realtime-correction mutations with fallback proof", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);
    writeFileSync(
      path.join(root, "bounded-contexts", "checkout", "features", "sessions", "api", "commands.ts"),
      [
        'import { Hono } from "hono";',
        "export function commands() {",
        "  const app = new Hono();",
        '  app.post("/checkout-sessions/:sessionId/realtime-refresh", async (c) => c.json({ ok: true }));',
        "  return app;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const manifest = createContextManifest(root);
    manifest.get("bounded-contexts/checkout").manifest.mutationConsistencyInventory.push({
      id: "checkout.session-realtime-refresh",
      owner: "checkout",
      risk: "important",
      strategy: "realtime-correction",
      surfaces: [
        "api-route:bounded-contexts/checkout/features/sessions/api/commands.ts:POST /checkout-sessions/:sessionId/realtime-refresh",
      ],
      visibleDestination: {
        description: "Checkout session realtime panel updates from a patch stream.",
      },
      proof: {
        fallback: "The route reloads the session when the realtime channel is unavailable.",
        tests: ["bounded-contexts/checkout/routes/checkout-session-loader.test.ts"],
      },
    });

    const result = await validate(root, manifest);

    expect(result.violations).toEqual([]);
  });

  it("accepts non-user-visible classifications with dated remediation evidence", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);
    writeFileSync(
      path.join(root, "bounded-contexts", "checkout", "features", "sessions", "api", "webhook.ts"),
      [
        'import { Hono } from "hono";',
        "export function webhook() {",
        "  const app = new Hono();",
        '  app.post("/provider/webhook", async (c) => c.json({ ok: true }));',
        "  return app;",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const manifest = createContextManifest(root);
    manifest.get("bounded-contexts/checkout").manifest.mutationConsistencyInventory.push({
      id: "checkout.provider-webhook",
      owner: "checkout",
      risk: "internal",
      strategy: "non-user-visible",
      surfaces: ["api-route:bounded-contexts/checkout/features/sessions/api/webhook.ts:POST /provider/webhook"],
      exception: {
        owner: "checkout",
        reason: "Provider webhook has no immediate browser-visible destination.",
        reviewBy: "2026-07-31",
        issue: "#1809",
      },
    });

    const result = await validate(root, manifest);

    expect(result.violations).toEqual([]);
  });

  it("fails when a readFreshnessRoutes dependency points at an unowned table", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(
      root,
      createContextManifest(root, {
        apiMounts: [
          {
            mountPath: "/api/marketplace",
            kind: "primary",
            requiresAuth: true,
            readFreshnessRoutes: [
              {
                routePath: "/account/checkout-sessions/:sessionId",
                methods: ["GET", "HEAD"],
                dependencies: [{ readModelTable: "missing_session_pages" }],
              },
            ],
          },
        ],
      }),
    );

    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json apiMounts[0] readFreshnessRoutes[0] dependencies[0]: readModelTable 'checkout.missing_session_pages' is not owned by a declared projection group",
    );
  });

  it("fails when inventory claims a loader helper the destination route module does not use", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeFileSync(
      path.join(root, "bounded-contexts", "checkout", "routes", "checkout-session.tsx"),
      ["export async function loader() {", "  return { ok: true };", "}", ""].join("\n"),
      "utf8",
    );

    const result = await validate(root, createContextManifest(root));

    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json readAfterWriteRouteInventory[0]: destination.helperUses claims 'loadFreshlyWrittenResource' on route 'buy-checkout-session' but no production route module for that route uses it",
    );
  });

  it("fails when a file-level exception claims a helper the file does not use", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeFileSync(
      path.join(root, "bounded-contexts", "checkout", "routes", "checkout-session.tsx"),
      ["export async function loader() {", "  return { ok: true };", "}", ""].join("\n"),
      "utf8",
    );
    mkdirSync(path.join(root, "bounded-contexts", "checkout", "support"), { recursive: true });
    writeFileSync(
      path.join(root, "bounded-contexts", "checkout", "support", "forwarding.ts"),
      ["export function forward() {", "  return null;", "}", ""].join("\n"),
      "utf8",
    );

    const result = await validate(
      root,
      createContextManifest(root, {
        apiMounts: [
          {
            mountPath: "/api/marketplace",
            kind: "primary",
            requiresAuth: true,
            readFreshnessRoutes: [],
          },
        ],
        readAfterWriteRouteInventory: [
          {
            id: "checkout.token-carrier",
            owner: "checkout",
            risk: "important",
            source: {
              routeId: "buy-checkout-readiness",
              helperUses: ["appendFreshWriteToken"],
            },
            destination: {
              routeId: "buy-checkout-session",
              transientRecovery: recovery("terminal-failure"),
            },
            exception: {
              status: "not-post-write-read",
              owner: "checkout",
              reviewBy: "2026-07-31",
              reason: "This context only carries the token to another owning destination.",
              files: ["bounded-contexts/checkout/support/forwarding.ts"],
              helperUses: ["appendFreshWriteToken"],
            },
          },
        ],
      }),
    );

    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json readAfterWriteRouteInventory[0]: exception.helperUses claims 'appendFreshWriteToken' for file 'bounded-contexts/checkout/support/forwarding.ts' but the file does not use it",
    );
  });

  it("fails when an accepted helper exception lacks a current remediation issue", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(
      root,
      createContextManifest(root, {
        readAfterWriteRouteInventory: [
          {
            id: "checkout.cart-self-refresh",
            owner: "checkout",
            risk: "important",
            source: {
              routeId: "buy-checkout-readiness",
              helperUses: ["appendFreshWriteToken"],
            },
            destination: {
              routeId: "buy-checkout-session",
              transientRecovery: recovery("action-required"),
            },
            exception: {
              status: "accepted",
              owner: "checkout",
              reviewBy: "2026-07-31",
              reason: "Self-refreshing cart projection migration is tracked by a stale closed issue.",
            },
          },
        ],
      }),
    );

    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json readAfterWriteRouteInventory[0]: accepted exceptions must reference a current remediation issue",
    );
  });

  it("fails when a freshness route is not referenced by inventory metadata", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(
      root,
      createContextManifest(root, {
        apiMounts: [
          {
            mountPath: "/api/marketplace",
            kind: "primary",
            requiresAuth: true,
            readFreshnessRoutes: [
              {
                routePath: "/account/checkout-sessions/:sessionId",
                methods: ["GET", "HEAD"],
                dependencies: [{ readModelTable: "checkout_session_pages" }],
              },
              {
                routePath: "/account/cart",
                methods: ["GET"],
                dependencies: [{ readModelTable: "checkout_session_pages" }],
              },
            ],
          },
        ],
      }),
    );

    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json: readFreshnessRoutes '/account/cart' must be referenced by readAfterWriteRouteInventory",
    );
  });

  it("fails when a freshness route does not match a discovered API route", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(
      root,
      createContextManifest(root, {
        apiMounts: [
          {
            mountPath: "/api/marketplace",
            kind: "primary",
            requiresAuth: true,
            readFreshnessRoutes: [
              {
                routePath: "/account/missing/:id",
                methods: ["GET"],
                dependencies: [{ readModelTable: "checkout_session_pages" }],
              },
            ],
          },
        ],
        readAfterWriteRouteInventory: [
          {
            id: "checkout.missing-route",
            owner: "checkout",
            risk: "critical",
            freshnessSlo: {
              flowClass: "critical-customer-handoff",
              p95Ms: 1000,
              p99Ms: 2250,
            },
            source: {
              routeId: "buy-checkout-readiness",
              helperUses: ["appendFreshWriteToken"],
            },
            destination: {
              routeId: "buy-checkout-session",
              apiContextName: "checkout",
              apiRoutePath: "/account/missing/:id",
              readModelTables: ["checkout_session_pages"],
              helperUses: ["loadFreshlyWrittenResource"],
              transientRecovery: recovery("refreshable-catching-up"),
            },
          },
        ],
      }),
    );

    expect(result.violations).toContain(
      "bounded-contexts/checkout/context.json apiMounts[0] readFreshnessRoutes[0]: routePath '/account/missing/:id' does not match a discovered GET/HEAD API route",
    );
  });
});
