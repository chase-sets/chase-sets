import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test, type BrowserContext, type Worker } from "@playwright/test";
import {
  buildReplacementBundle,
  extensionIdForKey,
  fileDigests,
  stageBundle,
  syntheticReplacementKey,
  syntheticReplacementKeySha256,
} from "../__tests__/fixtures/code-replacement/bundle";
import { launchFixture, observeUntil } from "../__tests__/support/browser-observation";
import {
  armFixtureVersions,
  assessReplacement,
  buildReplacementRecord,
  consumedVersion,
  parseReplacementRecord,
  replacementArms,
  replacementPins,
  stageLaunch,
  type ArmRecord,
  type BundleRecord,
  type Capture,
  type CaptureFailure,
  type CaptureStage,
  type ReplacementArm,
  type ReplacementBody,
} from "../__tests__/support/replacement-record";

declare global {
  var codeReplacementProbe:
    | {
        identity: string;
        startedAt: string;
        installs: { reason: string; previousVersion: string | null; observedAt: string }[];
      }
    | undefined;
}

type BuiltBundle = ReturnType<typeof buildReplacementBundle>;
type ArmState = { A: BuiltBundle; B: BuiltBundle; install: string; record: ArmRecord };

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, "../../../artifacts/9257", new Date().toISOString().replaceAll(/[:.]/g, "-"));
const playwrightVersion: string = JSON.parse(
  readFileSync(require.resolve("@playwright/test/package.json"), "utf8"),
).version;
const extensionId = extensionIdForKey(syntheticReplacementKey);
const workerUrl = `chrome-extension://${extensionId}/worker.js`;
const checkoutHead = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const runId = process.env.GITHUB_RUN_ID ?? "local-diagnostic";
const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
const run = {
  id: `${runId}/${runAttempt}`,
  sourceHead: process.env.OPERATOR_EVIDENCE_SOURCE_HEAD || checkoutHead,
  checkoutHead,
  runId,
  runAttempt,
  job: process.env.GITHUB_JOB ?? "9257-impl-g1",
};
// onInstalled is dispatched right after the worker evaluates; reasons are read only after this settle window.
const onInstalledSettleMs = 2_000;

function save(name: string, value: unknown) {
  mkdirSync(root, { recursive: true });
  writeFileSync(resolve(root, name), `${JSON.stringify(value, null, 2)}\n`);
}

const bundleRecord = ({ directory: _directory, ...record }: BuiltBundle): BundleRecord => record;

// #7940's installation helper flags at the stable profile/extension-under-test path.
const launchFlags = (install: string) => [
  `--disable-extensions-except=${install}`,
  "--enable-unsafe-extension-debugging",
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
];

async function replacementWorker(context: BrowserContext, previous?: Worker) {
  let found: Worker | undefined;
  await observeUntil(() => {
    found = context.serviceWorkers().find((worker) => worker !== previous && worker.url() === workerUrl);
    return found !== undefined;
  }, 10_000);
  // A worker that was never replaced is still an observation: its compiled identity shows what executed.
  return found ?? context.serviceWorkers().find((worker) => worker.url() === workerUrl) ?? null;
}

async function writeMarker(worker: Worker, nonce: string) {
  await worker.evaluate(
    (nonce) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("code-replacement-probe", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("markers", { keyPath: "id" });
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("markers", "readwrite");
          transaction.objectStore("markers").put({ id: "marker", nonce, writtenAt: new Date().toISOString() });
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => {
            database.close();
            reject(transaction.error);
          };
        };
      }),
    nonce,
  );
}

async function observeWorker(worker: Worker) {
  return worker.evaluate(async (settleMs) => {
    const probe = globalThis.codeReplacementProbe;
    if (!probe) throw new Error("worker exposes no compiled code-replacement identity");
    const wait = Date.parse(probe.startedAt) + settleMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const marker = await new Promise<{ present: boolean; nonce: string | null }>((resolve, reject) => {
      const absent = { present: false, nonce: null };
      const request = indexedDB.open("code-replacement-probe");
      // Never create the marker database while reading it.
      request.onupgradeneeded = () => request.transaction!.abort();
      request.onerror = () => (request.error?.name === "AbortError" ? resolve(absent) : reject(request.error));
      request.onsuccess = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("markers")) {
          database.close();
          resolve(absent);
          return;
        }
        const read = database.transaction("markers").objectStore("markers").get("marker");
        read.onsuccess = () => {
          database.close();
          resolve(read.result ? { present: true, nonce: read.result.nonce } : absent);
        };
        read.onerror = () => {
          database.close();
          reject(read.error);
        };
      };
    });
    return {
      workerUrl: globalThis.location.href,
      executedIdentity: probe.identity,
      workerStartedAt: probe.startedAt,
      runtimeManifestVersion: chrome.runtime.getManifest().version,
      onInstalled: [...probe.installs],
      onInstalledObservedForMs: Date.now() - Date.parse(probe.startedAt),
      marker,
    };
  }, onInstalledSettleMs);
}

async function capture(context: BrowserContext, state: ArmState, stage: CaptureStage, previous?: Worker) {
  const base = {
    arm: state.record.name,
    stage,
    launch: stageLaunch[stage],
    run: run.id,
    profile: state.record.profile,
    chromiumVersion: context.browser()!.version(),
  };
  const failed = (failure: CaptureFailure): Capture => ({
    ...base,
    capturedAt: new Date().toISOString(),
    observation: null,
    failure,
  });
  const worker = await replacementWorker(context, previous);
  let result: Capture;
  if (!worker) result = failed({ code: "worker-not-observed", message: `no ${workerUrl} worker within 10000 ms` });
  else {
    try {
      const observed = await observeWorker(worker);
      const page = await context.newPage();
      try {
        await page.goto(`chrome-extension://${extensionId}/observer.html`);
        const registrations = await page.evaluate(async () =>
          (await navigator.serviceWorker.getRegistrations()).map((registration) => ({
            scope: registration.scope,
            active: registration.active?.scriptURL ?? null,
            waiting: registration.waiting?.scriptURL ?? null,
            installing: registration.installing?.scriptURL ?? null,
          })),
        );
        result = {
          ...base,
          capturedAt: new Date().toISOString(),
          observation: {
            ...observed,
            registrations,
            contextServiceWorkers: context.serviceWorkers().map((entry) => entry.url()),
          },
        };
      } catch (error) {
        result = failed({ code: "registrations-unobserved", message: String(error).slice(0, 1024) });
      } finally {
        await page.close();
      }
    } catch (error) {
      result = failed({ code: "evaluation-failed", message: String(error).slice(0, 1024) });
    }
  }
  save(`${state.record.name}-${stage}.json`, result);
  state.record.captures.push(result);
  return worker;
}

test.describe.serial("extension-code-replacement-probe-chromium @tcgplayer-connector-extension-authority", () => {
  const arms = new Map<ReplacementArm, ArmState>();
  let context: BrowserContext | undefined;
  let chromiumVersion = "unobserved";
  let published = false;

  async function launch(state: ArmState) {
    expect(context, "only one context may hold a profile").toBeUndefined();
    context = await launchFixture(state.install, state.record.profile, launchFlags(state.install));
    chromiumVersion = context.browser()!.version();
    expect(playwrightVersion).toBe(replacementPins.playwrightVersion);
    expect(chromiumVersion).toBe(replacementPins.chromiumVersion);
    return context;
  }

  async function close() {
    await context?.close();
    context = undefined;
  }

  function stage(state: ArmState, bundle: BuiltBundle) {
    expect(context, "staging runs while no context holds the profile").toBeUndefined();
    const staging = stageBundle(bundle, state.install);
    save(`${state.record.name}-staging-${bundle.label}.json`, staging);
    expect(staging.source).toEqual(bundle.files);
    expect(staging.staged).toEqual(staging.source);
    state.record.stagings.push(staging);
  }

  function publish() {
    published = true;
    const body: ReplacementBody = {
      schema: "extension-code-replacement-qualification",
      schemaVersion: 1,
      run: { ...run, capturedAt: new Date().toISOString() },
      pins: { playwrightVersion, chromiumVersion },
      extension: { id: extensionId, syntheticKeySha256: syntheticReplacementKeySha256 },
      arms: [...arms.values()].map((state) => state.record),
    };
    const record = buildReplacementRecord(body);
    const assessment = assessReplacement(body);
    save("extension-code-replacement-probe-chromium.json", record);
    save("decision.json", {
      selectedReplacementMechanism: record.selectedReplacementMechanism,
      downstream:
        record.selectedReplacementMechanism === "NONE"
          ? "no qualified code replacement; the AC6 upgrade slice returns to an independent decision"
          : "qualified mechanism candidate for the AC6 upgrade slice; independent review required",
      ...assessment,
    });
    const digest = (bytes: Buffer) => ({
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const payloads = readdirSync(root)
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map((file) => {
        const bytes = readFileSync(resolve(root, file));
        return { file, ...digest(bytes), raw: bytes.toString("utf8") };
      });
    const files = payloads.map(({ raw: _raw, ...entry }) => entry);
    // Hosted CI does not upload this probe directory; retain the exact bytes in the immutable job log.
    const encoded = gzipSync(Buffer.from(JSON.stringify({ issue: 9257, run, artifactRoot: root, payloads }))).toString(
      "base64",
    );
    for (let offset = 0; offset < encoded.length; offset += 8_000)
      console.log(`CODE_REPLACEMENT_PROBE_9257_PACKET ${offset / 8_000} ${encoded.slice(offset, offset + 8_000)}`);
    console.log(
      `CODE_REPLACEMENT_PROBE_9257_MANIFEST ${JSON.stringify({
        ...run,
        playwrightVersion,
        chromiumVersion,
        selectedReplacementMechanism: record.selectedReplacementMechanism,
        recordSha256: files.find((file) => file.file === "extension-code-replacement-probe-chromium.json")!.sha256,
        packetEncoding: "gzip+base64",
        chunks: Math.ceil(encoded.length / 8_000),
        files,
      })}`,
    );
    return { record, assessment };
  }

  test.afterAll(async () => {
    await close();
    // Failure-path retention: a partial packet is still published, and the strict selector reads it as NONE.
    if (!published) publish();
  });

  for (const name of replacementArms) {
    test(`${name}: install A on a fresh profile and write the IndexedDB marker`, async () => {
      const directory = resolve(root, name);
      const profile = resolve(directory, "profile");
      expect(existsSync(profile)).toBe(false);
      const versions = armFixtureVersions[name];
      const A = buildReplacementBundle(resolve(directory, "bundle-A"), name, "A", versions.A, versions.syntheticA);
      const B = buildReplacementBundle(resolve(directory, "bundle-B"), name, "B", consumedVersion, false);
      const state: ArmState = {
        A,
        B,
        install: resolve(profile, "extension-under-test"),
        record: {
          name,
          profile,
          markerNonce: randomUUID(),
          bundles: { A: bundleRecord(A), B: bundleRecord(B) },
          stagings: [] as unknown as ArmRecord["stagings"],
          captures: [],
          loadUnpacked: null,
        },
      };
      arms.set(name, state);
      stage(state, A);
      const installed = await launch(state);
      const worker = await replacementWorker(installed);
      expect(worker, "bundle A must start on its fresh install").not.toBeNull();
      await writeMarker(worker!, state.record.markerNonce);
      await capture(installed, state, "install");
      await close();
    });

    test(`${name}: clear the closed install directory, stage B and relaunch`, async () => {
      const state = arms.get(name)!;
      stage(state, state.B);
      await capture(await launch(state), state, "relaunch");
      if (name !== "cdp-load-unpacked") await close();
    });

    if (name === "cdp-load-unpacked")
      test(`${name}: re-register the staged B through Extensions.loadUnpacked`, async () => {
        const state = arms.get(name)!;
        const live = context!;
        const previous = live.serviceWorkers().find((worker) => worker.url() === workerUrl);
        const requestedAt = new Date().toISOString();
        const session = await live.browser()!.newBrowserCDPSession();
        try {
          const { id } = await session.send("Extensions.loadUnpacked", { path: state.install });
          state.record.loadUnpacked = { route: "Extensions.loadUnpacked", requestedAt, extensionId: id, error: null };
        } catch (error) {
          state.record.loadUnpacked = {
            route: "Extensions.loadUnpacked",
            requestedAt,
            extensionId: null,
            error: String(error).slice(0, 1024),
          };
        } finally {
          await session.detach().catch(() => undefined);
        }
        save(`${name}-load-unpacked-request.json`, state.record.loadUnpacked);
        await capture(live, state, "load-unpacked", previous);
        await close();
      });

    test(`${name}: relaunch the staged B unchanged`, async () => {
      const state = arms.get(name)!;
      const installed = fileDigests(state.install);
      save(`${name}-repeat-install-set.json`, installed);
      expect(installed.filter((file) => state.B.files.some((built) => built.name === file.name))).toEqual(
        state.B.files,
      );
      await capture(await launch(state), state, "repeat-relaunch");
      await close();
    });
  }

  test("publish the closed replacement packet and its strict selection", () => {
    const { record, assessment } = publish();
    expect(assessment.parseError).toBeNull();
    expect(parseReplacementRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
    // NONE is a legitimate outcome, but only from complete required captures; an incomplete run is a harness defect.
    for (const name of ["same-version-byte-swap", "version-ordered-install"] as const)
      expect(arms.get(name)!.record.captures.filter((entry) => entry.observation === null)).toEqual([]);
    console.log(`Code replacement record: ${resolve(root, "extension-code-replacement-probe-chromium.json")}`);
    console.log(`selectedReplacementMechanism=${record.selectedReplacementMechanism}`);
  });
});
