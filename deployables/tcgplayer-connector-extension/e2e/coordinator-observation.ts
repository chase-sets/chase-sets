import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build, type Plugin } from "vite";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { expect, type BrowserContext, type Worker } from "@playwright/test";
import { TCGPLAYER_CONNECTOR_EXTENSION_ID } from "@chase-sets/channels/client";
import {
  attestInstallation,
  executedIdentity,
  executionIdentityPlugin,
  installationDiagnostics,
  launchInstallation,
} from "./extension-installation";
import { platformOrigin } from "../__tests__/harness/origins";
import { createSyntheticPairingCode, synthetic } from "./loopback-platform";

declare global {
  var __connectorHarness: typeof import("../__tests__/harness/entry.harness").harness;
}
export const packageRoot = resolve(import.meta.dirname, "..");
export const proofRoot = resolve(packageRoot, "../../artifacts/connector-composition");
export const qualifiedWindowMs = 65001;
export const authority = {
  issue: 8589,
  job: "111447661128",
  run: "37206139311",
  attempt: 1,
  reviewedHead: "3845dfed792dbbd849e5bc9104be165975b22f5f",
  merge: "aa86612318176f864fd84aeafaa29f96f7f70cd0",
  packetSha256: "0f3a15e860615d754a4fef2ed8fc6ea0a2511dd5a3bdd551a991410c55bd238b",
  selectedMechanism: "context.close",
  binding: "https://github.com/chase-sets/chase-sets/issues/7940#issuecomment-6087950378",
};

export async function buildHarness(unit: "operation" | "reservation", replayMutant = false, suppressTransform = false) {
  let transformVisits = 0;
  process.env.VITE_PLATFORM_API_URL = platformOrigin;
  process.env.VITE_CONNECTOR_CLIENT_ID = synthetic.clientId;
  process.env.CONNECTOR_HARNESS_EXECUTOR_UNIT = unit;
  for (const name of Object.keys(process.env))
    if (/^TCGPLAYER_|PROVIDER.*(?:SESSION|CREDENTIAL)|CONNECTOR.*CONFIG_ROOT/i.test(name)) delete process.env[name];
  await build({
    root: packageRoot,
    configFile: resolve(packageRoot, "vite.config.ts"),
    configLoader: "runner",
    mode: "harness",
    logLevel: "warn",
    plugins: [
      executionIdentityPlugin(replayMutant && !suppressTransform ? "replay-guard-removed" : `normal-${unit}`),
      ...(replayMutant
        ? [
            {
              name: "synthetic-replay-guard-removed",
              enforce: "pre",
              transform(source, id) {
                if (!id.replaceAll("\\", "/").endsWith("/connector-client/domain/operation-coordinator.ts"))
                  return null;
                const anchor = "const executor = executors.get(reservation.executorKey);";
                if (source.split(anchor).length !== 2) throw new Error("replay-mutant-anchor-moved");
                transformVisits++;
                if (suppressTransform) return source;
                return source.replace(
                  anchor,
                  `${anchor}
          if (exact.members.some(member => ["dispatched", "outcome-unknown"].includes(member.state))) {
            state = await write(input, state, revise(reservation, { phase: "prepared" }), exact.members.map(member => {
              const { dispatchedAt, unknownReason, receipt, ...retained } = member;
              return revise(retained, { state: "prepared" });
            }));
            reservation = state.reservations.find(row => row.reservationId === reservation.reservationId)!;
            exact = unit(state, reservation);
          }`,
                );
              },
            } satisfies Plugin,
          ]
        : []),
    ],
  });
  expect(transformVisits).toBe(replayMutant ? 1 : 0);
  const destination = resolve(
    proofRoot,
    `dist-harness-${unit}${replayMutant ? "-replay-mutant" : ""}${suppressTransform ? "-suppressed" : ""}`,
  );
  mkdirSync(destination, { recursive: true });
  for (const file of ["background.js", "manifest.json", "execution-identity.json"])
    cpSync(resolve(packageRoot, "dist-harness", file), join(destination, file));
  const manifest = JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8"));
  expect(manifest.host_permissions).toEqual([`${platformOrigin}/*`, "http://127.0.0.1:46175/*"]);
  return destination;
}

export async function launchCoordinator(extension: string, profile?: string) {
  const installation = await launchInstallation(extension, profile);
  try {
    const worker = await attestInstallation(installation);
    await worker.evaluate(async () => {
      await globalThis.__connectorHarness.product.boot;
    });
    return { ...installation, worker };
  } catch (error) {
    retain("coordinator-launch-failure", {
      profile: installation.profile,
      directory: installation.directory,
      expected: installation.identity,
      error: String(error),
      workers: await installationDiagnostics(installation.context),
    });
    await installation.context.close();
    throw error;
  }
}

export async function pair(context: BrowserContext, worker: Worker) {
  await createSyntheticPairingCode(platformOrigin);
  await context.addCookies([
    { name: synthetic.cookieName, value: synthetic.cookieValue, url: platformOrigin, httpOnly: true, sameSite: "Lax" },
  ]);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("data:text/html,<title>SYNTHETIC connector action target</title>");
  await page.bringToFront();
  const cdp = await context.browser()!.newBrowserCDPSession();
  try {
    const targets = (await cdp.send("Target.getTargets", { filter: [{ type: "tab" }, { exclude: true }] })).targetInfos;
    const target = targets.find((value) => value.url === page.url());
    if (!target) throw new Error("synthetic-action-target-missing");
    await cdp.send("Extensions.triggerAction", { id: TCGPLAYER_CONNECTOR_EXTENSION_ID, targetId: target.targetId });
    await expect.poll(() => worker.evaluate(() => chrome.action.getTitle({}))).toBe("paired-idle");
  } finally {
    await cdp.detach();
  }
}

export async function snapshot(worker: Worker) {
  const identity = await executedIdentity(worker);
  const state = await worker.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("connector-raw-exports");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const read = (name: string) =>
        new Promise<Record<string, unknown>[]>((resolve, reject) => {
          if (!db.objectStoreNames.contains(name)) return resolve([]);
          const request = db.transaction(name).objectStore(name).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      return {
        version: db.version,
        stores: Array.from(db.objectStoreNames),
        members: await read("operation-attempts"),
        reservations: await read("reservations"),
        rawExports: await read("raw-exports"),
        alarms: await chrome.alarms.getAll(),
        observation: globalThis.__connectorHarness.observation.snapshot(),
      };
    } finally {
      db.close();
    }
  });
  return { ...state, identity };
}

export async function wake(worker: Worker) {
  await worker.evaluate(async () => {
    await chrome.alarms.create("connector-work", { when: new Date().getTime() + 50, periodInMinutes: 0.5 });
  });
}
export function retain(name: string, evidence: unknown) {
  mkdirSync(proofRoot, { recursive: true });
  const payload = Buffer.from(
    JSON.stringify(
      {
        authority,
        run: process.env.GITHUB_RUN_ID ?? "local-diagnostic",
        attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
        evidence,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(proofRoot, `${name}.json`), payload);
  console.log(
    `CONNECTOR_7940_EVIDENCE ${JSON.stringify({ name, bytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex"), gzipBase64: gzipSync(payload).toString("base64") })}`,
  );
}
