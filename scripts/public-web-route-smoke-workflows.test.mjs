import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { classifyChanges } from "./change-scope.mjs";
import { repoRoot } from "./lib/repo.mjs";

const expectedCallerInventory = {
  ".github/workflows/platform-compose-boot-smoke.yml": { healthy: 1, no5xx: 0 },
  ".github/workflows/platform-ephemeral-verification.yml": { healthy: 1, no5xx: 0 },
  ".github/workflows/platform-merge-gate-verification.yml": { healthy: 1, no5xx: 0 },
  ".github/workflows/platform-pr.yml": { healthy: 1, no5xx: 1 },
  ".github/workflows/platform-production.yml": { healthy: 2, no5xx: 1 },
  ".github/workflows/platform-staging-admin-smoke.yml": { healthy: 1, no5xx: 0 },
  ".github/workflows/platform-staging-rollback-drill.yml": { healthy: 2, no5xx: 0 },
  "scripts/staging-bootstrap-hook-drill.mjs": { healthy: 1, no5xx: 0 },
};

const setupPnpmWorkspaceAction = "./.github/actions/setup-pnpm-workspace";
const servers = [];

function callerSourceFiles() {
  return execFileSync("git", ["ls-files", ".github/workflows/*.yml", "scripts/*.mjs"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split(/\r?\n/)
    .filter((filePath) => filePath && !filePath.endsWith(".test.mjs"));
}

function occurrences(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function parseWorkflow(relativePath) {
  return parseYaml(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function runSteps(document) {
  return Object.values(document.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => typeof step.run === "string");
}

function runnerNo5xxCallers(relativePath, document) {
  return Object.entries(document.jobs ?? {}).flatMap(([jobName, job]) =>
    (job.steps ?? []).flatMap((step, stepIndex) =>
      typeof step.run === "string" && /pnpm run smoke:public-web-routes --[\s\S]*?--mode no-5xx/.test(step.run)
        ? [{ relativePath, jobName, job, step, stepIndex }]
        : [],
    ),
  );
}

function runnerNo5xxPrerequisiteViolations(relativePath, document) {
  return runnerNo5xxCallers(relativePath, document).flatMap((caller) => {
    const prerequisiteIndex = caller.job.steps.findIndex(
      (step, stepIndex) =>
        stepIndex < caller.stepIndex &&
        step.uses === setupPnpmWorkspaceAction &&
        String(step.with?.install) === "true" &&
        (step.if === undefined || step.if === caller.step.if),
    );
    return prerequisiteIndex >= 0
      ? []
      : [`${relativePath}:${caller.jobName} must install the pinned pnpm workspace before its runner-side no-5xx call`];
  });
}

function workflowFilesWithRunnerNo5xxCalls() {
  return callerSourceFiles()
    .filter((relativePath) => relativePath.startsWith(".github/workflows/"))
    .filter((relativePath) =>
      readFileSync(path.join(repoRoot, relativePath), "utf8").includes("pnpm run smoke:public-web-routes"),
    );
}

function withChangedFileEnvironmentCleared(action) {
  const names = ["CHANGED_FILES", "CHANGED_FILES_JSON", "CHANGED_FILES_FILE"];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    for (const name of names) expect(process.env[name], `${name} must be explicitly cleared`).toBeUndefined();
    return action();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function startCompositionServer() {
  const sockets = new Set();
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://route-smoke.test").pathname;
    if (pathname === "/faq") {
      response.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<html><body>deliberately broken policy source</body></html>");
      return;
    }
    if (pathname === "/api/health/ready") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end('{"ready":true}');
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<html><body>healthy</body></html>");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const fixture = {
    server,
    sockets,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
  servers.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of servers.splice(0)) {
    for (const socket of fixture.sockets) socket.destroy();
    if (fixture.server.listening) await new Promise((resolve) => fixture.server.close(resolve));
  }
});

function runPlatformSmoke(baseUrl) {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "./scripts/platform-smoke.mjs", baseUrl, baseUrl],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        NO_COLOR: "1",
        SMOKE_REQUIRE_ADMIN: "false",
        SMOKE_REQUIRE_FULFILLMENT_POSTAGE: "false",
        SMOKE_REQUIRE_LANDING: "true",
        SMOKE_REQUIRE_MARKETPLACE: "false",
        SMOKE_REQUIRE_NATIVE_MCP: "false",
        SMOKE_REQUIRE_SOCIAL_LOGIN: "false",
        SMOKE_WRITE_WAITLIST: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`platform smoke composition exceeded 4500ms: ${stdout}\n${stderr}`));
    }, 4_500);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe("public route smoke workflow composition", () => {
  it("keeps the re-derived caller inventory complete with exact modes", () => {
    const discovered = {};
    for (const relativePath of callerSourceFiles()) {
      const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
      const healthy =
        occurrences(source, /^\s*(?:run:\s*)?pnpm run smoke:platform(?:\s|$)/gm) +
        occurrences(source, /\[\s*"run"\s*,\s*"smoke:platform"\s*,/g);
      const no5xx = occurrences(source, /^\s*boot_smoke public-web(?:\s|$)/gm);
      if (healthy > 0 || no5xx > 0) discovered[relativePath] = { healthy, no5xx };
    }
    expect(discovered).toEqual(expectedCallerInventory);

    const platformSmoke = readFileSync(path.join(repoRoot, "scripts/platform-smoke.mjs"), "utf8");
    const readiness = platformSmoke.indexOf('await expectOk("platform API health through landing"');
    const routeWalk = platformSmoke.indexOf("await smokePublicWebRoutes({");
    expect(readiness).toBeGreaterThanOrEqual(0);
    expect(routeWalk).toBeGreaterThan(readiness);
    expect(platformSmoke.slice(routeWalk, routeWalk + 160)).toContain('mode: "healthy"');

    for (const relativePath of Object.keys(expectedCallerInventory).filter(
      (candidate) => expectedCallerInventory[candidate].no5xx > 0,
    )) {
      const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
      expect(source).toContain("pnpm run smoke:public-web-routes");
      expect(source).toMatch(/--mode no-5xx/);
      expect(source.indexOf("pnpm run smoke:public-web-routes")).toBeGreaterThan(source.indexOf("curl --fail"));
    }
  });

  it("installs the pinned pnpm workspace before every runner-side no-5xx caller", () => {
    const workflowFiles = workflowFilesWithRunnerNo5xxCalls();
    const callers = workflowFiles.flatMap((relativePath) =>
      runnerNo5xxCallers(relativePath, parseWorkflow(relativePath)),
    );
    expect(
      callers.map(({ relativePath, jobName }) => `${relativePath}:${jobName}`),
      "the runner-side no-5xx caller inventory changed",
    ).toEqual([
      ".github/workflows/platform-pr.yml:docker-image",
      ".github/workflows/platform-production.yml:build-image",
    ]);

    expect(
      workflowFiles.flatMap((relativePath) =>
        runnerNo5xxPrerequisiteViolations(relativePath, parseWorkflow(relativePath)),
      ),
    ).toEqual([]);
  });

  it.each(["removed", "moved after the call"])(
    "rejects a planted pnpm workspace prerequisite that is %s",
    (mutation) => {
      for (const relativePath of workflowFilesWithRunnerNo5xxCalls()) {
        const document = structuredClone(parseWorkflow(relativePath));
        const [caller] = runnerNo5xxCallers(relativePath, document);
        expect(caller, `${relativePath} must expose its runner-side no-5xx caller`).toBeDefined();

        const prerequisiteIndex = caller.job.steps.findIndex(
          (step) => step.uses === setupPnpmWorkspaceAction && String(step.with?.install) === "true",
        );
        expect(prerequisiteIndex, `${relativePath} must expose its pnpm workspace prerequisite`).toBeGreaterThanOrEqual(
          0,
        );
        const [prerequisite] = caller.job.steps.splice(prerequisiteIndex, 1);
        if (mutation === "moved after the call") {
          const [mutatedCaller] = runnerNo5xxCallers(relativePath, document);
          mutatedCaller.job.steps.splice(mutatedCaller.stepIndex + 1, 0, prerequisite);
        }

        expect(runnerNo5xxPrerequisiteViolations(relativePath, document)).toEqual([
          `${relativePath}:${caller.jobName} must install the pinned pnpm workspace before its runner-side no-5xx call`,
        ]);
      }
    },
  );

  it("keeps every deployed caller enforcing and free of swallowed exits", () => {
    for (const [relativePath, counts] of Object.entries(expectedCallerInventory).filter(([filePath]) =>
      filePath.startsWith(".github/workflows/"),
    )) {
      const steps = runSteps(parseWorkflow(relativePath));
      const healthySteps = steps.filter((step) => /^\s*pnpm run smoke:platform(?:\s|$)/m.test(step.run));
      expect(healthySteps, relativePath).toHaveLength(counts.healthy);
      for (const step of healthySteps) {
        expect(step["continue-on-error"], relativePath).not.toBe(true);
        expect(step.run, relativePath).not.toMatch(/pnpm run smoke:platform[^\n]*(?:\|\|\s*true|;\s*exit\s+0)/);
      }
      const bootSteps = steps.filter((step) => /^\s*boot_smoke public-web(?:\s|$)/m.test(step.run));
      expect(bootSteps, relativePath).toHaveLength(counts.no5xx);
      for (const step of bootSteps) {
        expect(step["continue-on-error"], relativePath).not.toBe(true);
        expect(step.run).toContain("return 1");
        expect(step.run).not.toMatch(/pnpm run smoke:public-web-routes[^\n]*(?:\|\|\s*true|;\s*exit\s+0)/);
      }
    }

    const stagingDrill = readFileSync(path.join(repoRoot, "scripts/staging-bootstrap-hook-drill.mjs"), "utf8");
    expect(stagingDrill).toMatch(
      /\["run", "smoke:platform", "--", options\.landingUrl, options\.adminUrl, options\.marketplaceUrl\]/,
    );
    expect(stagingDrill).toMatch(/phase\.status = result\.exitCode === 0 \? "success" : "failure"/);
    expect(stagingDrill).toMatch(
      /const smokeFailures = Object\.values\(record\.phases\)\.filter\(\(phase\) => phase\?\.status === "failure"\)/,
    );
    expect(stagingDrill).toMatch(
      /record\.result = record\.errors\.length === 0 && smokeFailures\.length === 0 && rollbackOk \? "success" : "failure"/,
    );
    expect(stagingDrill).toContain("process.exitCode = passesDrillGate ? 0 : 1");
  });

  it("propagates a real checker exit 1 through platform smoke", async () => {
    const fixture = await startCompositionServer();
    const result = await runPlatformSmoke(fixture.baseUrl);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("[status-5xx] faq (/faq)");
    expect(result.stderr).not.toContain("deliberately broken policy source");
    expect(result.stdout).not.toContain("Platform smoke checks passed.");
  });

  it("makes a changed checker select the required Deploy Preview and Smoke path", () => {
    const scope = classifyChanges({ changedFiles: ["scripts/public-web-route-smoke.mjs"] });
    expect(scope.clusterPreviewRequired).toBe(true);
    expect(scope.localChecksRequired).toBe(true);
    expect(scope.composeSmokeRequired).toBe(false);

    const platformPr = parseWorkflow(".github/workflows/platform-pr.yml");
    const requiredStep = runSteps(platformPr).find((step) => step.run.includes('preview_required="${{'));
    expect(requiredStep).toBeDefined();
    expect(requiredStep.run).toContain(`preview_result="\${{ needs['preview-deploy-smoke'].result }}"`);
    expect(requiredStep.run).toContain(
      `if [ "$preview_required" = "true" ] && [ "$preview_result" != "success" ]; then`,
    );
    expect(requiredStep.run).toMatch(/Preview deployment and smoke must pass[\s\S]*exit 1/);
  });

  it.each([
    {
      name: "unrelated script",
      changedFiles: ["scripts/unrelated-maintenance.mjs"],
      reached(scope) {
        return scope.localChecksRequired;
      },
    },
    {
      name: "non-platform workflow",
      changedFiles: [".github/workflows/review-cadence-digest.yml"],
      reached(scope) {
        return scope.workflowLintRequired;
      },
    },
    {
      name: "documentation",
      changedFiles: ["docs/runbooks/unrelated.md"],
      reached(scope) {
        return scope.docsOnly;
      },
    },
  ])("does not select the route-smoke deploy path for $name", ({ changedFiles, reached }) => {
    withChangedFileEnvironmentCleared(() => {
      const scope = classifyChanges({ changedFiles });
      expect(reached(scope), "the intended negative-control branch was not reached").toBe(true);
      expect(scope.clusterPreviewRequired).toBe(false);
      expect(scope.composeSmokeRequired).toBe(false);
    });
  });
});
