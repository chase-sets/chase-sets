import { spawn } from "node:child_process";
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

async function runCheckerCli(baseUrl) {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(repoRoot, "scripts/public-web-route-smoke.mjs"),
        "--base-url",
        baseUrl,
        "--mode",
        "healthy",
        "--attempts",
        "1",
        "--timeout-ms",
        "5000",
      ],
      { cwd: repoRoot, windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({ exitCode, signal, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
  });
}

async function expectEveryStrictTargetIn(output) {
  const inventory = await loadPublicWebRouteInventory();
  for (const route of inventory.strictRoutes) expect(output).toContain(route.path);
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
    const baseUrl = await startRouteServer((request, response) => {
      if (request.url === "/route-smoke-redirected") {
        response.writeHead(404);
        response.end(`<main>${inventory.degradedMarker}</main>`);
        return;
      }
      response.writeHead(302, { Location: "/route-smoke-redirected" });
      response.end();
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

  it("rejects every 5xx response in the DB-less boot walk", async () => {
    const baseUrl = await startRouteServer((_request, response) => {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end('{"error":"temporarily unavailable"}');
    });

    await expect(smokePublicWebRoutes({ baseUrl, mode: "no-5xx", attempts: 1, logger: quietLogger })).rejects.toThrow(
      /Public route smoke failed \(no-5xx\):[\s\S]*returned 503/u,
    );
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

  it("rejects successful JSON error representations for every deployed target", async () => {
    const baseUrl = await startRouteServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"error":"policy resolver unavailable"}');
    });

    await expect(smokePublicWebRoutes({ baseUrl, mode: "healthy", attempts: 1, logger: quietLogger })).rejects.toThrow(
      /Public route smoke failed \(healthy\):[\s\S]*application\/json/u,
    );
  });

  it("rejects a deployed target with no content type", async () => {
    const baseUrl = await startRouteServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    await expect(smokePublicWebRoutes({ baseUrl, mode: "healthy", attempts: 1, logger: quietLogger })).rejects.toThrow(
      /Public route smoke failed \(healthy\):[\s\S]*missing Content-Type/u,
    );
  });

  it("rejects the deployed degraded marker when its visible text is split across elements", async () => {
    const baseUrl = await startRouteServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<main>Temporarily <span>unavailable</span></main>");
    });

    await expect(smokePublicWebRoutes({ baseUrl, mode: "healthy", attempts: 1, logger: quietLogger })).rejects.toThrow(
      /Public route smoke failed \(healthy\):[\s\S]*returned the degraded marker/u,
    );
  });

  it.each([
    {
      name: "the canonical marker split inside temporarily",
      contentType: "text/html",
      body: "<main>Tempor<span>arily</span> unavailable</main>",
      expectedExitCode: 1,
      expectedFailure: "degraded-marker",
    },
    {
      name: "the canonical marker split inside unavailable",
      contentType: "text/html",
      body: "<main>Temporarily unavail<span>able</span></main>",
      expectedExitCode: 1,
      expectedFailure: "degraded-marker",
    },
    {
      name: "adjacent inline elements without source whitespace",
      contentType: "text/html",
      body: "<main><span>Temporarily</span><span>unavailable</span></main>",
      expectedExitCode: 0,
    },
    {
      name: "adjacent inline elements with source whitespace",
      contentType: "text/html",
      body: "<main><span>Temporarily</span> <span>unavailable</span></main>",
      expectedExitCode: 1,
      expectedFailure: "degraded-marker",
    },
    {
      name: "a standards-defined named whitespace entity",
      contentType: "text/html",
      body: "<main>Temporarily&ensp;unavailable</main>",
      expectedExitCode: 1,
      expectedFailure: "degraded-marker",
    },
    {
      name: "direct Unicode whitespace",
      contentType: "text/html",
      body: "<main>Temporarily\u2003unavailable</main>",
      expectedExitCode: 1,
      expectedFailure: "degraded-marker",
    },
    {
      name: "mixed-case canonical visible text",
      contentType: "text/html",
      body: "<main>tEMPORARILY UNAVAILABLE</main>",
      expectedExitCode: 1,
      expectedFailure: "degraded-marker",
    },
    {
      name: "a longer first word that starts with the canonical marker",
      contentType: "text/html",
      body: "<main>Temporarilyish unavailable</main>",
      expectedExitCode: 0,
    },
    {
      name: "a longer second word that starts with the canonical marker",
      contentType: "text/html",
      body: "<main>Temporarily unavailableish</main>",
      expectedExitCode: 0,
    },
    {
      name: "a successful JSON error representation",
      contentType: "application/json",
      body: '{"error":"policy resolver unavailable"}',
      expectedExitCode: 1,
      expectedFailure: "content-type",
    },
    {
      name: "canonical visible text split across markup",
      contentType: "text/html",
      body: "<main>Temporarily <span>unavailable</span></main>",
      expectedExitCode: 1,
      expectedFailure: "degraded-marker",
    },
    {
      name: "ordinary healthy HTML",
      contentType: "text/html; charset=utf-8",
      body: "<main>Marketplace policies are available.</main>",
      expectedExitCode: 0,
    },
  ])(
    "classifies $name through the real checker CLI",
    async ({ contentType, body, expectedExitCode, expectedFailure }) => {
      const baseUrl = await startRouteServer((_request, response) => {
        response.writeHead(200, { "Content-Type": contentType });
        response.end(body);
      });

      const result = await runCheckerCli(baseUrl);

      expect(result.signal).toBeNull();
      expect(result.exitCode).toBe(expectedExitCode);
      await expectEveryStrictTargetIn(result.output);
      if (expectedFailure === "degraded-marker") {
        expect(result.stderr.match(/returned the degraded marker/gu)).toHaveLength(5);
      }
      if (expectedFailure === "content-type") {
        expect(result.stderr.match(/must return HTML content/gu)).toHaveLength(5);
      }
      if (expectedExitCode === 0) {
        expect(result.stdout).toContain("Passed 32 public routes in healthy mode.");
        expect(result.stderr).not.toContain("returned the degraded marker");
      }
    },
  );

  it("accepts healthy HTML content with normal media-type casing and parameters", async () => {
    const baseUrl = await startRouteServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "Text/HTML; Charset=UTF-8" });
      response.end(
        '<html><body><script>"Temporarily unavailable"</script><main data-note="Temporarily unavailable">Service unavailable temporarily.</main></body></html>',
      );
    });

    await expect(
      smokePublicWebRoutes({ baseUrl, mode: "healthy", attempts: 1, logger: quietLogger }),
    ).resolves.toMatchObject({ strictRoutes: expect.any(Array) });
  });

  it("retries a failed healthy response and validates the successful response metadata", async () => {
    const attemptsByPath = new Map();
    const baseUrl = await startRouteServer((request, response) => {
      const attempts = (attemptsByPath.get(request.url) ?? 0) + 1;
      attemptsByPath.set(request.url, attempts);
      if (request.url === "/sales-fees" && attempts === 1) {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end('{"error":"retryable"}');
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<main>Healthy public page</main>");
    });

    await expect(
      smokePublicWebRoutes({ baseUrl, mode: "healthy", attempts: 2, retryDelayMs: 1, logger: quietLogger }),
    ).resolves.toMatchObject({ strictRoutes: expect.any(Array) });
    expect(attemptsByPath.get("/sales-fees")).toBe(2);
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
