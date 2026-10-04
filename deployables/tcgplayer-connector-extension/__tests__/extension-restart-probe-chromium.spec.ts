import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { platform, release } from "node:os";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { candidateOptions, buildFixture, type FixtureOptions } from "./support/build-fixture";
import {
  alarmSnapshot,
  fixtureWorker,
  launchFixture,
  observeUntil,
  observer,
  settledStartup,
  snapshot,
} from "./support/browser-observation";
import { holdOrigin, startHoldServer } from "./support/hold-server";
import {
  mechanismFacts,
  mechanismNames,
  mechanismRoutes,
  parseProbeRecord,
  selectMechanism,
  type Mechanism,
  type MechanismName,
  type ObservationReason,
} from "./support/probe-record";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../../../artifacts/8589", new Date().toISOString().replaceAll(/[:.]/g, "-"));
const playwrightVersion: string = JSON.parse(
  readFileSync(require.resolve("@playwright/test/package.json"), "utf8"),
).version;
const observations: CaseObservation[] = [];
type Snapshot = Awaited<ReturnType<typeof snapshot>>;
type CaseObservation = {
  name: string;
  chromiumVersion: string;
  mechanism: Mechanism;
  before: Snapshot;
  initial: Awaited<ReturnType<typeof globalThis.restartProbe.prepare>>;
  observedFirstFireMs: number;
  preCloseAlarms: Awaited<ReturnType<typeof alarmSnapshot>> | null;
  postRelaunchAlarms: Awaited<ReturnType<typeof alarmSnapshot>> | null;
  startup: Awaited<ReturnType<typeof settledStartup>> | null;
  after: Snapshot | null;
  final: Snapshot | null;
  workerClosed: boolean;
  pendingTransactionAtIntervention: boolean;
  intervenedAt: string;
  attachmentError: string | null;
  unobservedReason: ObservationReason | null;
  refireWindow: { startedAt: string; endedAt: string; elapsedMs: number; requiredMs: number; message: string } | null;
  requests: Awaited<ReturnType<typeof startHoldServer>>["requests"];
};

function save(name: string, value: unknown) {
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function publishPayloads() {
  const packageRequire = createRequire(require.resolve("@playwright/test/package.json"));
  const coreRequire = createRequire(packageRequire.resolve("playwright/package.json"));
  const {
    utils: { ZipFile },
  } = coreRequire("playwright-core/lib/coreBundle") as {
    utils: {
      ZipFile: new (path: string) => {
        entries(): Promise<string[]>;
        read(path: string): Promise<Buffer>;
        close(): void;
      };
    };
  };
  const digest = (bytes: Buffer) => ({ bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  const traceRoot = test.info().project.outputDir;
  const traces = [];
  const markers =
    /Bearer\s+[A-Za-z0-9._~-]{12,}|(?:sk_live_|rk_live_|ghp_)[A-Za-z0-9]+|"name"\s*:\s*"(?:authorization|cookie|set-cookie)"\s*,\s*"value"\s*:\s*"[^"\s]+/i;
  expect(markers.test(JSON.stringify({ name: "cookie", value: "SYNTHETIC_FORBIDDEN_PROVIDER_SESSION" }))).toBe(true);
  for (const file of readdirSync(traceRoot, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".zip"))
    .sort()) {
    const path = resolve(traceRoot, file);
    const archive = new ZipFile(path);
    const entries = [];
    try {
      for (const entry of await archive.entries()) {
        const bytes = await archive.read(entry);
        entries.push({ entry, ...digest(bytes), forbiddenMarker: markers.test(bytes.toString("utf8")) });
      }
    } finally {
      archive.close();
    }
    traces.push({ file, ...digest(readFileSync(path)), entries });
  }
  expect(traces.length).toBeGreaterThan(0);
  const scan = { scope: "all retained trace ZIP entries, including resources and source payloads", traces };
  save("trace-scan.json", scan);
  expect(traces.flatMap((trace) => trace.entries).filter((entry) => entry.forbiddenMarker)).toEqual([]);
  const identity = {
    issue: 8589,
    artifactRoot: root,
    platform: platform(),
    osRelease: release(),
    sourceHead:
      process.env.OPERATOR_EVIDENCE_SOURCE_HEAD ??
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    checkoutHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runId: process.env.GITHUB_RUN_ID ?? "local-diagnostic",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
    job: process.env.GITHUB_JOB ?? "8589-impl-g1",
    playwrightVersion,
  };
  save("identity.json", identity);
  const payloads = readdirSync(root)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const bytes = readFileSync(resolve(root, file));
      return { file, ...digest(bytes), raw: bytes.toString("utf8") };
    });
  const packet = { identity, payloads };
  save(
    "manifest.json",
    payloads.map(({ raw: _raw, ...entry }) => entry),
  );
  // Hosted CI does not upload this probe directory. Retain exact bytes in its immutable job log without a workflow change.
  const encoded = gzipSync(Buffer.from(JSON.stringify(packet))).toString("base64");
  for (let offset = 0; offset < encoded.length; offset += 8_000)
    console.log(`RESTART_PROBE_8589_PACKET ${offset / 8_000} ${encoded.slice(offset, offset + 8_000)}`);
  console.log(
    `RESTART_PROBE_8589_MANIFEST ${JSON.stringify({ ...identity, packetEncoding: "gzip+base64", chunks: Math.ceil(encoded.length / 8_000), files: payloads.map(({ raw: _raw, ...entry }) => entry) })}`,
  );
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
  {
    name: "context.close-without-alarm-reensure",
    mechanism: "context.close",
    options: { ...candidateOptions, omitAlarmReensure: true },
  },
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
    let initial: CaseObservation["initial"];
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
      expect(playwrightVersion).toBe("1.60.0");
      expect(context.browser()!.version()).toBe("148.0.7778.96");
      worker = await fixtureWorker(context);
      worker.on("close", () => {
        closed = true;
      });
      extensionId = new URL(worker.url()).host;
      page = await observer(context, extensionId);
      initial = await worker.evaluate(() => globalThis.restartProbe.prepare());
      if (!scenario.options.omitAlarmReensure) {
        const repeated = await worker.evaluate(async () => {
          const probe = globalThis.restartProbe;
          await Promise.all([probe.ensureAlarm("control:overlap-1"), probe.ensureAlarm("control:overlap-2")]);
          await probe.ensureAlarm("control:repeat");
          return probe.ensures;
        });
        for (const entry of repeated.filter((entry) => entry.entrypoint.startsWith("control:"))) {
          expect(entry.created).toBe(false);
          expect(entry.alarm.scheduledTime).toBe(initial.alarm.scheduledTime);
          expect(entry.getResult?.scheduledTime).toBe(initial.alarm.scheduledTime);
        }
        initial.ensures = repeated;
      }
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
      expect(Date.parse(initial.preparedAt)).toBeLessThanOrEqual(Date.parse(before.fires[0]!));
      const observedFirstFireMs = Math.round(Date.parse(before.fires[0]!) - (initial.alarm.scheduledTime - 30_000));
      expect(observedFirstFireMs).toBeGreaterThanOrEqual(0);
      expect(observedFirstFireMs).toBeLessThanOrEqual(60_000);
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
          route: mechanismRoutes[scenario.mechanism],
          intervenedAt: "",
          artifactRef: resolve(root, `${scenario.name}.json`),
          terminatedMidFetch: null,
          pendingTransactionAtomic: null,
          refetchOnlyAfterAlarm: null,
          indexedDbSurvived: null,
        },
        before,
        initial,
        observedFirstFireMs,
        preCloseAlarms: null,
        postRelaunchAlarms: null,
        startup: null,
        after: null,
        final: null,
        workerClosed: false,
        pendingTransactionAtIntervention: false,
        intervenedAt: "",
        attachmentError: null,
        unobservedReason: null,
        refireWindow: null,
        requests: server.requests,
      };
      await worker.evaluate(() => globalThis.restartProbe.startTwo());
      await expect.poll(() => worker.evaluate(() => globalThis.restartProbe.state.pendingTransaction)).toBe(true);
      result.pendingTransactionAtIntervention = await worker.evaluate(
        () => globalThis.restartProbe.state.pendingTransaction,
      );
      expect(await worker.evaluate(() => globalThis.restartProbe.state.pendingFetch)).toBe(true);
      result.preCloseAlarms = await alarmSnapshot(page);
      expect(result.preCloseAlarms.alarms.filter((alarm) => alarm.name === "probe-work")).toHaveLength(1);
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
        if (closed) {
          try {
            await fixtureWorker(context);
          } catch (error) {
            // Preserve unavailable observations without inventing post-reload boolean facts.
            save("runtime.reload-lifecycle.json", {
              chromiumVersion: result.chromiumVersion,
              capturedAt: new Date().toISOString(),
              extensionId,
              before,
              pendingTransactionAtIntervention: result.pendingTransactionAtIntervention,
              intervenedAt: result.intervenedAt,
              workerClosed: closed,
              remainingWorkerUrls: context.serviceWorkers().map((entry) => entry.url()),
              requests: server.requests,
              readinessError: error instanceof Error ? error.message : String(error),
            });
            const diagnostics = await context.newPage();
            await diagnostics.goto("chrome://extensions/");
            await diagnostics
              .locator("extensions-item")
              .filter({ hasText: "SYNTHETIC restart boundary probe" })
              .waitFor();
            const accessibility = await diagnostics.locator("body").ariaSnapshot();
            const disabled = diagnostics.getByText(
              "Turn on developer mode to use this extension, which can't be reviewed by the Chrome Web Store.",
              { exact: true },
            );
            const disabledMessage = (await disabled.count()) === 1 ? await disabled.textContent() : null;
            save("runtime.reload-extension-page.json", {
              capturedAt: new Date().toISOString(),
              accessibility,
              disabledMessage,
            });
            await diagnostics.screenshot({ path: test.info().outputPath("runtime.reload-extensions.png") });
            result.unobservedReason = {
              code: disabledMessage ? "extension-disabled-after-intervention" : "worker-not-replaced",
              message: disabledMessage ?? (error instanceof Error ? error.message : String(error)),
            };
          }
        }
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
          if (result.mechanism.available) throw error;
          result.mechanism.unavailableReason = result.attachmentError;
          result.unobservedReason = { code: "route-unavailable", message: result.attachmentError };
        }
      }
      result.mechanism.intervenedAt = result.intervenedAt;
      if (result.unobservedReason) {
        for (const fact of mechanismFacts) {
          if (result.mechanism[fact] === null) result.mechanism[`${fact}Reason`] = result.unobservedReason;
        }
      }
      if (result.mechanism.available && !result.unobservedReason) {
        result.startup = await settledStartup(context);
        expect(Date.parse(result.startup.startedAt)).toBeLessThanOrEqual(Date.parse(result.startup.attachedAt));
        page = await observer(context, extensionId);
        result.postRelaunchAlarms = await alarmSnapshot(page);
        const alarms = result.postRelaunchAlarms.alarms.filter((alarm) => alarm.name === "probe-work");
        expect(alarms).toHaveLength(scenario.options.omitAlarmReensure ? 0 : 1);
        if (scenario.options.omitAlarmReensure) expect(result.startup.ensures).toEqual([]);
        else {
          expect(result.startup.ensures.some((entry) => entry.entrypoint === "top-level")).toBe(true);
          for (const entry of result.startup.ensures) {
            expect(entry.settledAt).toBeTruthy();
            if (entry.getResult) {
              expect(entry.created).toBe(false);
              expect(entry.alarm.scheduledTime).toBe(entry.getResult.scheduledTime);
            }
          }
        }
        result.after = await snapshot(page);
        const records = result.after.records;
        const both =
          records.length === 2 &&
          records.every((record) => record.state === "two-record" && record.at === "SYNTHETIC_ATOMIC_CANARY");
        const neither = JSON.stringify(records) === JSON.stringify(before.records);
        result.mechanism.pendingTransactionAtomic = result.pendingTransactionAtIntervention && (both || neither);
        result.mechanism.indexedDbSurvived = before.records.length > 0 && (both || neither);
        result.mechanism.terminatedMidFetch &&= !records.some((record) => record.state === "receipt-captured");
        result.refireWindow = {
          startedAt: new Date().toISOString(),
          endedAt: "",
          elapsedMs: 0,
          requiredMs: 30_000 + observedFirstFireMs + 5_000,
          message: "",
        };
        expect(result.refireWindow.requiredMs).toBeLessThanOrEqual(95_000);
      }
      save(`${scenario.name}-boundary.json`, result);
    });

    for (let segment = 1; segment <= 5; segment++) {
      test(`complete refire observation segment ${segment} (at most 20 seconds)`, async () => {
        if (!result?.refireWindow) return;
        const window = result.refireWindow;
        const elapsed = Date.now() - Date.parse(window.startedAt);
        expect(Date.now() - Date.parse(result.intervenedAt)).toBeLessThan(120_000);
        const remaining = Math.min(
          20_000,
          Math.max(0, window.requiredMs - elapsed),
          120_000 - (Date.now() - Date.parse(result.intervenedAt)),
        );
        if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
        expect(Date.now() - Date.parse(result.intervenedAt)).toBeLessThan(120_000);
        expect(server.requests.length).toBeLessThanOrEqual(2);
        if (scenario.options.omitAlarmReensure) {
          expect(server.requests).toHaveLength(1);
          expect((await snapshot(page)).fires).toHaveLength(1);
        }
      });
    }

    test("record post-restart refire, atomicity, persistence and storage", async () => {
      if (!result) return;
      if (result.after) {
        result.final = await snapshot(page);
        const window = result.refireWindow!;
        window.endedAt = new Date().toISOString();
        window.elapsedMs = Date.parse(window.endedAt) - Date.parse(window.startedAt);
        expect(window.elapsedMs).toBeGreaterThanOrEqual(window.requiredMs);
        expect(Date.parse(window.endedAt) - Date.parse(result.intervenedAt)).toBeLessThan(120_000);
        window.message = JSON.stringify({
          startedAt: window.startedAt,
          endedAt: window.endedAt,
          elapsedMs: window.elapsedMs,
          requiredMs: window.requiredMs,
          requests: server.requests.length,
          fires: result.final.fires.length,
        });
        const refetch =
          server.requests.length === 2 &&
          result.final.fires.length === 2 &&
          Date.parse(result.final.fires[1]!) <= Date.parse(server.requests[1]!.at) &&
          Date.parse(result.final.fires[1]!) >= Date.parse(window.startedAt);
        if (refetch || server.requests.length >= 2 || window.elapsedMs >= window.requiredMs) {
          result.mechanism.refetchOnlyAfterAlarm = refetch;
        } else {
          result.mechanism.refetchOnlyAfterAlarmReason = {
            code: "window-shorter-than-period",
            message: window.message,
          };
        }
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

function aggregate(baseline: CaseObservation) {
  let refiredAfterRelaunch: boolean | null = null;
  if (baseline.final) {
    if (baseline.final.fires.length >= 2) refiredAfterRelaunch = true;
    else if (baseline.refireWindow!.elapsedMs >= baseline.refireWindow!.requiredMs) refiredAfterRelaunch = false;
  }
  const refireReason = baseline.unobservedReason ?? {
    code: "window-shorter-than-period",
    message: baseline.refireWindow?.message,
  };
  return parseProbeRecord({
    schemaVersion: 2,
    chromiumVersion: baseline.chromiumVersion,
    playwrightVersion,
    capturedAt: new Date().toISOString(),
    mechanisms: mechanismNames.map((name) =>
      name === "context.close" ? baseline.mechanism : observations.find((entry) => entry.name === name)!.mechanism,
    ),
    alarm: {
      mechanism: baseline.mechanism.name,
      artifactRef: baseline.mechanism.artifactRef,
      requestedPeriodSeconds: 30,
      observedFirstFireMs: baseline.observedFirstFireMs,
      refiredAfterRelaunch,
      ...(refiredAfterRelaunch === null ? { refiredAfterRelaunchReason: refireReason } : {}),
    },
    storage: {
      mechanism: baseline.mechanism.name,
      artifactRef: baseline.mechanism.artifactRef,
      localSurvived: baseline.after ? baseline.after.localCanary === baseline.before.localCanary : null,
      sessionSurvived: baseline.after ? baseline.after.sessionCanary === baseline.before.sessionCanary : null,
      ...(!baseline.after
        ? { localSurvivedReason: baseline.unobservedReason, sessionSurvivedReason: baseline.unobservedReason }
        : {}),
    },
  });
}

test("publish the closed observed record and discriminating controls", async () => {
  const baseline = observations.find((entry) => entry.name === "context.close")!;
  const omission = observations.find((entry) => entry.name === "context.close-without-alarm-reensure")!;
  const ordering = observations.find((entry) => entry.name === "ordering-mutant")!;
  const deleted = observations.find((entry) => entry.name === "delete-database-mutant")!;
  expect(observations).toHaveLength(7);
  expect(ordering.before.records).toEqual([]);
  expect(ordering.after?.records).toEqual([]);
  expect(ordering.mechanism.terminatedMidFetch).toBe(baseline.mechanism.terminatedMidFetch);
  expect(deleted.mechanism.indexedDbSurvived).toBe(false);
  expect(deleted.after?.records).toEqual([]);
  for (const mutant of [ordering, deleted]) {
    expect(mutant.requests).toHaveLength(2);
    expect(mutant.final?.fires).toHaveLength(2);
    expect(mutant.final?.records).toEqual([]);
  }
  for (const fact of ["terminatedMidFetch", "pendingTransactionAtomic", "indexedDbSurvived"] as const) {
    expect(omission.mechanism[fact]).toBe(true);
    expect(omission.mechanism[fact]).toBe(baseline.mechanism[fact]);
  }
  expect(omission.mechanism.refetchOnlyAfterAlarm).toBe(false);
  expect(omission.final?.fires).toHaveLength(1);
  expect(omission.requests).toHaveLength(1);
  const record = aggregate(baseline);
  const omittedRecord = aggregate(omission);
  save("context.close-without-alarm-reensure-aggregate.json", omittedRecord);
  save("context.close-without-alarm-reensure-decision.json", {
    selectedMechanism: selectMechanism(omittedRecord)?.name ?? null,
  });
  expect(omittedRecord.alarm.refiredAfterRelaunch).toBe(false);
  expect(selectMechanism(omittedRecord)).toBeUndefined();
  save("extension-restart-probe-chromium.json", record);
  const selected = selectMechanism(record);
  save("decision.json", {
    downstream: selected ? "observed mechanism candidate; independent review required" : "H1 not ready",
    selectedMechanism: selected?.name ?? null,
    orderingDiscriminates: baseline.before.records.length === 1 && ordering.after?.records.length === 0,
    deleteDatabaseDiscriminates: baseline.mechanism.indexedDbSurvived && !deleted.mechanism.indexedDbSurvived,
  });
  await publishPayloads();
  expect(selected?.name).toBe("context.close");
  console.log(`Restart probe record: ${resolve(root, "extension-restart-probe-chromium.json")}`);
});
