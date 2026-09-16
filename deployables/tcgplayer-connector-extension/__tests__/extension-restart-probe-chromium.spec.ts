import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { candidateOptions, buildFixture, type FixtureOptions } from "./support/build-fixture";
import { fixtureWorker, launchFixture, observeUntil, observer, snapshot } from "./support/browser-observation";
import { holdOrigin, startHoldServer } from "./support/hold-server";
import { mechanismNames, parseProbeRecord, type Mechanism, type MechanismName } from "./support/probe-record";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../../../artifacts/7938", new Date().toISOString().replaceAll(/[:.]/g, "-"));
const observations: CaseObservation[] = [];
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
type CaseObservation = {
  name: string;
  chromiumVersion: string;
  mechanism: Mechanism;
  before: Snapshot;
  after: Snapshot | null;
  final: Snapshot | null;
  workerClosed: boolean;
  pendingTransactionAtIntervention: boolean;
  intervenedAt: string;
  attachmentError: string | null;
  requests: Awaited<ReturnType<typeof startHoldServer>>["requests"];
};

function save(name: string, value: unknown) {
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, name), `${JSON.stringify(value, null, 2)}\n`);
}

test("restart-probe rejects a busy fixed port and non-loopback builds without output", async () => {
  const server = await startHoldServer();
  try {
    await expect(startHoldServer()).rejects.toMatchObject({ code: "EADDRINUSE" });
    for (const host of [
      "https://www.tcgplayer.com",
      "http://localhost:46173",
      "http://127.0.0.1:46174",
      "http://127.0.0.1:46173.evil.invalid",
      "http://192.0.2.1:46173",
    ]) {
      for (const surface of ["registry", "permissions"] as const) {
        const destination = resolve(root, `rejected-${surface}`);
        const options = { ...candidateOptions, [surface]: [surface === "permissions" ? `${host}/*` : host] };
        expect(() => buildFixture(destination, options, holdOrigin)).toThrow();
        expect(existsSync(destination)).toBe(false);
      }
    }
    expect(server.requests).toHaveLength(0);
    save("origin-build-controls.json", {
      occupiedPort: "EADDRINUSE",
      plantedOrigins: "rejected-before-build",
      requests: 0,
    });
  } finally {
    await server.close();
  }
});

const cases: { name: string; mechanism: MechanismName; options: FixtureOptions; refused?: boolean }[] = [
  ...mechanismNames.map((mechanism) => ({ name: mechanism, mechanism, options: candidateOptions })),
  { name: "ordering-mutant", mechanism: "context.close", options: { ...candidateOptions, orderingMutant: true } },
  {
    name: "delete-database-mutant",
    mechanism: "context.close",
    options: { ...candidateOptions, deleteOnStartup: true },
  },
  {
    name: "permission-removed",
    mechanism: "context.close",
    options: { ...candidateOptions, permissions: [] },
    refused: true,
  },
  {
    name: "registry-removed",
    mechanism: "context.close",
    options: { ...candidateOptions, registry: [] },
    refused: true,
  },
];

for (const scenario of cases) {
  test.describe.serial(`extension-restart-probe-chromium ${scenario.name}`, () => {
    let server: Awaited<ReturnType<typeof startHoldServer>>;
    let context: BrowserContext;
    let worker: Worker;
    let page: Page;
    let extensionId: string;
    let result: CaseObservation;
    let closed = false;
    const directory = resolve(root, scenario.name);
    const extensionRoot = resolve(directory, "extension");
    const profile = resolve(directory, "profile");

    test.afterAll(async () => {
      if (context) {
        await context.close();
      }
      if (server) await server.close();
    });

    test("bind, build, launch fresh profile and request the 30 second alarm", async () => {
      server = await startHoldServer();
      buildFixture(extensionRoot, scenario.options, holdOrigin);
      context = await launchFixture(extensionRoot, profile);
      worker = await fixtureWorker(context);
      worker.on("close", () => {
        closed = true;
      });
      extensionId = new URL(worker.url()).host;
      page = await observer(context, extensionId);
      await worker.evaluate(() => globalThis.restartProbe.prepare());
      expect((await snapshot(page)).records).toEqual([]);
    });

    // Separate fixed windows keep the package's unchanged 30s per-test timeout.
    test("observe the first 20 seconds of the initial alarm window", async () => {
      await observeUntil(() => server.requests.length > 0, 20_000);
    });

    test("capture the initial alarm and exact dispatch boundary", async () => {
      await observeUntil(async () => (await snapshot(page)).fires.length > 0, 20_000);
      const before = await snapshot(page);
      expect(before.fires).toHaveLength(1);
      if (scenario.refused) {
        await expect.poll(() => worker.evaluate(() => globalThis.restartProbe.state.refusal)).not.toBeNull();
        expect(server.requests).toHaveLength(0);
        save(`${scenario.name}.json`, {
          requests: 0,
          refusal: await worker.evaluate(() => globalThis.restartProbe.state.refusal),
        });
        return;
      }
      await expect.poll(() => server.active).toBe(1);
      expect(server.requests).toHaveLength(1);
      expect(before.records).toEqual(
        scenario.options.orderingMutant ? [] : [{ id: "op-1", state: "dispatched", at: before.fires[0] }],
      );
      expect(before.localCanary).toBe("SYNTHETIC_LOCAL_CANARY");
      expect(before.sessionCanary).toBe("SYNTHETIC_SESSION_CANARY");
      result = {
        name: scenario.name,
        chromiumVersion: context.browser()!.version(),
        mechanism: {
          name: scenario.mechanism,
          available: false,
          terminatedMidFetch: false,
          pendingTransactionAtomic: false,
          refetchOnlyAfterAlarm: false,
          indexedDbSurvived: false,
        },
        before,
        after: null,
        final: null,
        workerClosed: false,
        pendingTransactionAtIntervention: false,
        intervenedAt: "",
        attachmentError: null,
        requests: server.requests,
      };
      await worker.evaluate(() => globalThis.restartProbe.startTwo());
      await expect.poll(() => worker.evaluate(() => globalThis.restartProbe.state.pendingTransaction)).toBe(true);
      result.pendingTransactionAtIntervention = await worker.evaluate(
        () => globalThis.restartProbe.state.pendingTransaction,
      );
      expect(await worker.evaluate(() => globalThis.restartProbe.state.pendingFetch)).toBe(true);
      result.intervenedAt = new Date().toISOString();
      if (scenario.mechanism === "context.close") {
        expect(await worker.evaluate(() => globalThis.restartProbe.state.pendingTransaction)).toBe(true);
        result.intervenedAt = new Date().toISOString();
        // Playwright retains this boundary's trace chunk before closing the context.
        await context.close();
        result.mechanism.available = true;
        result.workerClosed = closed;
        result.mechanism.terminatedMidFetch = closed && server.requests.length === 1 && server.active === 0;
        context = await launchFixture(extensionRoot, profile);
      } else if (scenario.mechanism === "runtime.reload") {
        const reload = worker
          .evaluate(() => chrome.runtime.reload())
          .then(
            () => "returned",
            (error: Error) => error.message,
          );
        await observeUntil(() => closed, 3_000);
        result.attachmentError = await Promise.race([reload, Promise.resolve("reload evaluation detached or pending")]);
        result.mechanism.available = true;
        result.workerClosed = closed;
        result.mechanism.terminatedMidFetch = closed && server.requests.length === 1 && server.active === 0;
        if (closed) await fixtureWorker(context);
      } else {
        try {
          // Observe this exact worker attachment, not a page session substituted from documentation.
          // @ts-expect-error Playwright types do not promise Worker attachment; Chromium/runtime is the probe authority.
          const session = await context.newCDPSession(worker);
          try {
            if (scenario.mechanism === "ServiceWorker.stopWorker") {
              const versions: { versionId: string; scriptURL: string }[] = [];
              session.on("ServiceWorker.workerVersionUpdated", (event) => versions.push(...event.versions));
              await session.send("ServiceWorker.enable");
              await observeUntil(() => versions.some((version) => version.scriptURL === worker.url()), 2_000);
              const version = versions.find((version) => version.scriptURL === worker.url());
              if (!version) throw new Error("No worker version exposed by attached session");
              await session.send("ServiceWorker.stopWorker", { versionId: version.versionId });
            } else await session.send("ServiceWorker.stopAllWorkers");
            result.mechanism.available = true;
            await observeUntil(() => closed, 3_000);
            result.workerClosed = closed;
            result.mechanism.terminatedMidFetch = closed && server.requests.length === 1 && server.active === 0;
          } finally {
            await session.detach();
          }
        } catch (error) {
          result.attachmentError = error instanceof Error ? error.message : String(error);
        }
      }
      if (result.mechanism.available) {
        page = await observer(context, extensionId);
        result.after = await snapshot(page);
        const records = result.after.records;
        const both =
          records.length === 2 &&
          records.every((record) => record.state === "two-record" && record.at === "SYNTHETIC_ATOMIC_CANARY");
        const neither = JSON.stringify(records) === JSON.stringify(before.records);
        result.mechanism.pendingTransactionAtomic = result.pendingTransactionAtIntervention && (both || neither);
        result.mechanism.indexedDbSurvived = before.records.length > 0 && (both || neither);
        result.mechanism.terminatedMidFetch &&= !records.some((record) => record.state === "receipt-captured");
      }
      save(`${scenario.name}-boundary.json`, result);
    });

    test("observe the first 20 seconds of the refire window", async () => {
      if (!result?.mechanism.available) return;
      await observeUntil(() => server.requests.length >= 2, 20_000);
    });

    test("record post-restart refire, atomicity, persistence and storage", async () => {
      if (!result) return;
      if (result.mechanism.available) {
        await observeUntil(() => server.requests.length >= 2, 20_000);
        result.final = await snapshot(page);
        result.mechanism.refetchOnlyAfterAlarm =
          server.requests.length === 2 &&
          result.final.fires.length === 2 &&
          Date.parse(result.final.fires[1]!) <= Date.parse(server.requests[1]!.at) &&
          Date.parse(result.final.fires[1]!) >= Date.parse(result.intervenedAt);
        expect(server.requests.length).toBeLessThanOrEqual(2);
        expect(result.final.records.length).toBeLessThanOrEqual(2);
        expect(result.final.records.some((record) => record.state === "receipt-captured")).toBe(false);
      }
      expect(server.violations).toEqual([]);
      expect(server.requests.every((request) => !request.released)).toBe(true);
      observations.push(result);
      save(`${scenario.name}.json`, result);
    });
  });
}

test("publish the closed observed record and discriminating controls", async () => {
  const baseline = observations.find((entry) => entry.name === "context.close")!;
  const ordering = observations.find((entry) => entry.name === "ordering-mutant")!;
  const deleted = observations.find((entry) => entry.name === "delete-database-mutant")!;
  expect(observations).toHaveLength(6);
  expect(ordering.before.records).toEqual([]);
  expect(ordering.after?.records).toEqual([]);
  expect(ordering.mechanism.terminatedMidFetch).toBe(baseline.mechanism.terminatedMidFetch);
  expect(deleted.mechanism.indexedDbSurvived).toBe(false);
  expect(deleted.after?.records).toEqual([]);
  const record = parseProbeRecord({
    schemaVersion: 1,
    chromiumVersion: baseline.chromiumVersion,
    playwrightVersion: JSON.parse(readFileSync(require.resolve("@playwright/test/package.json"), "utf8")).version,
    capturedAt: new Date().toISOString(),
    mechanisms: mechanismNames.map((name) => observations.find((entry) => entry.name === name)!.mechanism),
    alarm: {
      requestedPeriodSeconds: 30,
      observedFirstFireMs: Date.parse(baseline.before.fires[0]!) - baseline.before.scheduledAt,
      refiredAfterRelaunch: baseline.mechanism.refetchOnlyAfterAlarm,
    },
    storage: {
      localSurvived: baseline.after?.localCanary === baseline.before.localCanary,
      sessionSurvived: baseline.after?.sessionCanary === baseline.before.sessionCanary,
    },
  });
  save("extension-restart-probe-chromium.json", record);
  const selected = record.mechanisms.find(
    (row) =>
      row.available &&
      row.terminatedMidFetch &&
      row.pendingTransactionAtomic &&
      row.refetchOnlyAfterAlarm &&
      row.indexedDbSurvived,
  );
  save("decision.json", {
    downstream: selected ? "observed mechanism candidate; independent review required" : "H1 not ready",
    selectedMechanism: selected?.name ?? null,
    orderingDiscriminates: baseline.before.records.length === 1 && ordering.after?.records.length === 0,
    deleteDatabaseDiscriminates: baseline.mechanism.indexedDbSurvived && !deleted.mechanism.indexedDbSurvived,
  });
  console.log(`Restart probe record: ${resolve(root, "extension-restart-probe-chromium.json")}`);
});
