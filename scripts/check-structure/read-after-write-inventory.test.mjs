import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateReadAfterWriteRouteInventory } from "./read-after-write-inventory.mjs";

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
  writeFileSync(
    absolute,
    [
      `import { ${helpers.join(", ")} } from "@chase-sets/http/responses";`,
      "export async function action() {",
      ...helpers.map((helper) =>
        helper === "loadFreshlyWrittenResource"
          ? `  return ${helper}({ request: new Request("http://test"), load: async () => ({ ok: true }) });`
          : `  return ${helper}("/next", { context: "checkout", globalPosition: "1" });`,
      ),
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
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
          transientRecovery: "temporary checkout recovery",
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

async function validate(root, contextManifests) {
  return validateReadAfterWriteRouteInventory({
    repoRoot: root,
    contextManifests,
    reportOutputPath: "artifacts/test-read-after-write-route-inventory.md",
  });
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe("read-after-write route inventory guard", () => {
  it("accepts helper usage represented by exact freshness inventory", async () => {
    const root = createTempRepo();
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-start.tsx", ["appendFreshWriteToken"]);
    writeRoute(root, "bounded-contexts/checkout/routes/checkout-session.tsx", ["loadFreshlyWrittenResource"]);

    const result = await validate(root, createContextManifest(root));

    expect(result.violations).toEqual([]);
    expect(result.reportEntries).toHaveLength(1);
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
              transientRecovery: "Destination freshness is owned by another context.",
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
              transientRecovery: "temporary checkout recovery",
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
