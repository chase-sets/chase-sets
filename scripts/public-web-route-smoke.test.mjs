import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileRepositoryCorpus } from "../bounded-contexts/public-presence/features/help/integrations/compile-help-articles.mjs";
import { repoRoot } from "./lib/repo.mjs";
import { loadPublicWebRouteInventory, smokePublicWebRoutes } from "./public-web-route-smoke.mjs";

const openServers = new Set();
const quietLogger = { log() {}, warn() {} };

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  openServers.clear();
});

async function startRouteServer(handler) {
  const server = createServer(handler);
  openServers.add(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Route smoke test server did not bind a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

async function independentlyReadMountedManifestRoutes() {
  const registryPath = path.join(repoRoot, "deployables/public-web/app/generated/web-context-registry.ts");
  const registry = await readFile(registryPath, "utf8");
  const contextNames = [...registry.matchAll(/^\s{4}contextName: "([^"]+)",$/gmu)].map((match) => match[1]);
  const routeKeys = [];
  for (const contextName of contextNames) {
    const manifest = JSON.parse(
      await readFile(path.join(repoRoot, "bounded-contexts", contextName, "context.json"), "utf8"),
    );
    const publicWebContributions = manifest.deployableContributions.filter(
      (contribution) => contribution.deployable === "public-web",
    );
    for (const contribution of publicWebContributions) {
      for (const route of contribution.routes) routeKeys.push(`${contextName}:${route.routeId}`);
    }
  }
  return routeKeys.sort();
}

describe("public web route smoke", () => {
  it("covers every mounted manifest route and every article from the real generated help source path", async () => {
    const inventory = await loadPublicWebRouteInventory();
    const expectedManifestRouteKeys = await independentlyReadMountedManifestRoutes();
    const representedManifestRouteKeys = [
      ...new Set(inventory.routes.flatMap((route) => route.manifestRouteKeys)),
    ].sort();
    expect(representedManifestRouteKeys).toEqual(expectedManifestRouteKeys);

    const sourceArticles = await compileRepositoryCorpus();
    const walkedPaths = new Set(inventory.routes.map((route) => route.path));
    for (const article of sourceArticles) expect(walkedPaths, article.href).toContain(article.href);

    expect(inventory.manifestRoutes).toHaveLength(expectedManifestRouteKeys.length);
    expect(inventory.helpArticles).toHaveLength(sourceArticles.length);
    expect(inventory.strictRoutes.map((route) => route.path)).toEqual([
      "/faq",
      "/help/buying/order-protection",
      "/order-protection",
      "/refunds-and-returns",
      "/sales-fees",
    ]);
    expect(inventory.tokenBearingHelpArticle.policyValueKeys.length).toBeGreaterThan(0);
  });

  it("allows degraded and non-5xx responses in the DB-less boot walk", async () => {
    const inventory = await loadPublicWebRouteInventory();
    const baseUrl = await startRouteServer((_request, response) => {
      response.writeHead(404, { "Content-Type": "text/html" });
      response.end(`<main>${inventory.degradedMarker}</main>`);
    });

    const result = await smokePublicWebRoutes({
      baseUrl,
      mode: "no-5xx",
      attempts: 1,
      logger: quietLogger,
    });
    expect(result.manifestRoutes.length).toBeGreaterThan(0);
    expect(result.helpArticles.length).toBeGreaterThan(0);
  });

  it("turns red when a discovered legacy policy source returns 500", async () => {
    const baseUrl = await startRouteServer((request, response) => {
      const isBrokenPolicySource = request.url === "/sales-fees";
      response.writeHead(isBrokenPolicySource ? 500 : 200, { "Content-Type": "text/html" });
      response.end(isBrokenPolicySource ? "broken policy source" : "healthy public page");
    });

    await expect(smokePublicWebRoutes({ baseUrl, mode: "healthy", attempts: 1, logger: quietLogger })).rejects.toThrow(
      /Public route smoke failed \(healthy\):[\s\S]*\/sales-fees returned 500/u,
    );
  });

  it("rejects the deployed degraded marker on the catalog-selected token-bearing article", async () => {
    const inventory = await loadPublicWebRouteInventory();
    const degradedPath = inventory.tokenBearingHelpArticle.href;
    const baseUrl = await startRouteServer((request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(request.url === degradedPath ? inventory.degradedMarker : "healthy public page");
    });

    await expect(smokePublicWebRoutes({ baseUrl, mode: "healthy", attempts: 1, logger: quietLogger })).rejects.toThrow(
      new RegExp(`${degradedPath} returned the degraded marker`),
    );
  });

  it("is wired into DB-less boot smoke and each issue-scoped deployed workflow", async () => {
    const [platformSmoke, platformPr, platformProduction, ephemeralVerification] = await Promise.all(
      [
        "scripts/platform-smoke.mjs",
        ".github/workflows/platform-pr.yml",
        ".github/workflows/platform-production.yml",
        ".github/workflows/platform-ephemeral-verification.yml",
      ].map((relativePath) => readFile(path.join(repoRoot, relativePath), "utf8")),
    );

    expect(platformSmoke).toContain('getSmokeEnv("SMOKE_PUBLIC_ROUTE_MODE") || "healthy"');
    expect(platformSmoke).toContain("await smokePublicWebRoutes({");
    for (const workflow of [platformPr, platformProduction]) {
      const bootSmoke = workflow.match(/- name: Boot smoke[^\n]*[\s\S]*?(?=\n\s{6}- name:)/u)?.[0] ?? "";
      expect(bootSmoke).toContain("node ./scripts/public-web-route-smoke.mjs");
      expect(bootSmoke).toContain("--mode no-5xx");
    }
    for (const workflow of [platformPr, platformProduction, ephemeralVerification]) {
      expect(workflow).toContain('SMOKE_PUBLIC_ROUTE_MODE: "healthy"');
      expect(workflow).toContain("pnpm run smoke:platform");
    }
  });
});
