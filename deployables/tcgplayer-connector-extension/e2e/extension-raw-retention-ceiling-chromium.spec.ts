import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  bootRetention,
  chromiumVersion,
  clockAt,
  launchRetention,
  observeRetention,
  prepareRetention,
  productDigest,
  retentionCallback,
} from "./retention-observation";
import { scanRetainedArtifacts } from "./retained-artifacts";

test.use({ trace: "off", screenshot: "off" });
type Observation = Awaited<ReturnType<typeof observeRetention>>;
const observations: {
  scenario: string;
  mechanism: string;
  chromium: string;
  digest: string;
  phases: Record<string, Observation>;
}[] = [];

test.afterAll(async () => {
  const directory = resolve(import.meta.dirname, "../../../artifacts/7922-retention");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    resolve(directory, "ceiling.json"),
    JSON.stringify(
      {
        observations,
        unmetExternalObligations: [
          "(b) Actual device sleep across hour 24 and wake at hour 30: no OS sleep control is supplied by this hosted suite. Controlled clock/withheld callback is not a measured sleeping device.",
          "(c) Arbitrary browser-origin alarm delay: controlled application-clock advance with a withheld alarm is recorded separately, not claimed as browser-origin lateness.",
          "(d2) Closed-browser physical disk/memory observation at hour 24 requires a host capture; the restarted store observation alone is not that fact.",
        ],
      },
      null,
      2,
    ),
  );
  expect(
    scanRetainedArtifacts(directory, [
      "SYNTHETIC_RETENTION_RAW_7922",
      "cc_at_SYNTHETIC_RETENTION_TOKEN",
      "cc_rt_SYNTHETIC_RETENTION_TOKEN",
      "SYNTHETIC_RETENTION_KEY_CANARY",
      "SYNTHETIC_RETENTION_COOKIE",
    ]),
  ).toBeGreaterThan(0);
});

for (const scenario of ["a-awake-on-time", "c-controlled-late-callback", "e-open-failure"] as const) {
  test(`extension-raw-retention-ceiling-chromium ${scenario}`, async () => {
    const { context, worker } = await launchRetention();
    try {
      const time = await prepareRetention(worker);
      const phases: Record<string, Observation> = { before: await observeRetention(worker) };
      expect(phases.before).toMatchObject({ P: true, K: true, R: true, ciphertext: true });
      await clockAt(worker, time.deadline + (scenario === "c-controlled-late-callback" ? 6 * 3600000 : 0));
      phases.afterDeadlineBeforeCallback = await observeRetention(worker);
      expect(phases.afterDeadlineBeforeCallback).toMatchObject({ P: true, K: true, R: false, ciphertext: true });
      if (scenario === "e-open-failure") {
        await worker.evaluate(async () => {
          const original = indexedDB.open.bind(indexedDB);
          indexedDB.open = () => {
            throw new DOMException("synthetic-open-failure", "UnknownError");
          };
          try {
            const product = globalThis.__retentionProduct;
            await product.background.boot();
          } finally {
            indexedDB.open = original;
          }
        });
        phases.failedCallback = await observeRetention(worker);
        expect(phases.failedCallback).toMatchObject({
          P: true,
          K: true,
          R: false,
          state: { state: "paused", pauseReason: "cleanup-failed" },
        });
      }
      await retentionCallback(worker);
      phases.firstSuccessfulCallback = await observeRetention(worker);
      expect(phases.firstSuccessfulCallback).toMatchObject({ P: false, K: false, R: false, ciphertext: false });
      observations.push({
        scenario,
        mechanism: "real Chromium store; controlled application UTC clock; real chrome.alarms callback",
        chromium: await chromiumVersion(context),
        digest: productDigest(),
        phases,
      });
    } finally {
      await context.close();
    }
  });
}

for (const afterExpiry of [false, true]) {
  test(`extension-raw-retention-ceiling-chromium restart ${afterExpiry ? "d2" : "d1"}`, async () => {
    const first = await launchRetention();
    const time = await prepareRetention(first.worker);
    const before = await observeRetention(first.worker);
    await first.context.close();
    const second = await launchRetention(first.profile);
    try {
      if (afterExpiry) await clockAt(second.worker, time.deadline + 6 * 3600000);
      await bootRetention(second.worker);
      const after = await observeRetention(second.worker);
      expect(after).toMatchObject({ P: false, K: false, R: false, ciphertext: false });
      observations.push({
        scenario: afterExpiry ? "d2-reopen-controlled-hour-30" : "d1-restart-before-expiry",
        mechanism: "real browser close/relaunch, same isolated profile; controlled application clock on reopen",
        chromium: await chromiumVersion(second.context),
        digest: productDigest(),
        phases: { before, firstBoot: after },
      });
    } finally {
      await second.context.close();
    }
  });
}

test("extension-raw-retention-ceiling-chromium key-delete-callback mutant reveals obtainable orphan key", async () => {
  const { context, worker } = await launchRetention();
  try {
    const time = await prepareRetention(worker);
    await clockAt(worker, time.deadline);
    const result = await worker.evaluate(async () => {
      const product = globalThis.__retentionProduct;
      const original = chrome.storage.session.remove;
      const originalSet = chrome.storage.session.set;
      const keys = Object.keys(await chrome.storage.session.get(null)).filter((key) =>
        key.startsWith("connector-raw-key:"),
      );
      chrome.storage.session.remove = async () => {};
      chrome.storage.session.set = async () => {};
      try {
        await product.retentionStore.run({ reason: "retention", deleteAll: false });
        const retained = await chrome.storage.session.get(keys);
        return {
          obtainableKeys: Object.keys(retained).length,
          read: await product.retentionStore.read("synthetic_raw").then(
            () => true,
            () => false,
          ),
        };
      } finally {
        chrome.storage.session.remove = original;
        chrome.storage.session.set = originalSet;
        await chrome.storage.session.remove(keys);
      }
    });
    expect(result.read).toBe(false);
    expect(() => expect(result.obtainableKeys).toBe(0)).toThrow();
    expect(result.obtainableKeys).toBe(1);
  } finally {
    await context.close();
  }
});

test("retention failure artifacts exclude synthetic raw bytes, session keys, tokens and cookies", async () => {
  const { context, worker } = await launchRetention();
  const directory = resolve(import.meta.dirname, "../../../artifacts/7922-retention/failure-control");
  mkdirSync(directory, { recursive: true });
  try {
    await prepareRetention(worker);
    // Synthetic canaries only. Keep material in process memory for the scanner, never an attachment.
    const keys = await worker.evaluate(async () => {
      const values = await chrome.storage.session.get(null);
      return Object.entries(values)
        .filter(([name]) => name.startsWith("connector-raw-key:"))
        .flatMap(([, value]) => {
          const bytes = value as number[];
          return [
            JSON.stringify(bytes),
            btoa(String.fromCharCode(...bytes)),
            bytes.map((byte) => byte.toString(16).padStart(2, "0")).join(""),
          ];
        });
    });
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    const page = context.pages()[0]!;
    await page.goto("data:text/html,<title>Synthetic retention failure control</title>");
    await expect(page.locator("#synthetic-absent-control").click({ timeout: 50 })).rejects.toThrow();
    await context.tracing.stop({ path: resolve(directory, "failure.zip") });
    expect(
      scanRetainedArtifacts(directory, [
        ...keys,
        "SYNTHETIC_RETENTION_RAW_7922",
        "cc_at_SYNTHETIC_RETENTION_TOKEN",
        "cc_rt_SYNTHETIC_RETENTION_TOKEN",
        "SYNTHETIC_RETENTION_COOKIE",
      ]),
    ).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});
