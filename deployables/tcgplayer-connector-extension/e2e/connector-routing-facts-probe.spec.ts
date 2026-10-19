/// <reference types="chrome" />
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, test, type BrowserContext, type Request, type TestInfo, type Worker } from "@playwright/test";
import { TCGPLAYER_CONNECTOR_EXTENSION_ID } from "@chase-sets/channels/client";
import { platformOrigin } from "../__tests__/harness/origins";
import { observeUntil } from "../__tests__/support/browser-observation";
import { buildHarness, launchCoordinator, pair } from "./coordinator-observation";
import { launchInstallation } from "./extension-installation";
import { loopbackPlatform } from "./loopback-platform";
import { scanRetainedArtifacts } from "./retained-artifacts";

// #10109 Probe: records the Chromium routing facts the connector pairing drill depends on as
// value-free CONNECTOR_10109_RECEIPT log lines. Facts are recorded whatever they are; only the
// instrument controls and the retained-artifact scan assert. Playwright refuses trace overrides
// inside a describe group, so AC4 leg 1 (the shipped trace: "on") lives in the -shipped-trace spec,
// which sorts and runs before this file's final output scan.
test.use({ trace: "off", screenshot: "off", video: "off" });

type Row = Record<string, unknown>;
type Outcome<T> = { resolved: T } | { rejected: string };

const settleMs = 10_000;
const target = `${platformOrigin}/account/channels/connection_synthetic`;
const redirectTarget = "/probe/redirect-target";
const planted = { name: "synthetic_probe_redirect", value: "synthetic-probe-redirect-cookie-marker" };
const ownOutput = "e2e-connector-routing-fact";

let platform: Awaited<ReturnType<typeof loopbackPlatform>>;
let second: Awaited<ReturnType<typeof loopbackPlatform>>;
let extension: string;
let accountMode: "serve" | "drop" = "serve";
let claims = 0;
const platformServed: { path: string; status: number | "dropped" }[] = [];
const secondServed: string[] = [];
const contexts = new Set<BrowserContext>();

async function platformHandle(request: IncomingMessage, reply: ServerResponse) {
  const path = new URL(request.url!, "http://127.0.0.1").pathname;
  if (request.method === "POST" && path === "/channel-connector/oauth/connections/connection_synthetic/claim") {
    // An empty claim keeps the paired worker in paired-idle, as the shipped loopback does.
    claims++;
    request.resume();
    reply
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ reservation: null, pollWindowSeconds: 30 }));
    return true;
  }
  if (path.startsWith("/account/channels")) {
    if (accountMode === "drop") {
      platformServed.push({ path, status: "dropped" });
      request.socket.destroy();
      return true;
    }
    reply.on("finish", () => platformServed.push({ path, status: reply.statusCode }));
    return false;
  }
  if (path === "/probe/redirect") {
    reply
      .writeHead(302, {
        Location: `${second.origin}${redirectTarget}`,
        "Set-Cookie": `${planted.name}=${planted.value}; Path=/; HttpOnly`,
      })
      .end();
    return true;
  }
  return false;
}

const served = (path: string) => secondServed.filter((value) => value === path).length;
const forbidden = () => [...platform.forbidden(), planted.value];

function message(error: unknown) {
  let text = (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 240);
  for (const value of forbidden()) text = text.replaceAll(value, "[forbidden]");
  return text;
}

async function settle<T>(work: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { resolved: await work() };
  } catch (error) {
    return { rejected: message(error) };
  }
}

async function within<T>(promise: Promise<T>, milliseconds: number): Promise<T | "pending"> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), milliseconds);
  });
  try {
    return await Promise.race([promise, pending]);
  } finally {
    clearTimeout(timer);
  }
}

const quiet = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function locate(url: string) {
  if (url.startsWith("data:")) return "data:";
  try {
    const parsed = new URL(url);
    const origin =
      parsed.origin === platformOrigin
        ? "platform"
        : parsed.origin === second.origin
          ? "second"
          : `${parsed.protocol}//${parsed.host}`;
    return `${origin}${parsed.pathname}`;
  } catch {
    return "unparseable";
  }
}

function valueFree(row: Row) {
  const line = JSON.stringify({ issue: 10109, ...row });
  if (forbidden().some((value) => line.includes(value))) throw new Error("connector-probe-receipt-secret");
  return line;
}

function emit(testInfo: TestInfo, rows: Row[]) {
  let refused = false;
  const lines = rows.map((row) => {
    try {
      return valueFree(row);
    } catch {
      refused = true;
      return valueFree({ ac: row.ac, leg: row.leg, refused: "receipt-row-forbidden-value" });
    }
  });
  writeFileSync(testInfo.outputPath("receipt.jsonl"), `${lines.join("\n")}\n`);
  for (const line of lines) console.log(`CONNECTOR_10109_RECEIPT ${line}`);
  if (refused) throw new Error("connector-probe-receipt-secret");
}

function environment(context: BrowserContext, testInfo: TestInfo, trace: unknown, ac: string): Row {
  return {
    ac,
    leg: "environment",
    trace,
    node: process.version,
    playwright: testInfo.config.version,
    browser: context.browser()?.version() ?? null,
    run: process.env.GITHUB_RUN_ID ?? "local-diagnostic",
    attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    job: process.env.GITHUB_JOB ?? null,
    sha: process.env.GITHUB_SHA ?? null,
  };
}

async function triggerAction(context: BrowserContext, pageUrl: string) {
  const cdp = await context.browser()!.newBrowserCDPSession();
  try {
    const targets = (await cdp.send("Target.getTargets", { filter: [{ type: "tab" }, { exclude: true }] })).targetInfos;
    const tab = targets.find((value) => value.url === pageUrl);
    if (!tab) throw new Error("probe-action-target-missing");
    await cdp.send("Extensions.triggerAction", { id: TCGPLAYER_CONNECTOR_EXTENSION_ID, targetId: tab.targetId });
  } finally {
    await cdp.detach();
  }
}

const title = (worker: Worker) => settle(() => worker.evaluate(() => chrome.action.getTitle({})));

async function manualRedirect(url: string) {
  const response = await fetch(url, { redirect: "manual" });
  await response.body?.cancel();
  const location = response.headers.get("location");
  return {
    status: response.status,
    type: response.type,
    redirected: response.redirected,
    locationVisible: location !== null,
    locationIsTarget: location === `${second.origin}${redirectTarget}`,
    setCookieVisible: response.headers.has("set-cookie"),
    setCookieCount: response.headers.getSetCookie().length,
  };
}

const workerFetch = (worker: Worker, url: string) =>
  worker.evaluate(async (input) => {
    try {
      const response = await fetch(input, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      return { status: response.status, type: response.type, redirected: response.redirected };
    } catch (error) {
      return { threw: String(error).split("\n")[0]!.slice(0, 240) };
    }
  }, url);

type Observation = ReturnType<typeof freshObservation>;
type RoutedRequest = Pick<
  Request,
  "url" | "method" | "resourceType" | "isNavigationRequest" | "serviceWorker" | "response"
>;

const freshObservation = () => ({
  clickedAt: 0,
  routed: [] as Row[],
  routedMs: null as number | null,
  response: null as Promise<Outcome<number | null> | "pending"> | null,
  responseMs: null as number | null,
  contextResponses: [] as Row[],
  failed: [] as Row[],
});

function observeRoute(leg: Observation, request: RoutedRequest) {
  const row: Row = {
    path: locate(request.url()),
    method: request.method(),
    resourceType: request.resourceType(),
    navigation: request.isNavigationRequest(),
    serviceWorker: request.serviceWorker() !== null,
  };
  leg.routed.push(row);
  if (request.url() === target && !leg.response) {
    leg.routedMs = Math.round(performance.now() - leg.clickedAt);
    leg.response = within(
      settle(async () => (await request.response())?.status() ?? null).then((outcome) => {
        leg.responseMs = Math.round(performance.now() - leg.clickedAt);
        return outcome;
      }),
      settleMs,
    );
  }
  return row;
}

// Hosted run 39249159122 routed the target after the loopback had already signalled, so the target's
// response is selected only once the quiet interval is over, and the row reads that same completed leg.
// "not-routed" therefore means the route never saw the target within the interval.
async function completeObservation(leg: Observation, loopbackServed: () => boolean) {
  await observeUntil(
    () => leg.response !== null || leg.contextResponses.length > 0 || leg.failed.length > 0 || loopbackServed(),
    settleMs,
  );
  await quiet(1000);
  const requestResponse = leg.response ? await leg.response : "not-routed";
  return {
    routedCount: leg.routed.length,
    routed: leg.routed,
    targetRoutedMs: leg.routedMs,
    requestResponse,
    requestResponseMs: leg.responseMs,
    contextResponses: leg.contextResponses,
    requestFailed: leg.failed,
  };
}

test.beforeAll(async () => {
  platform = await loopbackPlatform({ port: 46174, requirePairingCode: true, handle: platformHandle });
  expect(platform.origin).toBe(platformOrigin);
  second = await loopbackPlatform({
    handle: async (request, reply) => {
      secondServed.push(new URL(request.url!, "http://127.0.0.1").pathname);
      reply.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("synthetic probe target");
      return true;
    },
  });
  extension = await buildHarness("operation");
});
test.afterEach(async () => {
  accountMode = "serve";
  for (const context of contexts) await context.close().catch(() => undefined);
  contexts.clear();
});
test.afterAll(async () => {
  await platform?.close();
  await second?.close();
});

test.describe("connector routing facts with tracing off", () => {
  test.describe.configure({ timeout: 120_000 });

  // SYNTHETIC control, no browser and no receipt: the loopback signals first and the target is routed
  // 300 ms later, the order hosted run 39249159122 showed. The row must carry that request's own outcome.
  test("connector-routing-facts-probe AC1 synthetic late-route-after-loopback control", async () => {
    const lateRoute = (response: RoutedRequest["response"]) => {
      const leg = freshObservation();
      leg.clickedAt = performance.now();
      const request: RoutedRequest = {
        url: () => target,
        method: () => "GET",
        resourceType: () => "document",
        isNavigationRequest: () => true,
        serviceWorker: () => null,
        response,
      };
      setTimeout(() => observeRoute(leg, request), 300);
      return completeObservation(leg, () => true);
    };
    const [resolvedNull, rejected, unrouted] = await Promise.all([
      lateRoute(async () => null),
      lateRoute(() => Promise.reject(new Error("synthetic-dropped-socket"))),
      completeObservation(freshObservation(), () => true),
    ]);
    expect(resolvedNull).toMatchObject({
      routedCount: 1,
      requestResponse: { resolved: null },
      requestResponseMs: expect.any(Number),
    });
    expect(rejected).toMatchObject({ routedCount: 1, requestResponse: { rejected: "synthetic-dropped-socket" } });
    expect(unrouted).toMatchObject({ routedCount: 0, targetRoutedMs: null, requestResponse: "not-routed" });
  });

  test("connector-routing-facts-probe AC1 extension-opened tab response", async ({ trace }, testInfo) => {
    const rows: Row[] = [];
    try {
      const f = await launchCoordinator(extension);
      contexts.add(f.context);
      rows.push(environment(f.context, testInfo, trace, "AC1"));
      await pair(f.context, f.worker);
      const actionPage = f.context.pages().find((page) => page.url().startsWith("data:"))!;
      let observation = freshObservation();
      // Installed after paired-idle and before the second action, as #10109-AC1 names.
      await f.context.route(`${platformOrigin}/**`, async (route, request) => {
        const row = observeRoute(observation, request);
        const continued = await settle(() => route.continue());
        if ("rejected" in continued) row.continueRejected = continued.rejected;
      });
      f.context.on("response", (response) => {
        if (response.url().startsWith(`${platformOrigin}/account/channels`))
          observation.contextResponses.push({ path: locate(response.url()), status: response.status() });
      });
      f.context.on("requestfailed", (request) => {
        if (request.url().startsWith(`${platformOrigin}/account/channels`))
          observation.failed.push({ path: locate(request.url()), errorText: request.failure()?.errorText ?? null });
      });
      for (const leg of ["serve", "drop"] as const) {
        accountMode = leg;
        observation = freshObservation();
        const before = platformServed.length;
        const state = await title(f.worker);
        await actionPage.bringToFront();
        observation.clickedAt = performance.now();
        const click = await settle(() => triggerAction(f.context, actionPage.url()));
        const clickMs = Math.round(performance.now() - observation.clickedAt);
        rows.push({
          ac: "AC1",
          leg: leg === "serve" ? "second-action-served" : "second-action-dropped-socket-control",
          titleBeforeAction: state,
          click,
          clickMs,
          ...(await completeObservation(observation, () => platformServed.length > before)),
          loopbackServed: platformServed.slice(before),
          tabs: f.context.pages().map((page) => locate(page.url())),
          claims,
        });
      }
    } catch (error) {
      rows.push({ ac: "AC1", leg: "probe-aborted", error: message(error) });
      throw error;
    } finally {
      emit(testInfo, rows);
    }
  });

  test("connector-routing-facts-probe AC2 second-loopback let-through legs", async ({ trace }, testInfo) => {
    const rows: Row[] = [];
    try {
      const f = await launchCoordinator(extension);
      contexts.add(f.context);
      rows.push(environment(f.context, testInfo, trace, "AC2"));
      let action: "continue" | "abort" = "continue";
      const routed: Row[] = [];
      const failed: Row[] = [];
      // Installed before pairing, matching the drill's let-through seam moment.
      await f.context.route(`${second.origin}/**`, async (route, request) => {
        const applied = action;
        const row: Row = {
          path: new URL(request.url()).pathname,
          action: applied,
          navigation: request.isNavigationRequest(),
          resourceType: request.resourceType(),
        };
        routed.push(row);
        const settled = await settle(() => (applied === "abort" ? route.abort() : route.continue()));
        if ("rejected" in settled) row.routeRejected = settled.rejected;
      });
      f.context.on("requestfailed", (request) => {
        if (request.url().startsWith(second.origin))
          failed.push({
            path: new URL(request.url()).pathname,
            errorText: request.failure()?.errorText ?? null,
          });
      });
      const pairing = await settle(() => pair(f.context, f.worker));
      rows.push({ ac: "AC2", leg: "pairing-with-route-installed", pairing, title: await title(f.worker) });

      const instrument = "/probe/let-through/instrument";
      const direct = await settle(async () => (await fetch(`${second.origin}${instrument}`)).status);
      rows.push({ ac: "AC2", leg: "instrument-node-direct", outcome: direct, served: served(instrument) });
      expect(served(instrument)).toBe(1);

      const fetchFrom = async (origin: string | null, url: string, mode: RequestMode) => {
        const page = await f.context.newPage();
        try {
          const navigation = origin
            ? await settle(async () => (await page.goto(origin, { timeout: settleMs }))?.status() ?? null)
            : await settle(async () => {
                await page.goto("data:text/html,<title>SYNTHETIC let-through origin</title>");
                return "data:";
              });
          const fetched = await page.evaluate(
            async (input) => {
              try {
                const response = await fetch(input.url, {
                  mode: input.mode,
                  cache: "no-store",
                  signal: AbortSignal.timeout(8000),
                });
                return { type: response.type, status: response.status };
              } catch (error) {
                return { threw: String(error).split("\n")[0]!.slice(0, 240) };
              }
            },
            { url, mode },
          );
          return { initiator: origin ? locate(page.url()) : "data:", navigation, fetched };
        } finally {
          await page.close();
        }
      };
      const topLevel = async (url: string) => {
        const page = await f.context.newPage();
        try {
          return (await page.goto(url, { timeout: settleMs }))?.status() ?? null;
        } finally {
          await page.close();
        }
      };
      const legs: [string, "continue" | "abort", (url: string) => Promise<unknown>][] = [
        ["a-top-level-goto-continued", "continue", topLevel],
        ["a-top-level-goto-aborted-control", "abort", topLevel],
        [
          "b-first-loopback-page-no-cors-fetch-continued",
          "continue",
          (url) => fetchFrom(`${platformOrigin}/account/channels`, url, "no-cors"),
        ],
        ["c-data-page-fetch-continued-prior-control", "continue", (url) => fetchFrom(null, url, "cors")],
        ["c-data-page-no-cors-fetch-continued", "continue", (url) => fetchFrom(null, url, "no-cors")],
      ];
      for (const [leg, routeAction, run] of legs) {
        action = routeAction;
        const path = `/probe/let-through/${leg}`;
        const outcome = await settle(() => run(`${second.origin}${path}`));
        await observeUntil(() => served(path) > 0, 2000);
        rows.push({
          ac: "AC2",
          leg,
          routeAction,
          routed: routed.filter((row) => row.path === path),
          requestFailed: failed.filter((row) => row.path === path),
          secondLoopbackServed: served(path),
          outcome,
        });
      }
    } catch (error) {
      rows.push({ ac: "AC2", leg: "probe-aborted", error: message(error) });
      throw error;
    } finally {
      emit(testInfo, rows);
    }
  });

  test("connector-routing-facts-probe AC3 worker forwarding and manual redirect", async ({ trace }, testInfo) => {
    const rows: Row[] = [];
    try {
      const f = await launchCoordinator(extension);
      contexts.add(f.context);
      rows.push(environment(f.context, testInfo, trace, "AC3"));
      const pairing = await settle(() => pair(f.context, f.worker));
      rows.push({ ac: "AC3", leg: "pairing", pairing, title: await title(f.worker) });
      const url = `${platformOrigin}/probe/redirect`;

      let before = served(redirectTarget);
      const direct = await settle(() => manualRedirect(url));
      await quiet(500);
      rows.push({
        ac: "AC3",
        leg: "node-manual-redirect-direct",
        node: process.version,
        outcome: direct,
        targetServed: served(redirectTarget) - before,
      });

      before = served(redirectTarget);
      const unrouted = await settle(() => workerFetch(f.worker, url));
      await observeUntil(() => served(redirectTarget) > before, 3000);
      rows.push({
        ac: "AC3",
        leg: "worker-fetch-unrouted-control",
        outcome: unrouted,
        targetServed: served(redirectTarget) - before,
      });

      const routed: Row[] = [];
      await f.context.route(url, async (route, request) => {
        const row: Row = {
          navigation: request.isNavigationRequest(),
          serviceWorker: request.serviceWorker() !== null,
          resourceType: request.resourceType(),
        };
        routed.push(row);
        row.forwarded = await settle(() => manualRedirect(request.url()));
        row.abort = await settle(() => route.abort());
      });
      before = served(redirectTarget);
      const forwarded = await settle(() => workerFetch(f.worker, url));
      await observeUntil(() => routed.length > 0, 3000);
      await quiet(1000);
      rows.push({
        ac: "AC3",
        leg: "worker-fetch-routed-forwarded-then-aborted",
        node: process.version,
        reachedRoute: routed.length > 0,
        routed,
        outcome: forwarded,
        targetServed: served(redirectTarget) - before,
      });
    } catch (error) {
      rows.push({ ac: "AC3", leg: "probe-aborted", error: message(error) });
      throw error;
    } finally {
      emit(testInfo, rows);
    }
  });
});

// #10109-AC4 leg 2 never signs in, pairs or creates a pairing code; the context only loads the extension.
test("connector-routing-facts-probe AC4 leg 2 trace off", async ({ trace }, testInfo) => {
  const rows: Row[] = [];
  try {
    const installation = await launchInstallation(extension);
    contexts.add(installation.context);
    rows.push(environment(installation.context, testInfo, trace, "AC4"));
    const start = await settle(() => installation.context.tracing.start({ snapshots: false }));
    const stop = await settle(() => installation.context.tracing.stop());
    const close = await settle(() => installation.context.close());
    const reclose = "rejected" in close ? await settle(() => installation.context.close()) : null;
    rows.push({
      ac: "AC4",
      leg: "leg-2-trace-off",
      trace,
      tracingStart: start,
      pathlessTracingStop: stop,
      contextClose: close,
      contextReclose: reclose,
      outputDirectory: relative(testInfo.project.outputDir, testInfo.outputDir),
    });
  } catch (error) {
    rows.push({ ac: "AC4", leg: "probe-aborted", error: message(error) });
    throw error;
  } finally {
    emit(testInfo, rows);
  }
});

test.describe("connector routing facts retained output", () => {
  test("connector-routing-facts-probe AC4 output listing and forbidden scan", async ({}, testInfo) => {
    const rows: Row[] = [];
    try {
      const markers = forbidden();
      const control = mkdtempSync(join(tmpdir(), "connector-10109-scan-control-"));
      try {
        writeFileSync(join(control, "planted.txt"), `planted ${markers[1]}`);
        expect(() => scanRetainedArtifacts(control, markers)).toThrow("connector-retained-artifact-secret");
      } finally {
        rmSync(control, { recursive: true, force: true });
      }
      expect(() => valueFree({ ac: "AC4", leg: "receipt-guard-control", planted: planted.value })).toThrow(
        "connector-probe-receipt-secret",
      );
      rows.push({ ac: "AC4", leg: "scan-and-receipt-guard-controls", plantedRefused: true, receiptGuardRefused: true });

      const root = testInfo.project.outputDir;
      testInfo.outputPath();
      const directories = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(ownOutput))
        .map((entry) => entry.name)
        .sort();
      expect(directories).toContain(relative(root, testInfo.outputDir));
      for (const directory of directories) {
        const files: Row[] = [];
        const walk = (path: string) => {
          for (const entry of readdirSync(path, { withFileTypes: true })) {
            const child = join(path, entry.name);
            if (entry.isDirectory()) walk(child);
            else files.push({ file: relative(join(root, directory), child), bytes: statSync(child).size });
          }
        };
        walk(join(root, directory));
        rows.push({ ac: "AC4", leg: "output-directory-listing", directory, files });
      }
      // Both trace legs must have run before this listing, or their output went unscanned.
      const traceLegs = directories.flatMap((directory) => {
        const receipt = join(root, directory, "receipt.jsonl");
        if (!existsSync(receipt)) return [];
        return readFileSync(receipt, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Row)
          .filter((row) => row.ac === "AC4" && String(row.leg).startsWith("leg-"))
          .map((row) => String(row.leg));
      });
      rows.push({ ac: "AC4", leg: "trace-legs-listed", traceLegs });
      expect(traceLegs.sort()).toEqual(["leg-1-shipped-trace", "leg-2-trace-off"]);
      const scans = directories.map((directory) => ({
        directory,
        scan: (() => {
          try {
            return { inspected: scanRetainedArtifacts(join(root, directory), markers) };
          } catch (error) {
            return { refused: message(error) };
          }
        })(),
      }));
      rows.push({
        ac: "AC4",
        leg: "forbidden-scan",
        markers: markers.length,
        verifierIncluded: platform.forbidden().length > 6,
        scans,
      });
      expect(scans.every(({ scan }) => "inspected" in scan)).toBe(true);
    } catch (error) {
      rows.push({ ac: "AC4", leg: "probe-aborted", error: message(error) });
      throw error;
    } finally {
      emit(testInfo, rows);
    }
  });
});
