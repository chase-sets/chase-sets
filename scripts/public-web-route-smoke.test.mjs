import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { helpArticles } from "../bounded-contexts/public-presence/features/help/domain/generated/articles.ts";
import { derivePublicWebRouteInventory } from "./public-web-route-inventory.mjs";
import {
  MAX_PUBLIC_WEB_RESPONSE_BYTES,
  parsePublicWebRouteSmokeCliArgs,
  PRODUCTION_SHAPED_LARGEST_RESPONSE_BYTES,
  PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS,
  smokePublicWebRoutes,
  STRICT_PUBLIC_ROUTE_MEMBER_IDS,
} from "./public-web-route-smoke.mjs";
import { repoRoot } from "./lib/repo.mjs";

const checkerPath = fileURLToPath(new URL("./public-web-route-smoke.mjs", import.meta.url));
const deadlineFailure = `[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.deadlineExceeded}] faq (/faq)`;
const deadlineProofCeilingMs = 1_200;
const processExitCeilingMs = 4_500;
const openServers = [];
const inventory = derivePublicWebRouteInventory({ rootDir: repoRoot });
const strictRoutes = STRICT_PUBLIC_ROUTE_MEMBER_IDS.map((memberId) => {
  const member = inventory.members.find((candidate) => candidate.memberId === memberId);
  if (!member) throw new Error(`Test inventory is missing strict member '${memberId}'.`);
  return member;
});
const strictPaths = new Set(strictRoutes.map((route) => route.path));
const fetchableRoutes = inventory.members.filter((member) => member.kind !== "INDETERMINATE");
const cleanupGateTimeoutMs = 1_200;
const cleanupCliArgs = ["--timeout-ms", "120", "--gate-timeout-ms", String(cleanupGateTimeoutMs)];
// Exact signatures, so gate exhaustion, an earlier-route deadline or the safety kill cannot pass.
const cleanupFailureOutcomes = {
  "5xx": { reachedPath: "/faq", failure: `[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.serverError}] faq (/faq)` },
  timeout: { reachedPath: "/faq", failure: `[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.deadlineExceeded}] faq (/faq)` },
  "byte-bound": {
    reachedPath: "/",
    failure: `[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.responseTooLarge}] home (/)`,
  },
};
// Explicitly synthetic: one monotonic step larger than the whole cleanup gate, taken as derivation
// begins. No sleep; native timers keep real time.
const derivationClockStepMs = 2 * cleanupGateTimeoutMs;
const derivationClockStepKey = "chase-sets.public-route-smoke.test.derivation-clock-step";
const derivationClockStepPrefix = "[derivation-clock-step]";
const complianceArticlePaths = [
  "/help/buying/community-guidelines-and-enforcement",
  "/help/selling/intellectual-property-and-dmca",
  "/help/selling/prohibited-and-restricted-items",
  "/help/selling/sales-tax",
  "/help/selling/tax-reporting-1099k",
];

function writeHtml(response, body = "<!doctype html><html><body>healthy</body></html>", status = 200) {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

function htmlWithExactBytes(byteLength) {
  const prefix = "<!doctype html><html><body>";
  const suffix = "</body></html>";
  if (byteLength < prefix.length + suffix.length) throw new Error("Exact HTML fixture is too small.");
  return `${prefix}${"x".repeat(byteLength - prefix.length - suffix.length)}${suffix}`;
}

function defaultHealthyHandler(request, response) {
  const pathname = new URL(request.url, "http://route-smoke.test").pathname;
  if (strictPaths.has(pathname)) {
    writeHtml(response);
  } else {
    writeHtml(response, "<!doctype html><html><body>not found</body></html>", 404);
  }
}

async function startServer(handler = defaultHealthyHandler) {
  const requests = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    requests.push(new URL(request.url, "http://route-smoke.test").pathname);
    handler(request, response);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const fixture = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    server,
    sockets,
    async waitForNoSockets(timeoutMs = 1_000) {
      const deadline = performance.now() + timeoutMs;
      while (sockets.size > 0 && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return sockets.size;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      server.removeAllListeners();
    },
  };
  openServers.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of openServers.splice(0)) {
    for (const socket of fixture.sockets) socket.destroy();
    if (fixture.server.listening) await fixture.close();
  }
});

const clientObserverPrefix = "[client-order-observer]";

// Test-local child preload. Node initializes its fetch client and first HTTP connection lazily, so
// a cold child would pay that one-time cost inside route 1's deadline. The preload completes one
// fetch over a real loopback connection to its own server, never the fixture, and closes that
// server and socket before the CLI module evaluates. A data: URL fetch alone leaves the first
// connection cold.
//
// The opt-in ordering observer reports, at the child's first http(s) dispatch, whether a route
// deadline is already armed and, if so, fires that deadline synchronously. This forces the
// cold-client ordering without a sleep or host load, and it never replaces a native timer.
//
// The opt-in derivation clock step offsets only performance.now(), the gate's clock. The cleanup
// checker calls the installed hook as inventory derivation begins; the offset is then constant.
function childClientPreload({ initializeClient, observeClientInitialization, derivationClockStepMs }) {
  return `
    import { writeSync } from "node:fs";
    import { createServer } from "node:http";
    if (${observeClientInitialization}) {
      const nativeSetTimeout = globalThis.setTimeout;
      let pendingDeadline;
      globalThis.setTimeout = (callback, milliseconds, ...args) => {
        const handle = nativeSetTimeout(callback, milliseconds, ...args);
        // fetchRoute arms its deadline and dispatches in one synchronous turn, so a timer
        // still pending from this turn is the dispatching request's deadline.
        pendingDeadline = callback;
        queueMicrotask(() => {
          if (pendingDeadline === callback) pendingDeadline = undefined;
        });
        return handle;
      };
      const nativeFetch = globalThis.fetch;
      let clientInitialized = false;
      globalThis.fetch = (input, init) => {
        if (!clientInitialized && /^https?:/.test(String(input))) {
          clientInitialized = true;
          const event = { kind: "client-initialization", timeoutArmed: pendingDeadline !== undefined };
          writeSync(1, ${JSON.stringify(clientObserverPrefix)} + JSON.stringify(event) + "\\n");
          pendingDeadline?.();
        }
        return nativeFetch(input, init);
      };
    }
    // Runs after the observer, so this warm-up is the observed first dispatch.
    if (${initializeClient}) {
      const server = createServer((request, response) => {
        response.writeHead(200, { "Content-Type": "text/plain", Connection: "close" });
        response.end("client initialized");
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const response = await fetch("http://127.0.0.1:" + server.address().port + "/client-initialization");
      await response.text();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    if (${derivationClockStepMs} > 0) {
      const nativeNow = performance.now.bind(performance);
      let offsetMs = 0;
      performance.now = () => nativeNow() + offsetMs;
      globalThis[Symbol.for(${JSON.stringify(derivationClockStepKey)})] = () => {
        if (offsetMs !== 0) return;
        offsetMs = ${derivationClockStepMs};
        writeSync(1, ${JSON.stringify(derivationClockStepPrefix)} + JSON.stringify({ stepMs: offsetMs }) + "\\n");
      };
    }
  `;
}

function derivationClockSteps(result) {
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith(derivationClockStepPrefix))
    .map((line) => JSON.parse(line.slice(derivationClockStepPrefix.length)));
}

function clientInitializationEvents(result) {
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith(clientObserverPrefix))
    .map((line) => JSON.parse(line.slice(clientObserverPrefix.length)));
}

function routeResultLines(result) {
  return result.stdout.split("\n").filter((line) => line.includes("->"));
}

function startCli(
  baseUrl,
  mode,
  extraArgs = [],
  executablePath = checkerPath,
  { initializeClient = true, observeClientInitialization = false, derivationClockStepMs = 0 } = {},
) {
  const preload = `data:text/javascript,${encodeURIComponent(
    childClientPreload({ initializeClient, observeClientInitialization, derivationClockStepMs }),
  )}`;
  const boundedDefaults = [
    ["--attempts", "1"],
    ["--retry-delay-ms", "1"],
    ["--timeout-ms", "500"],
    ["--gate-timeout-ms", "4000"],
  ].flatMap(([option, value]) => (extraArgs.includes(option) ? [] : [option, value]));
  const child = spawn(
    process.execPath,
    ["--import", preload, executablePath, "--base-url", baseUrl, "--mode", mode, ...boundedDefaults, ...extraArgs],
    {
      cwd: repoRoot,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  const stderrWaiters = new Set();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    for (const waiter of stderrWaiters) {
      if (!stderr.includes(waiter.needle)) continue;
      stderrWaiters.delete(waiter);
      waiter.resolve(performance.now());
    }
  });
  const startedAt = performance.now();
  const result = new Promise((resolve, reject) => {
    const safetyTimer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `public route smoke test child exceeded its ${processExitCeilingMs}ms safety deadline: ${stdout}\n${stderr}`,
        ),
      );
    }, processExitCeilingMs);
    child.once("error", (error) => {
      clearTimeout(safetyTimer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(safetyTimer);
      for (const waiter of stderrWaiters) waiter.resolve(null);
      stderrWaiters.clear();
      resolve({
        code,
        signal,
        stdout,
        stderr,
        elapsedMs: performance.now() - startedAt,
        pid: child.pid,
      });
    });
  });
  return {
    child,
    result,
    waitForStderr(needle) {
      if (stderr.includes(needle)) return Promise.resolve(performance.now());
      return new Promise((resolve) => stderrWaiters.add({ needle, resolve }));
    },
  };
}

function clientOrderProof(result, fixture) {
  return {
    code: result.code,
    elapsedMs: Math.round(result.elapsedMs),
    events: clientInitializationEvents(result),
    routeResultLines: routeResultLines(result).length,
    fixtureRequests: fixture.requests.length,
    deadlineLines: result.stderr.split(/\r?\n/).filter((line) => line.includes("deadline-exceeded")),
  };
}

async function runCli(baseUrl, mode, extraArgs = []) {
  return startCli(baseUrl, mode, extraArgs).result;
}

function cliExitDiagnostics(result) {
  const stdoutTail = Buffer.from(result.stdout).subarray(-4_096).toString("utf8");
  return `code=${result.code}, signal=${result.signal}, elapsedMs=${result.elapsedMs}, stderr=${result.stderr}, stdout tail=${stdoutTail}`;
}

async function closeAndAssertClean(fixture, result) {
  expect(result.code !== null || result.signal !== null).toBe(true);
  expect(await fixture.waitForNoSockets()).toBe(0);
  await fixture.close();
  expect(fixture.server.listening).toBe(false);
  expect(fixture.server.eventNames()).toEqual([]);
  openServers.splice(openServers.indexOf(fixture), 1);
}

async function startNeverEndingBodyFixture({ holdFirstRequest = false } = {}) {
  let signalBodyStarted;
  const bodyStarted = new Promise((resolve) => {
    signalBodyStarted = resolve;
  });
  const fixture = await startServer((request, response) => {
    const pathname = new URL(request.url, "http://route-smoke.test").pathname;
    if (pathname === "/faq") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.write("<!doctype html><html><body>partial");
      signalBodyStarted(performance.now());
      return;
    }
    if (holdFirstRequest && fixture.requests.length === 1) return;
    defaultHealthyHandler(request, response);
  });
  return { bodyStarted, fixture };
}

async function assertRealCliDeadlineProof({ bodyStarted, fixture, running }) {
  let proofTimer;
  try {
    const bodyStartedAt = await Promise.race([
      bodyStarted,
      running.result.then((result) => {
        throw new Error(`real CLI exited before requesting /faq: ${cliExitDiagnostics(result)}`);
      }),
    ]);
    const failureObservedAt = await Promise.race([
      running.waitForStderr(deadlineFailure),
      new Promise((_, reject) => {
        proofTimer = setTimeout(
          () => reject(new Error(`real CLI did not emit '${deadlineFailure}' within ${deadlineProofCeilingMs}ms`)),
          deadlineProofCeilingMs,
        );
      }),
    ]);
    if (failureObservedAt === null) {
      throw new Error(`real CLI exited without emitting '${deadlineFailure}'`);
    }
    expect(failureObservedAt - bodyStartedAt).toBeLessThan(deadlineProofCeilingMs);

    const result = await running.result;
    expect(result.code, cliExitDiagnostics(result)).toBe(1);
    expect(result.stderr).toContain(deadlineFailure);
    expect(result.elapsedMs).toBeLessThan(processExitCeilingMs);
    expect(fixture.requests.indexOf("/faq")).toBeGreaterThanOrEqual(4);
    expect(result.stdout.split("\n").filter((line) => line.includes("->")).length).toBeGreaterThanOrEqual(4);
    await closeAndAssertClean(fixture, result);
    return result;
  } catch (error) {
    await reclaimFailedRun({ fixture, running });
    throw error;
  } finally {
    clearTimeout(proofTimer);
  }
}

async function reclaimFailedRun({ fixture, running }) {
  if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL");
  const result = await running.result.catch(async () => {
    if (running.child.exitCode === null && running.child.signalCode === null) {
      await new Promise((resolve) => running.child.once("close", resolve));
    }
    return { code: running.child.exitCode, signal: running.child.signalCode };
  });
  await closeAndAssertClean(fixture, result);
}

async function reclaimRunOnFailure({ fixture, running }, proof) {
  try {
    return await proof();
  } catch (error) {
    await reclaimFailedRun({ fixture, running });
    throw error;
  }
}

// Racing target arrival against child completion turns an exit before /faq (an earlier-route
// failure, gate exhaustion, or the safety kill) into a precise error instead of an endless wait.
async function abortAfterTargetArrival(running, targetStarted) {
  await Promise.race([
    targetStarted,
    running.result.then((result) => {
      throw new Error(`real CLI exited before requesting /faq: ${cliExitDiagnostics(result)}`);
    }),
  ]);
  running.child.kill("SIGTERM");
}

const gateClockStart = [
  "  const startedAt = performance.now();",
  "  const gateDeadline = startedAt + gateTimeoutMs;",
].join("\n");
const inventoryDerivation = [
  "  const inventory = options.inventory ?? derivePublicWebRouteInventory({ rootDir: options.rootDir });",
  "  const prepared = prepareInventory(inventory);",
].join("\n");

// The cleanup controls prove resource release around each route outcome under 120/1200 ms budgets,
// so their gate must not also absorb real inventory derivation. This disposable copy of the real
// checker derives and prepares inventory before the gate timestamp; production still charges it.
// `isolateDerivation: false` removes only that reordering, keeping every other transform.
async function createCleanupChecker({ isolateDerivation = true } = {}) {
  const sourcePath = new URL("./public-web-route-smoke.mjs", import.meta.url);
  const inventoryModule = new URL("./public-web-route-inventory.mjs", sourcePath).href;
  const policyValueStateModule = new URL(
    "../bounded-contexts/public-presence/features/help/domain/policy-value-state.ts",
    sourcePath,
  ).href;
  const transforms = [
    [
      'import { derivePublicWebRouteInventory } from "./public-web-route-inventory.mjs";',
      [
        `import { derivePublicWebRouteInventory as deriveRealPublicWebRouteInventory } from ${JSON.stringify(inventoryModule)};`,
        "function derivePublicWebRouteInventory(options) {",
        `  globalThis[Symbol.for(${JSON.stringify(derivationClockStepKey)})]?.();`,
        "  return deriveRealPublicWebRouteInventory(options);",
        "}",
      ].join("\n"),
    ],
    [
      '"../bounded-contexts/public-presence/features/help/domain/policy-value-state.ts"',
      JSON.stringify(policyValueStateModule),
    ],
    [
      `${gateClockStart}\n${inventoryDerivation}`,
      isolateDerivation ? `${inventoryDerivation}\n${gateClockStart}` : `${gateClockStart}\n${inventoryDerivation}`,
    ],
  ];
  let source = await readFile(sourcePath, "utf8");
  for (const [marker, replacement] of transforms) {
    if (source.split(marker).length !== 2) {
      throw new Error(`Cleanup checker could not locate exactly one '${marker.split("\n")[0].trim()}'.`);
    }
    source = source.replace(marker, () => replacement);
  }
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "public-route-smoke-cleanup-checker-"));
  const cleanupCheckerPath = path.join(temporaryDirectory, "public-web-route-smoke.mjs");
  await writeFile(cleanupCheckerPath, source, "utf8");
  return {
    checkerPath: cleanupCheckerPath,
    async remove() {
      await rm(temporaryDirectory, { force: true, recursive: true });
    },
  };
}

async function createDeadlineScopeMutant() {
  const sourcePath = new URL("./public-web-route-smoke.mjs", import.meta.url);
  const marker = '    const isStrict = mode === "healthy" && route.strict;';
  let source = await readFile(sourcePath, "utf8");
  if (source.split(marker).length !== 2) {
    throw new Error("Deadline negative control could not locate the post-header body-consumption boundary.");
  }
  source = source
    .replace(marker, `    clearTimeout(timeout);\n${marker}`)
    .replace(
      "../bounded-contexts/public-presence/features/help/domain/policy-value-state.ts",
      new URL("../bounded-contexts/public-presence/features/help/domain/policy-value-state.ts", sourcePath).href,
    )
    .replace("./public-web-route-inventory.mjs", new URL("./public-web-route-inventory.mjs", sourcePath).href);
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "public-route-smoke-deadline-mutant-"));
  const mutantPath = path.join(temporaryDirectory, "public-web-route-smoke.mjs");
  await writeFile(mutantPath, source, "utf8");
  return {
    mutantPath,
    async remove() {
      await rm(temporaryDirectory, { force: true, recursive: true });
    },
  };
}

async function createRetryDeadlineBypassMutant() {
  const sourcePath = new URL("./public-web-route-smoke.mjs", import.meta.url);
  const gateCheck = "if (remaining <= 0 || milliseconds > remaining)";
  let source = await readFile(sourcePath, "utf8");
  if (source.split(gateCheck).length !== 2) {
    throw new Error("Retry-deadline negative control could not locate the retry gate.");
  }
  source = source
    .replace(gateCheck, "if (remaining <= 0)")
    .replace(
      "../bounded-contexts/public-presence/features/help/domain/policy-value-state.ts",
      new URL("../bounded-contexts/public-presence/features/help/domain/policy-value-state.ts", sourcePath).href,
    )
    .replace("./public-web-route-inventory.mjs", new URL("./public-web-route-inventory.mjs", sourcePath).href);
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "public-route-smoke-retry-deadline-mutant-"));
  const mutantPath = path.join(temporaryDirectory, "public-web-route-smoke.mjs");
  await writeFile(mutantPath, source, "utf8");
  return {
    smoke: (await import(pathToFileURL(mutantPath).href)).smokePublicWebRoutes,
    async remove() {
      await rm(temporaryDirectory, { force: true, recursive: true });
    },
  };
}

async function exerciseRetryGateWithControlledClock(smoke) {
  vi.useFakeTimers();
  let monotonicNow = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => monotonicNow);
  let requests = 0;
  let settled;
  try {
    const outcome = smoke({
      baseUrl: "https://public-web.test",
      mode: "no-5xx",
      inventory,
      attempts: 20,
      retryDelayMs: 100,
      timeoutMs: 100,
      gateTimeoutMs: 350,
      fetchImpl: async () => {
        requests += 1;
        return new Response("<html><body>still failing</body></html>", { status: 500 });
      },
      logger: { log() {}, warn() {} },
    }).then(
      () => ({ error: null }),
      (error) => ({ error }),
    );
    outcome.then((value) => {
      settled = value;
    });

    await vi.advanceTimersByTimeAsync(0);
    while (!settled && monotonicNow < 500) {
      monotonicNow += 100;
      await vi.advanceTimersByTimeAsync(100);
    }
    return { ...(await outcome), monotonicNow, requests };
  } finally {
    now.mockRestore();
    vi.useRealTimers();
  }
}

describe("public web route smoke real CLI", () => {
  it("tolerates exactly one leading pnpm argument separator", () => {
    const expected = {
      baseUrl: "https://public-web.test",
      mode: "no-5xx",
      attempts: 2,
      retryDelayMs: 250,
      timeoutMs: 10_000,
      gateTimeoutMs: 120_000,
    };

    expect(parsePublicWebRouteSmokeCliArgs(["--", "--base-url", expected.baseUrl, "--mode", expected.mode])).toEqual(
      expected,
    );
    expect(() =>
      parsePublicWebRouteSmokeCliArgs(["--", "--", "--base-url", expected.baseUrl, "--mode", expected.mode]),
    ).toThrow("-- requires a value.");
  });

  it("fetches every CONCRETE and EXPANDED member while reporting every INDETERMINATE member", async () => {
    expect(
      helpArticles.find(
        (article) => article.href === "/help/buying/order-protection" && article.policyValueKeys.length > 0,
      ),
      "the deterministic strict help target must remain token-bearing",
    ).toBeDefined();
    const fixture = await startServer();
    const result = await runCli(fixture.baseUrl, "healthy");

    expect(result.code, cliExitDiagnostics(result)).toBe(0);
    const fetchable = inventory.members.filter((member) => member.kind !== "INDETERMINATE");
    expect(fixture.requests).toHaveLength(fetchable.length);
    for (const member of fetchable) expect(fixture.requests).toContain(member.path);
    for (const articlePath of complianceArticlePaths) expect(fixture.requests).toContain(articlePath);
    for (const member of inventory.partition.INDETERMINATE) {
      expect(result.stdout).toContain(`INDETERMINATE ${member.memberId} ${member.path}: ${member.reason}`);
    }
    for (const memberId of STRICT_PUBLIC_ROUTE_MEMBER_IDS) expect(result.stdout).toContain(memberId);
  });

  it("rejects promptly when the real CLI exits before requesting /faq", async () => {
    const { bodyStarted, fixture } = await startNeverEndingBodyFixture({ holdFirstRequest: true });
    const firstRoute = inventory.members.find((member) => member.kind !== "INDETERMINATE");
    expect(firstRoute.path).not.toBe("/faq");
    const startedAt = performance.now();
    const running = startCli(fixture.baseUrl, "healthy", ["--timeout-ms", "120"]);
    const error = await assertRealCliDeadlineProof({ bodyStarted, fixture, running }).catch((error) => error);
    const elapsedMs = performance.now() - startedAt;
    const result = await running.result;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("real CLI exited before requesting /faq");
    expect(error.message).toContain(cliExitDiagnostics(result));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.deadlineExceeded}] ${firstRoute.memberId} (${firstRoute.path})`,
    );
    expect(elapsedMs).toBeLessThan(processExitCeilingMs);
    expect(fixture.requests).toEqual([firstRoute.path]);
    expect(fixture.sockets.size).toBe(0);
    expect(fixture.server.listening).toBe(false);
    expect(fixture.server.eventNames()).toEqual([]);
    console.info(`early-exit deadline proof: elapsedMs=${elapsedMs}, ceilingMs=${processExitCeilingMs}`);
  });

  it("keeps the deadline active through a partial body that never ends after several successful routes", async () => {
    const { bodyStarted, fixture } = await startNeverEndingBodyFixture();
    const running = startCli(fixture.baseUrl, "healthy");

    await assertRealCliDeadlineProof({ bodyStarted, fixture, running });
  });

  it("proves the real-CLI deadline assertion rejects the historical post-header timeout gap", async () => {
    const mutant = await createDeadlineScopeMutant();
    try {
      const { bodyStarted, fixture } = await startNeverEndingBodyFixture();
      const running = startCli(fixture.baseUrl, "healthy", [], mutant.mutantPath);

      await expect(assertRealCliDeadlineProof({ bodyStarted, fixture, running })).rejects.toThrow(
        `real CLI did not emit '${deadlineFailure}' within ${deadlineProofCeilingMs}ms`,
      );
    } finally {
      await mutant.remove();
    }
  });

  it("accepts the measured largest production-shaped response with derived headroom", async () => {
    const fixture = await startServer((request, response) => {
      const pathname = new URL(request.url, "http://route-smoke.test").pathname;
      if (pathname === "/") {
        writeHtml(response, htmlWithExactBytes(PRODUCTION_SHAPED_LARGEST_RESPONSE_BYTES));
        return;
      }
      defaultHealthyHandler(request, response);
    });
    const result = await runCli(fixture.baseUrl, "healthy");

    expect(MAX_PUBLIC_WEB_RESPONSE_BYTES).toBe(122_727);
    expect(result.code, cliExitDiagnostics(result)).toBe(0);
    expect(result.stdout).toContain(`(${PRODUCTION_SHAPED_LARGEST_RESPONSE_BYTES} bytes)`);
  });

  it("rejects bound+1 with response-too-large, distinct from the deadline", async () => {
    const fixture = await startServer((request, response) => {
      const pathname = new URL(request.url, "http://route-smoke.test").pathname;
      if (pathname === "/") {
        writeHtml(response, htmlWithExactBytes(MAX_PUBLIC_WEB_RESPONSE_BYTES + 1));
        return;
      }
      defaultHealthyHandler(request, response);
    });
    const result = await runCli(fixture.baseUrl, "healthy");

    expect(result.code, cliExitDiagnostics(result)).toBe(1);
    expect(result.stderr).toContain(`[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.responseTooLarge}] home (/)`);
    expect(result.stderr).not.toContain(`[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.deadlineExceeded}] home (/)`);
    expect(result.elapsedMs).toBeLessThan(4_000);
    await closeAndAssertClean(fixture, result);
  });

  it("allows redirects ending at 404 and all other non-5xx statuses in no-5xx mode", async () => {
    const fixture = await startServer((request, response) => {
      const pathname = new URL(request.url, "http://route-smoke.test").pathname;
      if (pathname === "/faq") {
        response.writeHead(301, { Location: "/redirect-final-404" });
        response.end();
        return;
      }
      if (pathname === "/redirect-final-404") {
        writeHtml(response, "<html><body>not found</body></html>", 404);
        return;
      }
      writeHtml(response, "<html><body>not found</body></html>", 404);
    });
    const result = await runCli(fixture.baseUrl, "no-5xx");

    expect(result.code, cliExitDiagnostics(result)).toBe(0);
    expect(fixture.requests).toContain("/redirect-final-404");
  });

  it("rejects every 5xx in no-5xx mode and names the deliberately broken policy route", async () => {
    const fixture = await startServer((request, response) => {
      const pathname = new URL(request.url, "http://route-smoke.test").pathname;
      if (pathname === "/refunds-and-returns") {
        writeHtml(response, "<html><body>broken policy source</body></html>", 500);
        return;
      }
      writeHtml(response, "<html><body>not found</body></html>", 404);
    });
    const result = await runCli(fixture.baseUrl, "no-5xx");

    expect(result.code, cliExitDiagnostics(result)).toBe(1);
    expect(result.stderr).toContain(
      `[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.serverError}] refunds-and-returns (/refunds-and-returns)`,
    );
    expect(result.stderr).toContain("returned 500");
  });

  it("requires 200 only for strict targets in healthy mode", async () => {
    const fixture = await startServer();
    const result = await runCli(fixture.baseUrl, "healthy");

    expect(result.code, cliExitDiagnostics(result)).toBe(0);
    expect(fixture.requests).toHaveLength(inventory.members.filter((member) => member.kind !== "INDETERMINATE").length);
  });

  it.each(strictRoutes)(
    "rejects application/json for strict target $memberId at $path",
    async ({ memberId, path: routePath }) => {
      const fixture = await startServer((request, response) => {
        const pathname = new URL(request.url, "http://route-smoke.test").pathname;
        if (pathname === routePath) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end('{"error":"not a page"}');
          return;
        }
        defaultHealthyHandler(request, response);
      });
      const result = await runCli(fixture.baseUrl, "healthy");

      expect(result.code, cliExitDiagnostics(result)).toBe(1);
      expect(result.stderr).toContain(
        `[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.strictContentType}] ${memberId} (${routePath})`,
      );
    },
  );

  it("fails the aggregate degraded attribute in healthy mode and passes it in no-5xx mode", async () => {
    const degradedBody =
      '<!doctype html><html><body><span data-policy-values-state="degraded">copy is irrelevant</span></body></html>';
    const handler = (request, response) => {
      const pathname = new URL(request.url, "http://route-smoke.test").pathname;
      if (pathname === "/faq") {
        writeHtml(response, degradedBody);
        return;
      }
      defaultHealthyHandler(request, response);
    };
    const healthyFixture = await startServer(handler);
    const healthyResult = await runCli(healthyFixture.baseUrl, "healthy");
    expect(healthyResult.code, cliExitDiagnostics(healthyResult)).toBe(1);
    expect(healthyResult.stderr).toContain(
      `[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.strictDegradedState}] faq (/faq)`,
    );

    const no5xxFixture = await startServer(handler);
    const no5xxResult = await runCli(no5xxFixture.baseUrl, "no-5xx");
    expect(no5xxResult.code, cliExitDiagnostics(no5xxResult)).toBe(0);
  });

  it("does not consult visible degraded prose when the attribute is absent", async () => {
    const fixture = await startServer((request, response) => {
      const pathname = new URL(request.url, "http://route-smoke.test").pathname;
      if (strictPaths.has(pathname)) {
        writeHtml(
          response,
          "<!doctype html><html><body>Temporarily unavailable: visible phrase only, no health attribute.</body></html>",
        );
        return;
      }
      defaultHealthyHandler(request, response);
    });
    const result = await runCli(fixture.baseUrl, "healthy");

    expect(result.code, cliExitDiagnostics(result)).toBe(0);
  });

  it.each([
    {
      name: "404",
      reason: PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.strictStatus,
      final(response) {
        writeHtml(response, "<html><body>not found</body></html>", 404);
      },
    },
    {
      name: "degraded HTML",
      reason: PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.strictDegradedState,
      final(response) {
        writeHtml(response, '<html><body data-policy-values-state="degraded">unhealthy</body></html>');
      },
    },
    {
      name: "JSON",
      reason: PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.strictContentType,
      final(response) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end('{"ok":false}');
      },
    },
  ])("applies strict assertions to a redirect's final $name response", async ({ reason, final }) => {
    const fixture = await startServer((request, response) => {
      const pathname = new URL(request.url, "http://route-smoke.test").pathname;
      if (pathname === "/faq") {
        response.writeHead(301, { Location: "/redirect-final" });
        response.end();
        return;
      }
      if (pathname === "/redirect-final") {
        final(response);
        return;
      }
      defaultHealthyHandler(request, response);
    });
    const result = await runCli(fixture.baseUrl, "healthy");

    expect(result.code, cliExitDiagnostics(result)).toBe(1);
    expect(result.stderr).toContain(`[${reason}] faq (/faq)`);
    expect(fixture.requests).toContain("/redirect-final");
  });

  it("allows a slow finite body that completes just inside its request deadline", async () => {
    const fixture = await startServer((request, response) => {
      const pathname = new URL(request.url, "http://route-smoke.test").pathname;
      if (pathname === "/faq") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.write("<!doctype html><html><body>");
        setTimeout(() => response.end("finite</body></html>"), 80);
        return;
      }
      defaultHealthyHandler(request, response);
    });
    const result = await runCli(fixture.baseUrl, "healthy", ["--timeout-ms", "250", "--gate-timeout-ms", "2000"]);

    expect(result.code, cliExitDiagnostics(result)).toBe(0);
  });

  it("bounds retries by the total gate deadline without process-startup timing", async () => {
    const result = await exerciseRetryGateWithControlledClock(smokePublicWebRoutes);

    expect(result.error?.message).toContain(`[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.gateDeadlineExceeded}]`);
    expect(result.error?.message).toContain("before retry");
    expect(result.monotonicNow).toBe(300);
    expect(result.requests).toBe(4);
  });

  it("rejects a retry-deadline bypass mutant under the same controlled clock", async () => {
    const mutant = await createRetryDeadlineBypassMutant();
    try {
      const result = await exerciseRetryGateWithControlledClock(mutant.smoke);

      expect(result.error?.message).toContain(`[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.gateDeadlineExceeded}]`);
      expect(result.error?.message).toContain("before its request");
      expect(result.monotonicNow).toBe(400);
      expect(result.requests).toBe(4);
    } finally {
      await mutant.remove();
    }
  });

  it.each(["success", "5xx", "timeout", "byte-bound", "abort"])(
    "cleans sockets, listeners, timers, and the checker process after %s",
    async (caseName) => {
      let targetStarted;
      let targetBodyStarted = false;
      const targetStartedPromise = new Promise((resolve) => {
        targetStarted = resolve;
      });
      const fixture = await startServer((request, response) => {
        const pathname = new URL(request.url, "http://route-smoke.test").pathname;
        if (pathname === "/faq" && ["timeout", "abort"].includes(caseName)) {
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          response.write("<html><body>partial");
          targetBodyStarted = true;
          targetStarted();
          return;
        }
        if (pathname === "/faq" && caseName === "5xx") {
          writeHtml(response, "<html><body>failure</body></html>", 500);
          return;
        }
        if (pathname === "/" && caseName === "byte-bound") {
          writeHtml(response, htmlWithExactBytes(MAX_PUBLIC_WEB_RESPONSE_BYTES + 1));
          return;
        }
        defaultHealthyHandler(request, response);
      });
      const checker = await createCleanupChecker();
      try {
        const running = startCli(fixture.baseUrl, "healthy", cleanupCliArgs, checker.checkerPath, {
          observeClientInitialization: caseName === "success",
        });
        await reclaimRunOnFailure({ fixture, running }, async () => {
          if (caseName === "abort") await abortAfterTargetArrival(running, targetStartedPromise);
          const result = await running.result;

          if (caseName === "success") {
            console.info("[client-initialization-order]", JSON.stringify(clientOrderProof(result, fixture)));
            expect(result.code, cliExitDiagnostics(result)).toBe(0);
            expect(clientInitializationEvents(result)).toEqual([
              { kind: "client-initialization", timeoutArmed: false },
            ]);
            expect(routeResultLines(result)).toHaveLength(fetchableRoutes.length);
            for (const route of fetchableRoutes) {
              expect(result.stdout).toContain(`[public-route-smoke] ${route.memberId} ${route.path} -> `);
            }
          } else if (caseName === "abort") {
            expect(fixture.requests).toContain("/faq");
            // Windows delivers SIGTERM as termination, so the child may close without stderr.
            if (process.platform !== "win32" || result.signal !== "SIGTERM") {
              expect(result.code, cliExitDiagnostics(result)).toBe(1);
              expect(result.signal).toBeNull();
              expect(result.stderr).toContain(`[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.aborted}] faq (/faq)`);
            }
          } else {
            const { failure, reachedPath } = cleanupFailureOutcomes[caseName];
            expect(result.code, cliExitDiagnostics(result)).toBe(1);
            expect(result.signal).toBeNull();
            expect(result.stderr).toContain(failure);
            expect(fixture.requests).toContain(reachedPath);
            if (caseName === "timeout") expect(targetBodyStarted).toBe(true);
          }
          await closeAndAssertClean(fixture, result);
        });
      } finally {
        await checker.remove();
      }
    },
  );

  it("excludes inventory derivation time from the cleanup gate", async () => {
    // Governing variable: whether real derivation precedes the gate timestamp. Both arms share the
    // fixture handler, budgets, warm client and synthetic step; only the isolation transform differs.
    const runArm = async (isolateDerivation) => {
      const fixture = await startServer();
      const checker = await createCleanupChecker({ isolateDerivation });
      try {
        const result = await startCli(fixture.baseUrl, "healthy", cleanupCliArgs, checker.checkerPath, {
          derivationClockStepMs,
        }).result;
        return { fixture, result };
      } finally {
        await checker.remove();
      }
    };
    const candidate = await runArm(true);
    const bypass = await runArm(false);
    const [firstRoute] = fetchableRoutes;
    const armProof = ({ fixture, result }, isolateDerivation) => ({
      isolateDerivation,
      code: result.code,
      signal: result.signal,
      steps: derivationClockSteps(result),
      routeResultLines: routeResultLines(result).length,
      fixtureRequests: fixture.requests.length,
      gateLines: result.stderr.split(/\r?\n/).filter((line) => line.includes("gate-deadline-exceeded")),
    });
    console.info(
      "[derivation-gate-isolation]",
      JSON.stringify({
        governingVariable: "inventory derivation precedes the gate timestamp",
        derivationClockStepMs,
        gateTimeoutMs: cleanupGateTimeoutMs,
        candidate: armProof(candidate, true),
        bypass: armProof(bypass, false),
      }),
    );

    expect(derivationClockSteps(candidate.result)).toEqual([{ stepMs: derivationClockStepMs }]);
    expect(candidate.result.code, cliExitDiagnostics(candidate.result)).toBe(0);
    expect(routeResultLines(candidate.result)).toHaveLength(fetchableRoutes.length);
    for (const route of fetchableRoutes) {
      expect(candidate.result.stdout).toContain(`[public-route-smoke] ${route.memberId} ${route.path} -> `);
    }
    expect(candidate.fixture.requests).toHaveLength(fetchableRoutes.length);
    await closeAndAssertClean(candidate.fixture, candidate.result);

    expect(derivationClockSteps(bypass.result)).toEqual([{ stepMs: derivationClockStepMs }]);
    expect(bypass.result.code, cliExitDiagnostics(bypass.result)).toBe(1);
    expect(bypass.result.signal).toBeNull();
    expect(bypass.result.stderr.split(/\r?\n/)).toContain(
      `- [${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.gateDeadlineExceeded}] ${firstRoute.memberId} (${firstRoute.path}) ` +
        "exhausted the total gate deadline before its request.",
    );
    expect(routeResultLines(bypass.result)).toEqual([]);
    expect(bypass.fixture.requests).toEqual([]);
    await closeAndAssertClean(bypass.fixture, bypass.result);
  });

  it("rejects cleanup abort when the child exits before /faq", async () => {
    const [firstRoute] = fetchableRoutes;
    expect(firstRoute.path).not.toBe("/faq");
    let targetStarted;
    const targetStartedPromise = new Promise((resolve) => {
      targetStarted = resolve;
    });
    const fixture = await startServer((request, response) => {
      const pathname = new URL(request.url, "http://route-smoke.test").pathname;
      if (pathname === "/faq") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.write("<html><body>partial");
        targetStarted();
        return;
      }
      if (pathname === firstRoute.path) {
        writeHtml(response, "<html><body>failure</body></html>", 500);
        return;
      }
      defaultHealthyHandler(request, response);
    });
    const checker = await createCleanupChecker();
    try {
      const running = startCli(fixture.baseUrl, "healthy", cleanupCliArgs, checker.checkerPath);
      const error = await reclaimRunOnFailure({ fixture, running }, () =>
        abortAfterTargetArrival(running, targetStartedPromise),
      ).catch((error) => error);
      const result = await running.result;

      // A child alive at processExitCeilingMs is killed and rejects with the safety error instead, so
      // this exact early-exit error is itself the proof that the child exited within the ceiling.
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(`real CLI exited before requesting /faq: ${cliExitDiagnostics(result)}`);
      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.stderr).toContain(
        `[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.serverError}] ${firstRoute.memberId} (${firstRoute.path})`,
      );
      expect(fixture.requests).toEqual([firstRoute.path]);
      expect(fixture.sockets.size).toBe(0);
      expect(fixture.server.listening).toBe(false);
      expect(fixture.server.eventNames()).toEqual([]);
      expect(running.child.exitCode !== null || running.child.signalCode !== null).toBe(true);
    } finally {
      await checker.remove();
    }
  });

  it("reproduces the cold-client deadline signature when client initialization is withheld", async () => {
    const fixture = await startServer();
    const [firstRoute] = fetchableRoutes;
    const checker = await createCleanupChecker();
    let result;
    try {
      result = await startCli(fixture.baseUrl, "healthy", cleanupCliArgs, checker.checkerPath, {
        initializeClient: false,
        observeClientInitialization: true,
      }).result;
    } finally {
      await checker.remove();
    }

    console.info("[client-initialization-order]", JSON.stringify(clientOrderProof(result, fixture)));
    expect(result.code, cliExitDiagnostics(result)).toBe(1);
    expect(result.stderr.split(/\r?\n/)).toContain(
      `- [${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.deadlineExceeded}] ${firstRoute.memberId} (${firstRoute.path}) ` +
        "did not complete headers and body within 120ms.",
    );
    expect(routeResultLines(result)).toEqual([]);
    expect(fixture.requests).toEqual([]);
    expect(clientInitializationEvents(result)).toEqual([{ kind: "client-initialization", timeoutArmed: true }]);
    await closeAndAssertClean(fixture, result);
  });
});
