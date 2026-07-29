import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { helpArticles } from "../bounded-contexts/public-presence/features/help/domain/generated/articles.ts";
import { derivePublicWebRouteInventory } from "./public-web-route-inventory.mjs";
import {
  MAX_PUBLIC_WEB_RESPONSE_BYTES,
  PRODUCTION_SHAPED_LARGEST_RESPONSE_BYTES,
  PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS,
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

function startCli(baseUrl, mode, extraArgs = [], executablePath = checkerPath) {
  const boundedDefaults = [
    ["--attempts", "1"],
    ["--retry-delay-ms", "1"],
    ["--timeout-ms", "500"],
    ["--gate-timeout-ms", "4000"],
  ].flatMap(([option, value]) => (extraArgs.includes(option) ? [] : [option, value]));
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      executablePath,
      "--base-url",
      baseUrl,
      "--mode",
      mode,
      ...boundedDefaults,
      ...extraArgs,
    ],
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

async function runCli(baseUrl, mode, extraArgs = []) {
  return startCli(baseUrl, mode, extraArgs).result;
}

async function closeAndAssertClean(fixture, result) {
  expect(result.code !== null || result.signal !== null).toBe(true);
  expect(await fixture.waitForNoSockets()).toBe(0);
  await fixture.close();
  expect(fixture.server.listening).toBe(false);
  expect(fixture.server.eventNames()).toEqual([]);
  openServers.splice(openServers.indexOf(fixture), 1);
}

async function startNeverEndingBodyFixture() {
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
    defaultHealthyHandler(request, response);
  });
  return { bodyStarted, fixture };
}

async function assertRealCliDeadlineProof({ bodyStarted, fixture, running }) {
  const bodyStartedAt = await bodyStarted;
  let proofTimer;
  try {
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
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(deadlineFailure);
    expect(result.elapsedMs).toBeLessThan(processExitCeilingMs);
    expect(fixture.requests.indexOf("/faq")).toBeGreaterThanOrEqual(4);
    expect(result.stdout.split("\n").filter((line) => line.includes("->")).length).toBeGreaterThanOrEqual(4);
    await closeAndAssertClean(fixture, result);
    return result;
  } catch (error) {
    if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL");
    const result = await running.result;
    await closeAndAssertClean(fixture, result);
    throw error;
  } finally {
    clearTimeout(proofTimer);
  }
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

describe("public web route smoke real CLI", () => {
  it("fetches every CONCRETE and EXPANDED member while reporting every INDETERMINATE member", async () => {
    expect(
      helpArticles.find(
        (article) => article.href === "/help/buying/order-protection" && article.policyValueKeys.length > 0,
      ),
      "the deterministic strict help target must remain token-bearing",
    ).toBeDefined();
    const fixture = await startServer();
    const result = await runCli(fixture.baseUrl, "healthy");

    expect(result.code).toBe(0);
    const fetchable = inventory.members.filter((member) => member.kind !== "INDETERMINATE");
    expect(fixture.requests).toHaveLength(fetchable.length);
    for (const member of fetchable) expect(fixture.requests).toContain(member.path);
    for (const member of inventory.partition.INDETERMINATE) {
      expect(result.stdout).toContain(`INDETERMINATE ${member.memberId} ${member.path}: ${member.reason}`);
    }
    for (const memberId of STRICT_PUBLIC_ROUTE_MEMBER_IDS) expect(result.stdout).toContain(memberId);
  });

  it("keeps the deadline active through a partial body that never ends after several successful routes", async () => {
    const { bodyStarted, fixture } = await startNeverEndingBodyFixture();
    const running = startCli(fixture.baseUrl, "healthy", ["--timeout-ms", "120", "--gate-timeout-ms", "1200"]);

    await assertRealCliDeadlineProof({ bodyStarted, fixture, running });
  });

  it("proves the real-CLI deadline assertion rejects the historical post-header timeout gap", async () => {
    const mutant = await createDeadlineScopeMutant();
    try {
      const { bodyStarted, fixture } = await startNeverEndingBodyFixture();
      const running = startCli(
        fixture.baseUrl,
        "healthy",
        ["--timeout-ms", "120", "--gate-timeout-ms", "1200"],
        mutant.mutantPath,
      );

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
    expect(result.code).toBe(0);
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

    expect(result.code).toBe(1);
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

    expect(result.code).toBe(0);
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

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.serverError}] refunds-and-returns (/refunds-and-returns)`,
    );
    expect(result.stderr).toContain("returned 500");
  });

  it("requires 200 only for strict targets in healthy mode", async () => {
    const fixture = await startServer();
    const result = await runCli(fixture.baseUrl, "healthy");

    expect(result.code).toBe(0);
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

      expect(result.code).toBe(1);
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
    expect(healthyResult.code).toBe(1);
    expect(healthyResult.stderr).toContain(
      `[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.strictDegradedState}] faq (/faq)`,
    );

    const no5xxFixture = await startServer(handler);
    const no5xxResult = await runCli(no5xxFixture.baseUrl, "no-5xx");
    expect(no5xxResult.code).toBe(0);
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

    expect(result.code).toBe(0);
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

    expect(result.code).toBe(1);
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

    expect(result.code).toBe(0);
  });

  it("bounds retries by the total gate deadline", async () => {
    const fixture = await startServer((_request, response) => {
      writeHtml(response, "<html><body>still failing</body></html>", 500);
    });
    const result = await runCli(fixture.baseUrl, "no-5xx", [
      "--attempts",
      "20",
      "--retry-delay-ms",
      "100",
      "--timeout-ms",
      "100",
      "--gate-timeout-ms",
      "350",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.gateDeadlineExceeded}]`);
    expect(result.elapsedMs).toBeLessThan(1_000);
  });

  it.each(["success", "5xx", "timeout", "byte-bound", "abort"])(
    "cleans sockets, listeners, timers, and the checker process after $case",
    async (caseName) => {
      let targetStarted;
      const targetStartedPromise = new Promise((resolve) => {
        targetStarted = resolve;
      });
      const fixture = await startServer((request, response) => {
        const pathname = new URL(request.url, "http://route-smoke.test").pathname;
        if (pathname === "/faq" && ["timeout", "abort"].includes(caseName)) {
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          response.write("<html><body>partial");
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
      const running = startCli(fixture.baseUrl, "healthy", ["--timeout-ms", "120", "--gate-timeout-ms", "1200"]);
      if (caseName === "abort") {
        await targetStartedPromise;
        running.child.kill("SIGTERM");
      }
      const result = await running.result;

      if (caseName === "success") expect(result.code).toBe(0);
      else expect(result.code === 1 || result.signal !== null).toBe(true);
      if (caseName === "abort" && process.platform !== "win32") {
        expect(result.stderr).toContain(`[${PUBLIC_WEB_ROUTE_SMOKE_FAILURE_REASONS.aborted}] faq (/faq)`);
      }
      await closeAndAssertClean(fixture, result);
    },
  );
});
