import { expect, test, type BrowserContext } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";
import { exportSentinel, startLoopback } from "../__tests__/harness/loopback";
import { syntheticLiveExportClaim } from "../__tests__/harness/claim";
import { platformOrigin, portalOrigin } from "../__tests__/harness/origins";
import { buildHarness, launchCoordinator, pair, proofRoot, retain, snapshot, wake } from "./coordinator-observation";
import { clockAt } from "./retention-observation";

test.use({ trace: "off", screenshot: "off" });
let server: Awaited<ReturnType<typeof startLoopback>>;
const bundles = new Map<string, string>();
const active = new Set<BrowserContext>();
const started = Date.now();
// Build-time mutant: the registered executor stays, but its capability never reaches the claim body.
const capabilityOmitted: Plugin = {
  name: "synthetic-live-export-capability-omitted",
  enforce: "pre",
  transform(source, id) {
    if (!id.replaceAll("\\", "/").endsWith("/connector-client/domain/operation-coordinator.ts")) return null;
    const anchor = 'request(input, "claim", capabilities.length ? { capabilities } : {})';
    if (source.split(anchor).length !== 2) throw new Error("capability-mutant-anchor-moved");
    return source.replace(anchor, 'request(input, "claim", {})');
  },
};
// Build-time mutant: reconciliation treats readable retained raw as unreadable, so a lost admission is never replayed.
const replayDisabled: Plugin = {
  name: "synthetic-live-export-replay-disabled",
  enforce: "pre",
  transform(source, id) {
    if (!id.replaceAll("\\", "/").endsWith("/connector-client/domain/tcgplayer-live-export-executor.ts")) return null;
    const anchor =
      "return admit(attempt, handoff, plaintext, AbortSignal.timeout(attempt.payload.bounds.budgetMs), execution);";
    if (source.split(anchor).length !== 2) throw new Error("replay-mutant-anchor-moved");
    return source.replace(anchor, 'plaintext.fill(0); return retire(attempt, handoff, "raw-unreadable");');
  },
};

/** Files under a root that contain the plaintext sentinel; locked files are reported, never skipped silently. */
function sentinelFiles(root: string, since = 0): string[] {
  if (!existsSync(root)) return [];
  const needle = Buffer.from(exportSentinel);
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sentinelFiles(path, since);
    if (!entry.isFile() || statSync(path).mtimeMs < since) return [];
    try {
      return readFileSync(path).includes(needle) ? [path] : [];
    } catch (error) {
      return [`unreadable:${path}:${String(error)}`];
    }
  });
}

test.beforeAll(async () => {
  server = await startLoopback();
  bundles.set("live-export", await buildHarness("live-export"));
  bundles.set(
    "capability-omitted",
    await buildHarness("live-export", false, false, { label: "capability-omitted", plugins: [capabilityOmitted] }),
  );
  bundles.set(
    "replay-disabled",
    await buildHarness("live-export", false, false, { label: "replay-disabled", plugins: [replayDisabled] }),
  );
  bundles.set("unregistered", await buildHarness("operation"));
});
test.beforeEach(() => server.reset());
test.afterEach(async () => {
  for (const context of active) await context.close();
  active.clear();
});
test.afterAll(async () => {
  for (const context of active) await context.close();
  await server?.close();
});

async function launch(bundle: string) {
  const f = await launchCoordinator(bundles.get(bundle)!);
  active.add(f.context);
  await pair(f.context, f.worker);
  return f;
}

test("tcgplayer-live-export-loopback-production-path-chromium @tcgplayer-connector-extension-authority", async () => {
  const f = await launch("live-export");
  // The provider fake answers only a credentialed worker request; the cookie is a labelled synthetic marker.
  server.provider.session = "synthetic_provider_session=present";
  await f.context.addCookies([{ name: "synthetic_provider_session", value: "present", url: portalOrigin }]);
  server.claims.push(syntheticLiveExportClaim());
  await wake(f.worker);
  await expect.poll(async () => (await snapshot(f.worker)).reservations[0]?.phase, { timeout: 60_000 }).toBe("acked");
  const evidence = await snapshot(f.worker);
  expect(server.claimBodies).toContainEqual({ capabilities: ["tcgplayer-live-export"] });
  expect(server.provider).toMatchObject({ exports: 1, signins: 0 });
  expect(server.ingests).toHaveLength(1);
  expect(server.report().outcomes[0]?.outcome).toMatchObject({ kind: "live-export-complete", parsedRowCount: 3 });
  expect(evidence.rawExports).toEqual([]);
  expect(JSON.stringify(evidence.members)).not.toContain(exportSentinel);
  const manifest = JSON.parse(readFileSync(join(f.directory, "manifest.json"), "utf8"));
  expect(manifest.permissions).toEqual(["identity", "storage", "alarms"]);
  expect(manifest.host_permissions).toEqual([`${platformOrigin}/*`, `${portalOrigin}/*`]);
  retain("tcgplayer-live-export-loopback-production-path-chromium", {
    evidence,
    provider: { exports: server.provider.exports, signins: server.provider.signins },
    ingests: server.ingests.length,
  });
  await f.context.close();
  active.delete(f.context);
  // Custody: no plaintext sentinel in the profile, Downloads or retained artifacts once the worker is gone.
  const found = [
    ...sentinelFiles(f.profile),
    ...sentinelFiles(join(homedir(), "Downloads"), started),
    ...sentinelFiles(proofRoot, started),
  ];
  retain("tcgplayer-live-export-retention-scan", { roots: [f.profile, "~/Downloads", proofRoot], found });
  expect(found).toEqual([]);
});

test("tcgplayer-live-export-capability-omitted-chromium gets no member and no post @tcgplayer-connector-extension-authority", async () => {
  for (const bundle of ["capability-omitted", "unregistered"] as const) {
    server.reset();
    const f = await launch(bundle);
    server.claims.push(syntheticLiveExportClaim());
    await wake(f.worker);
    await expect.poll(() => server.withheld(), { timeout: 60_000 }).toBeGreaterThan(0);
    expect(server.claimBodies.every((body) => JSON.stringify(body) === "{}")).toBe(true);
    expect(server.provider.exports).toBe(0);
    expect(server.ingests).toEqual([]);
    expect(server.reports).toEqual([]);
    expect(() => expect(server.ingests).toHaveLength(1)).toThrow();
    await f.context.close();
    active.delete(f.context);
  }
});

const deadlineAlarm = "connector-retention-deadline";
type Write = Readonly<{ rawExportId: string; downloadedAt: string; expiresAt: string }>;

/** Two real live-export writes whose non-202 admissions keep each sealed record under its own deadline. */
async function twoWriters() {
  const f = await launch("live-export");
  server.setIngestStatus(503);
  for (const scheduleGeneration of [1, 2]) {
    server.claims.push(syntheticLiveExportClaim(Date.now(), { scheduleGeneration }));
    await wake(f.worker);
    await expect
      .poll(async () => (await snapshot(f.worker)).rawExports.length, { timeout: 20_000 })
      .toBe(scheduleGeneration);
    // Each ambiguous admission is reported and acked before anything moves the clock.
    await expect
      .poll(async () => (await snapshot(f.worker)).reservations.map(({ phase }) => phase), { timeout: 20_000 })
      .toEqual(Array.from({ length: scheduleGeneration }, () => "acked"));
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  const evidence = await snapshot(f.worker);
  const writes: Write[] = evidence.rawExports
    .map((row) => ({
      rawExportId: String(row.rawExportId),
      downloadedAt: String(row.downloadedAt),
      expiresAt: String(row.expiresAt),
    }))
    .sort((a, b) => Date.parse(a.downloadedAt) - Date.parse(b.downloadedAt));
  expect(new Set(writes.map((write) => write.expiresAt)).size).toBe(2);
  // The 24-hour product rule is observed, never shortened: synthetic time below only moves the clock to it.
  for (const write of writes) expect(Date.parse(write.expiresAt) - Date.parse(write.downloadedAt)).toBe(86_400_000);
  expect(JSON.stringify(evidence.rawExports)).not.toContain(exportSentinel);
  const scheduled = await f.worker.evaluate((name) => chrome.alarms.get(name), deadlineAlarm);
  // Isolate the retention callback: no periodic work sweep may run while the application clock is moved.
  await f.worker.evaluate(() => chrome.alarms.clear("connector-work"));
  return { f, writes, scheduled, outcomes: server.reports.map((report) => JSON.parse(report).outcomes[0].outcome) };
}

/**
 * Explicitly synthetic deadline fixture: move only the worker's application clock to the deadline Chrome holds,
 * then either re-arm that same native alarm a few real seconds out ("fire") or clear it ("cleared" control),
 * and observe every alarm callback until a separate window alarm. Writes, lifetimes and scheduling are the product's.
 */
async function deadlineWindow(f: Awaited<ReturnType<typeof launch>>, mode: "fire" | "cleared") {
  const scheduledBefore = (await f.worker.evaluate((name) => chrome.alarms.get(name), deadlineAlarm))?.scheduledTime;
  if (scheduledBefore === undefined) throw new Error("synthetic-deadline-missing");
  await clockAt(f.worker, scheduledBefore);
  const callbackAt = Date.now() + 3000;
  const windowEnd = callbackAt + 3000;
  const observed = await f.worker.evaluate(
    async ({ name, callbackAt, windowEnd, clear }) => {
      const windowName = "synthetic-9288-deadline-window";
      const names: string[] = [];
      const window = new Promise<void>((resolve) => {
        const listener = (alarm: chrome.alarms.Alarm) => {
          names.push(alarm.name);
          if (alarm.name === windowName) {
            chrome.alarms.onAlarm.removeListener(listener);
            resolve();
          }
        };
        chrome.alarms.onAlarm.addListener(listener);
      });
      if (clear) await chrome.alarms.clear(name);
      else await chrome.alarms.create(name, { when: callbackAt });
      await chrome.alarms.create(windowName, { when: windowEnd });
      await window;
      return { names, deadlineCallbacks: names.filter((fired) => fired === name).length };
    },
    { name: deadlineAlarm, callbackAt, windowEnd, clear: mode === "cleared" },
  );
  return { mode, applicationClock: scheduledBefore, callbackAt, windowEnd, ...observed };
}
async function retained(f: Awaited<ReturnType<typeof launch>>) {
  const evidence = await snapshot(f.worker);
  return {
    remaining: evidence.rawExports.map((row) => String(row.rawExportId)).sort(),
    alarmAfter: (await f.worker.evaluate((name) => chrome.alarms.get(name), deadlineAlarm))?.scheduledTime ?? null,
  };
}
/** The earliest deadline fires once and removes only the first record; the second keeps its own deadline. */
function earliestOnly(
  step: Awaited<ReturnType<typeof deadlineWindow>> & Awaited<ReturnType<typeof retained>>,
  writes: readonly Write[],
) {
  expect(step.remaining).toEqual([writes[1]!.rawExportId]);
  expect(step.deadlineCallbacks).toBe(1);
  expect(step.alarmAfter).toBe(Date.parse(writes[1]!.expiresAt));
  expect(step.applicationClock).toBe(Date.parse(writes[0]!.expiresAt));
  expect(step.names.filter((name) => name === "connector-work")).toEqual([]);
}

test("extension-raw-file-retention-chromium live-export two-writer deadline fires at the earliest @tcgplayer-connector-extension-authority", async () => {
  const { f, writes, scheduled, outcomes } = await twoWriters();
  expect(scheduled?.scheduledTime).toBe(Date.parse(writes[0]!.expiresAt));
  const first = await deadlineWindow(f, "fire");
  await expect.poll(async () => (await retained(f)).remaining, { timeout: 10_000 }).toEqual([writes[1]!.rawExportId]);
  const afterFirst = { ...first, ...(await retained(f)) };
  earliestOnly(afterFirst, writes);
  // The preserved record leaves only at its own deadline, and the deadline alarm is then cleared.
  const second = await deadlineWindow(f, "fire");
  await expect.poll(async () => (await retained(f)).remaining, { timeout: 10_000 }).toEqual([]);
  const afterSecond = { ...second, ...(await retained(f)) };
  expect(afterSecond).toMatchObject({
    applicationClock: Date.parse(writes[1]!.expiresAt),
    deadlineCallbacks: 1,
    remaining: [],
    alarmAfter: null,
  });
  retain("extension-raw-file-retention-chromium-live-export-two-writer", {
    chromiumVersion: f.context.browser()?.version() ?? null,
    userAgent: await f.worker.evaluate(() => navigator.userAgent),
    sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    writes,
    alarm: scheduled,
    outcomes,
    synthetic: "application clock moved to each held deadline; that native alarm re-armed 3 s out; 24 h rule unchanged",
    firings: [afterFirst, afterSecond],
  });
});

for (const control of ["earliest-alarm-cleared", "wrong-deadline"] as const)
  test(`extension-raw-file-retention-chromium live-export two-writer ${control} control fails the earliest witness @tcgplayer-connector-extension-authority`, async () => {
    const { f, writes } = await twoWriters();
    // Only the one named input varies: the held deadline is cleared, or a writer scheduled the later deadline.
    if (control === "wrong-deadline")
      await f.worker.evaluate(({ name, when }) => chrome.alarms.create(name, { when }), {
        name: deadlineAlarm,
        when: Date.parse(writes[1]!.expiresAt),
      });
    const step = await deadlineWindow(f, control === "earliest-alarm-cleared" ? "cleared" : "fire");
    if (control === "wrong-deadline")
      await expect.poll(async () => (await retained(f)).remaining, { timeout: 10_000 }).toEqual([]);
    const observed = { ...step, ...(await retained(f)) };
    retain(`extension-raw-file-retention-chromium-live-export-two-writer-${control}`, { writes, observed });
    expect(() => earliestOnly(observed, writes)).toThrow();
  });

for (const bundle of ["live-export", "replay-disabled"] as const)
  test(`tcgplayer-live-export-lost-202-restarted-worker-chromium ${bundle} @tcgplayer-connector-extension-authority`, async () => {
    const f = await launch(bundle);
    const cdp = await f.context.newCDPSession(f.context.pages()[0]!);
    let versionId: string | undefined;
    let runningStatus: string | undefined;
    cdp.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
      const version = versions.find((candidate) => candidate.scriptURL === f.worker.url());
      if (version) {
        versionId = version.versionId;
        runningStatus = version.runningStatus;
      }
    });
    await cdp.send("ServiceWorker.enable");
    await expect.poll(() => versionId).toBeTruthy();
    // The platform records the post but the worker never observes its 202.
    server.loseNextIngest();
    server.claims.push(syntheticLiveExportClaim());
    await wake(f.worker);
    await expect.poll(() => server.ingests.length, { timeout: 20_000 }).toBe(1);
    const lost = await snapshot(f.worker);
    expect(lost.members[0]).toMatchObject({
      state: "dispatched",
      handoff: { post: { state: "dispatched", parsedRowCount: 3 } },
    });
    expect(lost.rawExports).toHaveLength(1);
    await f.worker.evaluate(() => {
      Object.defineProperty(globalThis, "__liveExportWorkerLifetime", { value: "SYNTHETIC_9288_WORKER_LIFETIME" });
    });
    // The admitted worker-only restart: session keys survive, the execution context does not.
    await f.worker.evaluate(() => chrome.alarms.create("synthetic-9288-restart-wake", { delayInMinutes: 0.05 }));
    await cdp.send("ServiceWorker.stopWorker", { versionId: versionId! });
    await expect.poll(() => runningStatus).toBe("stopped");
    server.dropLostIngests();
    await expect.poll(() => runningStatus, { timeout: 20_000 }).toBe("running");
    expect(await f.worker.evaluate(() => Reflect.get(globalThis, "__liveExportWorkerLifetime"))).toBeUndefined();
    await expect.poll(async () => (await snapshot(f.worker)).reservations[0]?.phase, { timeout: 20_000 }).toBe("acked");
    const replayed = await snapshot(f.worker);
    const counters = () => ({
      exports: server.provider.exports,
      ingests: server.ingests.length,
      reports: server.reports.length,
    });
    const witness = () => {
      expect(counters()).toEqual({ exports: 1, ingests: 2, reports: 1 });
      expect(server.ingests[1]).toBe(server.ingests[0]);
      expect(server.report().outcomes[0]?.outcome).toMatchObject({ kind: "live-export-complete", parsedRowCount: 3 });
      expect(replayed.rawExports).toEqual([]);
    };
    const evidence = {
      bundle,
      chromiumVersion: f.context.browser()?.version() ?? null,
      lost: { member: lost.members[0], rawExports: lost.rawExports.length },
      replayed: { members: replayed.members, rawExports: replayed.rawExports.length },
      counters: counters(),
      identicalRepost: server.ingests.length === 2 && server.ingests[1] === server.ingests[0],
      outcome: server.report().outcomes[0]?.outcome,
    };
    if (bundle === "replay-disabled") {
      retain("tcgplayer-live-export-lost-202-restarted-worker-chromium-replay-disabled", evidence);
      expect(counters()).toEqual({ exports: 1, ingests: 1, reports: 1 });
      expect(witness).toThrow();
      return;
    }
    witness();
    // A subsequent wake is inert for this exportId. Pending reservations are processed before any claim,
    // so the claim's arrival bounds every effect that wake could have had.
    const claims = server.claimCount();
    await wake(f.worker);
    await expect.poll(() => server.claimCount(), { timeout: 20_000 }).toBeGreaterThan(claims);
    expect(counters()).toEqual({ exports: 1, ingests: 2, reports: 1 });
    expect((await snapshot(f.worker)).rawExports).toEqual([]);
    retain("tcgplayer-live-export-lost-202-restarted-worker-chromium", { ...evidence, afterWake: counters() });
  });
