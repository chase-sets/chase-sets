import { spawn } from "node:child_process";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateProjectionReadiness,
  primeBrowserE2eProjectionWakeRelayCursors,
  resolveBrowserE2ePhaseOneTimeoutMs,
  waitForBrowserE2eReadiness,
  waitForProjectionReadiness,
} from "./browser-e2e-readiness.mjs";

const cleanupTasks = [];

afterEach(async () => {
  await Promise.allSettled(cleanupTasks.splice(0).map((cleanup) => cleanup()));
});

function startFixtureServer(status) {
  const server = http.createServer((_request, response) => {
    response.writeHead(status).end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      cleanupTasks.push(() => new Promise((done) => server.close(done)));
      resolve(`http://127.0.0.1:${address.port}/health/ready`);
    });
  });
}

function startWorkerFixture() {
  const source = [
    'const http = require("node:http");',
    "const server = http.createServer((_request, response) => response.writeHead(200).end());",
    'server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));',
  ].join("");
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  cleanupTasks.push(async () => {
    if (child.exitCode === null) {
      child.kill();
    }
  });

  return new Promise((resolve, reject) => {
    let output = "";
    child.once("error", reject);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const port = Number.parseInt(output.trim(), 10);
      if (Number.isInteger(port) && port > 0) {
        resolve({ child, url: `http://127.0.0.1:${port}/health/ready` });
      }
    });
  });
}

describe("browser e2e readiness", () => {
  it("waits until every named component reports ready", async () => {
    const observations = await waitForBrowserE2eReadiness({
      components: [
        { name: "marketplace", url: "http://marketplace/health/ready" },
        { name: "platform-api", url: "http://platform-api/health/ready" },
        { name: "platform-worker", url: "http://platform-worker/health/ready" },
      ],
      fetchImpl: async () => ({ status: 200 }),
    });

    expect(observations.map(({ name }) => name)).toEqual(["marketplace", "platform-api", "platform-worker"]);
  });

  it("allows a slow but progressing boot to use the explicit phase-one budget", async () => {
    let now = 0;
    let attempts = 0;
    const timeoutMs = resolveBrowserE2ePhaseOneTimeoutMs({});

    const observations = await waitForBrowserE2eReadiness({
      components: [{ name: "platform-worker", url: "http://platform-worker/health/ready" }],
      fetchImpl: async () => ({ status: ++attempts < 3 ? 503 : 200 }),
      timeoutMs,
      pollMs: 90_000,
      now: () => now,
      sleepImpl: async (ms) => {
        now += ms;
      },
    });

    expect(now).toBe(180_000);
    expect(observations).toEqual([expect.objectContaining({ name: "platform-worker", ready: true })]);
  });

  it("allows the phase-one budget to be configured", () => {
    expect(resolveBrowserE2ePhaseOneTimeoutMs({ CHASE_SETS_BROWSER_E2E_PHASE_ONE_TIMEOUT_MS: "420000" })).toBe(420_000);
    expect(() =>
      resolveBrowserE2ePhaseOneTimeoutMs({ CHASE_SETS_BROWSER_E2E_PHASE_ONE_TIMEOUT_MS: "invalid" }),
    ).toThrow(/CHASE_SETS_BROWSER_E2E_PHASE_ONE_TIMEOUT_MS must be a positive integer/);
  });

  it("fails fast with the worker named when the ready worker fixture is killed before boot completes", async () => {
    const marketplaceUrl = await startFixtureServer(200);
    const platformApiUrl = await startFixtureServer(503);
    const worker = await startWorkerFixture();
    let workerWasObservedReady = false;

    const readiness = waitForBrowserE2eReadiness({
      components: [
        { name: "marketplace", url: marketplaceUrl },
        { name: "platform-api", url: platformApiUrl },
        { name: "platform-worker", url: worker.url },
      ],
      fetchImpl: async (url, options) => {
        const response = await fetch(url, options);
        if (url === worker.url && response.status === 200) {
          workerWasObservedReady = true;
        }
        return response;
      },
      timeoutMs: 5_000,
      pollMs: 20,
      requestTimeoutMs: 250,
      regressionToleranceMs: 100,
    });

    while (!workerWasObservedReady) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    worker.child.kill();

    await expect(readiness).rejects.toThrow(
      /Browser e2e boot failed: platform-worker became unavailable after reporting ready/,
    );
  }, 10_000);

  it("names every component that never becomes ready when the startup budget expires", async () => {
    let now = 0;

    await expect(
      waitForBrowserE2eReadiness({
        components: [
          { name: "platform-api", url: "http://platform-api/health/ready" },
          { name: "platform-worker", url: "http://platform-worker/health/ready" },
        ],
        fetchImpl: async () => ({ status: 503 }),
        timeoutMs: 100,
        pollMs: 25,
        now: () => now,
        sleepImpl: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toThrow(/Browser e2e boot stalled after 100ms: platform-api \(HTTP 503\), platform-worker \(HTTP 503\)/);
  });

  it("names a currently regressed component when services never become ready together", async () => {
    let now = 0;
    let calls = 0;

    await expect(
      waitForBrowserE2eReadiness({
        components: [
          { name: "platform-api", url: "http://platform-api/health/ready" },
          { name: "platform-worker", url: "http://platform-worker/health/ready" },
        ],
        fetchImpl: async (url) => {
          const cycle = Math.floor(calls++ / 2);
          const apiReady = cycle % 2 === 0;
          return { status: url.includes("platform-api") === apiReady ? 200 : 503 };
        },
        timeoutMs: 100,
        pollMs: 25,
        regressionToleranceMs: 1_000,
        now: () => now,
        sleepImpl: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toThrow(
      /Browser e2e boot stalled after 100ms: platform-api \(HTTP 503\).*platform-api: lifecycle evidence unavailable/s,
    );
  });
});

describe("browser e2e projection readiness", () => {
  const checkpoint = (position, overrides = {}) => ({
    projection_name: "auth-session-projection",
    source_context_name: "auth",
    subscription_version: 1,
    last_global_position: String(position),
    ...overrides,
  });

  it("requires every active subscription checkpoint to reach its source event head", () => {
    const evaluation = evaluateProjectionReadiness([
      { contextName: "auth", head: "23", checkpoints: [checkpoint(22)] },
      {
        contextName: "marketplace",
        head: "7",
        checkpoints: [checkpoint(23), checkpoint(7, { source_context_name: "marketplace" })],
      },
    ]);

    expect(evaluation.ready).toBe(false);
    expect(evaluation.lagging).toEqual([
      expect.objectContaining({
        targetContextName: "auth",
        projectionName: "auth-session-projection",
        position: "22",
        head: "23",
        gap: "1",
      }),
    ]);
  });

  it("accepts the highest subscription version and reports full convergence", () => {
    const evaluation = evaluateProjectionReadiness([
      {
        contextName: "auth",
        head: "23",
        checkpoints: [checkpoint(22), checkpoint(23, { subscription_version: 2 })],
      },
    ]);

    expect(evaluation.ready).toBe(true);
    expect(evaluation.activeCheckpointCount).toBe(1);
  });

  it("does not hold browser boot on unrelated background-context projections", () => {
    const evaluation = evaluateProjectionReadiness([
      { contextName: "auth", head: "23", checkpoints: [checkpoint(23)] },
      {
        contextName: "catalog",
        head: "6007",
        checkpoints: [checkpoint(1341, { source_context_name: "catalog" })],
      },
    ]);

    expect(evaluation.ready).toBe(true);
    expect(evaluation.activeCheckpointCount).toBe(1);
    expect(evaluation.lagging).toEqual([]);
  });

  it("holds readiness until the worker drains active projection wake intents", async () => {
    let reads = 0;
    const evaluation = await waitForProjectionReadiness({
      readSnapshot: async () => ({
        projectionSamples: [{ contextName: "auth", head: "23", checkpoints: [checkpoint(23)] }],
        activeWakeIntentCount: reads++ === 0 ? 1 : 0,
      }),
      pollMs: 1,
    });

    expect(reads).toBe(3);
    expect(evaluation.ready).toBe(true);
    expect(evaluation.activeWakeIntentCount).toBe(0);
  });

  it("names stalled worker projections when checkpoint positions stop advancing", async () => {
    let now = 0;

    await expect(
      waitForProjectionReadiness({
        readSnapshot: async () => [{ contextName: "auth", head: "23", checkpoints: [checkpoint(22)] }],
        timeoutMs: 1_000,
        stallTimeoutMs: 100,
        pollMs: 25,
        now: () => now,
        sleepImpl: async (ms) => {
          now += ms;
        },
      }),
    ).rejects.toThrow(/platform-worker work stalled for 100ms: auth\/auth-session-projection<-auth \(22\/23\)/);
  });
});

describe("browser e2e wake relay priming", () => {
  it("starts live relay delivery at each seeded event head", async () => {
    const calls = [];
    const heads = new Map([
      ["postgres://auth", "23"],
      ["postgres://marketplace", "107"],
    ]);
    const createClient = (connectionString) => ({
      connect: async () => undefined,
      end: async () => undefined,
      query: async (sql, values) => {
        calls.push({ connectionString, sql, values });
        if (sql.includes("MAX(global_position)")) {
          return { rows: [{ head: heads.get(connectionString) }] };
        }
        return { rows: [] };
      },
    });

    const primedCount = await primeBrowserE2eProjectionWakeRelayCursors({
      sandbox: {
        controlDatabaseUrl: "postgres://control",
        contextDatabaseUrls: {
          auth: "postgres://auth",
          marketplace: "postgres://marketplace",
        },
      },
      createClient,
    });

    expect(primedCount).toBe(2);
    expect(
      calls
        .filter(({ connectionString, sql }) => connectionString === "postgres://control" && sql.includes("INSERT INTO"))
        .map(({ values }) => values?.slice(0, 3)),
    ).toEqual([
      ["auth", "23", "auth:23"],
      ["marketplace", "107", "marketplace:107"],
    ]);
  });

  it("browser-e2e-cursor-priming-fails-on-registered-owner-schema-gap", async () => {
    const calls = [];
    const ended = [];
    const createClient = (connectionString) => ({
      connect: async () => undefined,
      end: async () => {
        ended.push(connectionString);
      },
      query: async (sql) => {
        calls.push({ connectionString, sql });
        if (connectionString === "postgres://registered-owner" && sql.includes("MAX(global_position)")) {
          throw new Error('relation "event_store_events" does not exist');
        }
        return { rows: [] };
      },
    });

    await expect(
      primeBrowserE2eProjectionWakeRelayCursors({
        sandbox: {
          controlDatabaseUrl: "postgres://control",
          contextDatabaseUrls: { "registered-owner": "postgres://registered-owner" },
        },
        createClient,
      }),
    ).rejects.toThrow('relation "event_store_events" does not exist');
    expect(calls).toEqual([
      {
        connectionString: "postgres://registered-owner",
        sql: expect.stringContaining("FROM event_store_events"),
      },
    ]);
    expect(ended).toEqual(["postgres://registered-owner", "postgres://control"]);
  });
});
