import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { classifyChanges } from "./change-scope.mjs";
import { repoRoot } from "./lib/repo.mjs";
import {
  ADMIN_DEPLOYED_API_SMOKE_PROBES,
  ADMIN_DEPLOYED_PAGE_SMOKE_ROWS,
  selectAdminDeployedApiSmokeProbes,
  selectAdminDeployedPageSmokeRows,
} from "./admin-shell-smoke-matrix.mjs";

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
        step.if === caller.step.if,
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

async function startCompositionServer({ deliberatelyBroken = true } = {}) {
  const requests = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://route-smoke.test").pathname;
    requests.push(pathname);
    if (deliberatelyBroken && pathname === "/faq") {
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
    requests,
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

function runPlatformSmoke(baseUrl, { env = {}, observer = "" } = {}) {
  const imports = observer ? ["--import", `data:text/javascript,${encodeURIComponent(observer)}`] : [];
  const child = spawn(process.execPath, [...imports, "./scripts/platform-smoke.mjs", baseUrl, baseUrl], {
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
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
      const events = stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith("[admin-retry-observer]"))
        .map((line) => JSON.parse(line.slice("[admin-retry-observer]".length)));
      resolve({ code, signal, stdout, stderr, events });
    });
  });
}

const syntheticSessionToken = "synthetic-smoke-retry-session";
const authProbePath = "/api/auth/session";

async function startAdminRetryServer(overrides = {}) {
  const fixture = await startCompositionServer({ deliberatelyBroken: false });
  fixture.server.removeAllListeners("request");
  fixture.closedBodies = [];
  fixture.server.on("request", (request, response) => {
    const requestPath = request.url;
    fixture.requests.push({
      path: requestPath,
      method: request.method,
      accept: request.headers.accept,
      authorization: request.headers.authorization,
    });
    const attempt = fixture.requests.filter((entry) => entry.path === requestPath).length;
    const override = overrides[requestPath]?.(attempt);
    if (override?.transport === "network") {
      request.socket.destroy();
      return;
    }
    if (override?.transport === "timeout") return;
    let body;
    let contentType;
    if (requestPath === "/api/auth/password-sign-in") {
      contentType = "application/json";
      body = JSON.stringify({ type: "session-started", sessionToken: syntheticSessionToken });
    } else if (requestPath.startsWith("/api/")) {
      contentType = "application/json";
      body = "{}";
    } else {
      contentType = "text/html; charset=utf-8";
      body = `<html><body>Commercial Terms Active and scheduled terms Access Catalog Commerce Growth Support Platform Account menu ${ADMIN_DEPLOYED_PAGE_SMOKE_ROWS.flatMap((row) => row.expectedText).join(" ")}</body></html>`;
    }
    if (override && Object.hasOwn(override, "contentType")) contentType = override.contentType;
    response.writeHead(override?.status ?? 200, override?.statusText ?? "Synthetic response", {
      ...(contentType ? { "Content-Type": contentType } : {}),
    });
    if (override?.incomplete) {
      response.on("close", () => fixture.closedBodies.push({ path: requestPath, attempt }));
      response.write(override.body ?? "synthetic incomplete stream");
    } else {
      response.end(override?.body ?? body);
    }
  });
  return fixture;
}

// Observe the real CLI's native fetch/cancel/timer boundaries without replacing its contract.
function adminRetryObserver({ absentBody = false, cancellationFailure = false } = {}) {
  return `
    import { writeSync } from "node:fs";
    const send = (event) => writeSync(1, "[admin-retry-observer]" + JSON.stringify(event) + "\\n");
    const nativeTimer = globalThis.setTimeout;
    globalThis.setTimeout = (callback, milliseconds, ...args) => {
      if (milliseconds === 7) send({ kind: "retry-delay" });
      return nativeTimer(callback, milliseconds, ...args);
    };
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const path = new URL(input).pathname + new URL(input).search;
      send({ kind: "fetch", path });
      let response = await nativeFetch(input, init);
      if (${absentBody} && path === "${authProbePath}") {
        await response.body?.cancel();
        response = new Response(null, { status: response.status, headers: response.headers });
        send({ kind: "absent-body", path });
      }
      if (response.body) {
        const body = response.body;
        const nativeCancel = body.cancel.bind(body);
        body.cancel = async (...args) => {
          send({ kind: "cancel-start", path });
          await nativeCancel(...args);
          send({ kind: "cancel-end", path });
          if (${cancellationFailure} && path === "${authProbePath}") throw new Error("synthetic-cleanup-secret");
        };
      }
      return response;
    };
  `;
}

function runAdminRetrySmoke(
  fixture,
  { attempts = 3, topologyMode = "staging", postage = true, ...observerOptions } = {},
) {
  return runPlatformSmoke(fixture.baseUrl, {
    env: {
      PLATFORM_ADMIN_EMAIL: "admin@smoke-retry.test",
      PLATFORM_ADMIN_PASSWORD: "synthetic-smoke-retry-password",
      SMOKE_REQUIRE_ADMIN: "true",
      SMOKE_REQUIRE_LANDING: "false",
      SMOKE_REQUIRE_FULFILLMENT_POSTAGE: String(postage),
      SMOKE_ADMIN_TOPOLOGY: topologyMode,
      SMOKE_FETCH_ATTEMPTS: String(attempts),
      SMOKE_FETCH_RETRY_DELAY_MS: "7",
      SMOKE_FETCH_TIMEOUT_MS: "100",
      SMOKE_REQUIRE_ADMIN_GOOGLE_WORKSPACE_SSO: "false",
      SMOKE_REQUIRE_MARKETPLACE_ROOT: "false",
      SMOKE_REQUIRE_LEGACY_REDIRECT: "false",
    },
    observer: adminRetryObserver(observerOptions),
  });
}

function expectRetryCount(result, fixture, requestPath, count, succeeded) {
  expect(result.code, result.stderr).toBe(succeeded ? 0 : 1);
  expect(result.signal).toBeNull();
  expect(fixture.requests.filter((request) => request.path === requestPath)).toHaveLength(count);
  expect(result.events.filter((event) => event.kind === "fetch" && event.path === requestPath)).toHaveLength(count);
  expect(result.events.filter((event) => event.kind === "retry-delay")).toHaveLength(count - 1);
  expect(result.stderr.match(/retrying in 7ms/g) ?? []).toHaveLength(count - 1);
  expect(result.stdout.includes("Platform smoke checks passed.")).toBe(succeeded);
}

describe("admin API retry", () => {
  it.each([
    { name: "HTML 503", status: 503, contentType: "text/html", succeedsAt: 2 },
    { name: "missing type", status: 200, contentType: null, succeedsAt: 2 },
    { name: "wrong type on last attempt", status: 401, contentType: "text/plain", succeedsAt: 3 },
  ])("admin API retry: transient content — $name", async ({ status, contentType, succeedsAt }) => {
    const fixture = await startAdminRetryServer({
      [authProbePath]: (attempt) => (attempt < succeedsAt ? { status, contentType } : undefined),
    });
    const result = await runAdminRetrySmoke(fixture);
    expectRetryCount(result, fixture, authProbePath, succeedsAt, true);
  });

  it.each([1, 3])("admin API retry: exhaustion — N=%s", async (attempts) => {
    const fixture = await startAdminRetryServer({ [authProbePath]: () => ({ status: 503, contentType: "text/html" }) });
    const result = await runAdminRetrySmoke(fixture, { attempts });
    expectRetryCount(result, fixture, authProbePath, attempts, false);
    expect(result.stderr).toContain("SMOKE-PROBE-AUTH-SESSION /api/auth/session");
    expect(result.stderr).toContain("503 content-type mismatch");
  });

  it.each([
    { topologyMode: "staging", postage: true, count: 15 },
    { topologyMode: "staging", postage: false, count: 14 },
    { topologyMode: "production-platform-disabled", postage: true, count: 6 },
    { topologyMode: "production-platform-disabled", postage: false, count: 6 },
  ])("admin API retry: matrix contract — $topologyMode postage=$postage", async ({ topologyMode, postage, count }) => {
    const fixture = await startAdminRetryServer();
    const result = await runAdminRetrySmoke(fixture, { topologyMode, postage });
    expect(result.code, result.stderr).toBe(0);
    const probes = selectAdminDeployedApiSmokeProbes({ topologyMode, requireFulfillmentPostage: postage });
    expect(probes).toHaveLength(count);
    const apiPaths = new Set(ADMIN_DEPLOYED_API_SMOKE_PROBES.map((probe) => probe.path));
    expect(fixture.requests.filter((request) => apiPaths.has(request.path))).toEqual(
      probes.map((probe) => ({
        path: probe.path,
        method: probe.method,
        accept: probe.accept,
        authorization: `Bearer ${syntheticSessionToken}`,
      })),
    );
    expect(result.events.filter((event) => event.kind === "retry-delay")).toEqual([]);
    const pagePaths = fixture.requests
      .filter((request) => !request.path.startsWith("/api/"))
      .map((request) => request.path);
    expect(pagePaths).toEqual([
      "/",
      "/commerce/terms/schedules",
      "/commerce/terms/agreements",
      ...selectAdminDeployedPageSmokeRows({ requireFulfillmentPostage: postage }).map((row) => row.path),
    ]);
    expect(result.events.filter((event) => event.kind === "cancel-start").map((event) => event.path)).toEqual(
      probes.map((probe) => probe.path),
    );
  });

  it.each([
    { probeIndex: 0, status: 503, contentType: "application/json; charset=utf-8", accepted: true },
    { probeIndex: 10, status: 503, contentType: "application/json", accepted: false },
    { probeIndex: 11, status: 503, contentType: "application/json", accepted: false },
    { probeIndex: 0, status: 500, contentType: "application/json", accepted: false },
    { probeIndex: 10, status: 200, contentType: "text/csv", accepted: true },
    { probeIndex: 11, status: 200, contentType: "text/event-stream", accepted: true },
    { probeIndex: 12, status: 404, contentType: "application/json", accepted: true },
    { probeIndex: 11, status: 404, contentType: "application/json", accepted: false },
    { probeIndex: 0, status: 200, contentType: "text/csv", accepted: false },
    { probeIndex: 10, status: 200, contentType: "text/event-stream", accepted: false },
    { probeIndex: 11, status: 200, contentType: "text/csv", accepted: false },
  ])(
    "admin API retry: matrix contract — row $probeIndex $status $contentType",
    async ({ probeIndex, status, contentType, accepted }) => {
      const probe = ADMIN_DEPLOYED_API_SMOKE_PROBES[probeIndex];
      const fixture = await startAdminRetryServer({ [probe.path]: () => ({ status, contentType }) });
      const result = await runAdminRetrySmoke(fixture);
      expectRetryCount(result, fixture, probe.path, accepted ? 1 : 3, accepted);
      if (!accepted) expect(result.stderr).toContain(`${probe.id} ${probe.path}`);
    },
  );

  it.each([true, false])("admin API retry: body disposal — incomplete rejected HTML recovery=%s", async (recovers) => {
    const streamPath = ADMIN_DEPLOYED_API_SMOKE_PROBES[11].path;
    const fixture = await startAdminRetryServer({
      [authProbePath]: (attempt) =>
        recovers && attempt === 3 ? undefined : { status: 503, contentType: "text/html", incomplete: true },
      [streamPath]: () => ({ contentType: "text/event-stream", incomplete: true }),
    });
    const result = await runAdminRetrySmoke(fixture);
    expectRetryCount(result, fixture, authProbePath, 3, recovers);
    const lifecycle = result.events
      .filter((event) => event.path === authProbePath || event.kind === "retry-delay")
      .map((event) => event.kind);
    expect(lifecycle).toEqual([
      "fetch",
      "cancel-start",
      "cancel-end",
      "retry-delay",
      "fetch",
      "cancel-start",
      "cancel-end",
      "retry-delay",
      "fetch",
      "cancel-start",
      "cancel-end",
    ]);
    expect(fixture.closedBodies.filter((entry) => entry.path === authProbePath)).toHaveLength(recovers ? 2 : 3);
    if (recovers) {
      const streamStart = result.events.findIndex((event) => event.path === streamPath);
      expect(result.events.slice(streamStart, streamStart + 4)).toEqual([
        { kind: "fetch", path: streamPath },
        { kind: "cancel-start", path: streamPath },
        { kind: "cancel-end", path: streamPath },
        { kind: "fetch", path: ADMIN_DEPLOYED_API_SMOKE_PROBES[12].path },
      ]);
      expect(fixture.closedBodies).toContainEqual({ path: streamPath, attempt: 1 });
    }
    expect(fixture.sockets.size).toBe(0);
  });

  it.each([true, false])("admin API retry: body disposal — absent body accepted=%s", async (accepted) => {
    const fixture = await startAdminRetryServer({
      [authProbePath]: () => ({ status: 503, contentType: accepted ? "application/json" : "text/html" }),
    });
    const result = await runAdminRetrySmoke(fixture, { absentBody: true });
    expectRetryCount(result, fixture, authProbePath, accepted ? 1 : 3, accepted);
    expect(result.events.filter((event) => event.kind === "absent-body")).toHaveLength(accepted ? 1 : 3);
  });

  it.each([
    { name: "wrong page type", contentType: "application/json", body: "{}", reason: "instead of HTML" },
    {
      name: "missing page text",
      contentType: "text/html",
      body: "<html></html>",
      reason: "did not include expected text",
    },
  ])("admin API retry: matrix contract — preserves $name failure", async ({ contentType, body, reason }) => {
    const pagePath = "/commerce/terms/schedules";
    const fixture = await startAdminRetryServer({ [pagePath]: () => ({ contentType, body }) });
    const result = await runAdminRetrySmoke(fixture);
    expectRetryCount(result, fixture, pagePath, 1, false);
    expect(result.stderr).toContain(reason);
    expect(fixture.requests.some((request) => request.path === authProbePath)).toBe(false);
    expect(result.events.some((event) => event.kind === "cancel-start" && event.path === pagePath)).toBe(false);
  });

  it("admin API retry: body disposal — cancellation rejection cannot yield success", async () => {
    const fixture = await startAdminRetryServer({
      [authProbePath]: (attempt) =>
        attempt === 1 ? { status: 503, contentType: "text/html", incomplete: true } : undefined,
    });
    const result = await runAdminRetrySmoke(fixture, { cancellationFailure: true });
    expectRetryCount(result, fixture, authProbePath, 1, false);
    expect(result.stderr).toContain("503: response body cancellation failed");
    expect(result.stderr).not.toContain("synthetic-cleanup-secret");
    expect(fixture.sockets.size).toBe(0);
  });

  it.each([
    { transport: "network", recovers: true },
    { transport: "network", recovers: false },
    { transport: "timeout", recovers: true },
    { transport: "timeout", recovers: false },
  ])("admin API retry: transport failure — $transport recovery=$recovers", async ({ transport, recovers }) => {
    const fixture = await startAdminRetryServer({
      [authProbePath]: (attempt) => (recovers && attempt === 3 ? undefined : { transport }),
    });
    const result = await runAdminRetrySmoke(fixture);
    expectRetryCount(result, fixture, authProbePath, 3, recovers);
    expect(result.stderr).toContain("SMOKE-PROBE-AUTH-SESSION /api/auth/session");
    expect(result.stderr).toContain(transport === "timeout" ? "timed out after 100ms" : "fetch failed");
    expect(fixture.sockets.size).toBe(0);
  });

  it.each([200, 500, 503])("admin API retry: diagnostics — safe bounded rejection for %s", async (status) => {
    const secret = "synthetic-rejected-secret";
    const fixture = await startAdminRetryServer({
      [authProbePath]: () => ({ status, contentType: `text/${secret}`, statusText: secret, body: secret }),
    });
    const result = await runAdminRetrySmoke(fixture);
    expectRetryCount(result, fixture, authProbePath, 3, false);
    expect(result.stderr).toContain(`${status} ${status === 500 ? "unexpected status" : "content-type mismatch"}`);
    expect(result.stderr).toContain("SMOKE-PROBE-AUTH-SESSION /api/auth/session");
    for (const marker of [secret, syntheticSessionToken, "synthetic-smoke-retry-password"])
      expect(result.stdout + result.stderr).not.toContain(marker);
  });
});

function workflowFormPnpmArgs(caller, baseUrl) {
  expect(caller.step.run, `${caller.relativePath}:${caller.jobName}`).toMatch(
    /pnpm run smoke:public-web-routes -- \\\n\s+--base-url "[^"]+" \\\n\s+--mode no-5xx/,
  );
  return ["run", "smoke:public-web-routes", "--", "--base-url", baseUrl, "--mode", "no-5xx"];
}

function runWorkflowFormPublicRouteSmoke(args) {
  const onWindows = process.platform === "win32";
  const command = onWindows ? process.env.ComSpec : "pnpm";
  if (!command) throw new Error("The Windows command processor is unavailable.");
  const child = spawn(command, onWindows ? ["/d", "/s", "/c", "pnpm", ...args] : args, {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
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
      reject(new Error(`workflow-form public route smoke exceeded 15000ms: ${stdout}\n${stderr}`));
    }, 15_000);
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

  it.each(["missing", "mismatched"])(
    "rejects a planted pnpm workspace prerequisite if condition that is %s",
    (mutation) => {
      for (const relativePath of workflowFilesWithRunnerNo5xxCalls()) {
        const document = structuredClone(parseWorkflow(relativePath));
        const [caller] = runnerNo5xxCallers(relativePath, document);
        expect(caller, `${relativePath} must expose its runner-side no-5xx caller`).toBeDefined();

        const prerequisite = caller.job.steps.find(
          (step) => step.uses === setupPnpmWorkspaceAction && String(step.with?.install) === "true",
        );
        expect(prerequisite, `${relativePath} must expose its pnpm workspace prerequisite`).toBeDefined();
        if (mutation === "missing") delete prerequisite.if;
        else prerequisite.if = "false";

        expect(runnerNo5xxPrerequisiteViolations(relativePath, document)).toEqual([
          `${relativePath}:${caller.jobName} must install the pinned pnpm workspace before its runner-side no-5xx call`,
        ]);
      }
    },
  );

  it("executes the asserted workflow-form invocation through the repository pnpm alias", async () => {
    const callers = workflowFilesWithRunnerNo5xxCalls().flatMap((relativePath) =>
      runnerNo5xxCallers(relativePath, parseWorkflow(relativePath)),
    );
    const fixture = await startCompositionServer({ deliberatelyBroken: false });
    const invocations = callers.map((caller) => workflowFormPnpmArgs(caller, fixture.baseUrl));
    expect(invocations).toHaveLength(2);
    expect(invocations[1]).toEqual(invocations[0]);

    const result = await runWorkflowFormPublicRouteSmoke(invocations[0]);

    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
    expect(fixture.requests.length).toBeGreaterThan(0);
    expect(result.stdout).toMatch(/\[public-route-smoke] Passed [1-9]\d* fetchable members in no-5xx mode/);
  });

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
    const requiredStep = runSteps(platformPr).find((step) =>
      step.run.includes(
        `require_job "Deploy Preview and Smoke" "\${{ needs['preview-deploy-smoke'].result }}" "\${{ needs['change-scope'].outputs.preview_deploy_smoke_required }}"`,
      ),
    );
    expect(requiredStep).toBeDefined();
    expect(requiredStep.run).toContain(
      `require_job "Deploy Preview and Smoke" "\${{ needs['preview-deploy-smoke'].result }}" "\${{ needs['change-scope'].outputs.preview_deploy_smoke_required }}"`,
    );
    expect(requiredStep.run).not.toContain("preview_result=");
    expect(requiredStep.run).not.toContain("preview_required=");
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
