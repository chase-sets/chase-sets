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

test("extension-raw-file-retention-chromium live-export two-writer deadline schedule @tcgplayer-connector-extension-authority", async () => {
  const f = await launch("live-export");
  // A non-202 admission keeps each sealed raw record retained under its own deadline.
  server.setIngestStatus(503);
  for (const scheduleGeneration of [1, 2]) {
    server.claims.push(syntheticLiveExportClaim(Date.now(), { scheduleGeneration }));
    await wake(f.worker);
    await expect
      .poll(async () => (await snapshot(f.worker)).rawExports.length, { timeout: 60_000 })
      .toBe(scheduleGeneration);
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  const evidence = await snapshot(f.worker);
  const writes = evidence.rawExports
    .map((row) => ({ downloadedAt: String(row.downloadedAt), expiresAt: String(row.expiresAt) }))
    .sort((a, b) => Date.parse(a.downloadedAt) - Date.parse(b.downloadedAt));
  expect(new Set(writes.map((write) => write.expiresAt)).size).toBe(2);
  expect(JSON.stringify(evidence.rawExports)).not.toContain(exportSentinel);
  const deadline = await f.worker.evaluate(() => chrome.alarms.get("connector-retention-deadline"));
  expect(deadline?.scheduledTime).toBe(Date.parse(writes[0]!.expiresAt));
  retain("extension-raw-file-retention-chromium-live-export-two-writer", {
    chromiumVersion: f.context.browser()?.version() ?? null,
    userAgent: await f.worker.evaluate(() => navigator.userAgent),
    sourceSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    writes,
    alarm: deadline,
    outcomes: server.reports.map((report) => JSON.parse(report).outcomes[0].outcome),
  });
});
