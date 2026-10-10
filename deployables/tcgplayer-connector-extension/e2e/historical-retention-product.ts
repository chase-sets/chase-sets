import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { build } from "vite";
import { buildConnectorManifest } from "@chase-sets/channels/client";
import { loadConnectorBuildConfig } from "./connector-build-config";
import { packageRoot, proofRoot, retain } from "./coordinator-observation";
import { platformOrigin } from "../__tests__/harness/origins";
import { synthetic } from "./loopback-platform";
import { parseReplacementRecord } from "../__tests__/support/replacement-record";
import type { BundleIdentity } from "./extension-installation";

export const retentionProductHead = "e0d8ef5c001cde4397b16eed95ad8e22457bc71c";
export const replacementAuthority = {
  issue: 9257,
  head: "677d5f4ec792201ad0e7d3809038388bb19e0061",
  run: "38031677548",
  attempt: "1",
  job: "114153818459",
  sha256: "528aa63c7c74c8c74dd805d48f824d9f695f45b1347e0a9ef56befdbfb680f5d",
  binding: "https://github.com/chase-sets/chase-sets/issues/9257#issuecomment-6095278466",
} as const;

// Exact accepted packet from the owning job's CODE_REPLACEMENT_PROBE_9257_MANIFEST,
// not a synthetic reconstruction or this suite's fresh qualification result.
const acceptedPacketGzip = [
  "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",
].join("");

export function consumeReplacementAuthority() {
  const bytes = gunzipSync(Buffer.from(acceptedPacketGzip, "base64"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), replacementAuthority.sha256);
  const packet = parseReplacementRecord(JSON.parse(bytes.toString("utf8")));
  assert.equal(packet.run.sourceHead, replacementAuthority.head);
  assert.equal(packet.run.runId, replacementAuthority.run);
  assert.equal(packet.run.runAttempt, replacementAuthority.attempt);
  assert.equal(packet.selectedReplacementMechanism, "cdp-load-unpacked");
  const selected = packet.arms.find((arm) => arm.name === packet.selectedReplacementMechanism)!;
  for (const bundle of [selected.bundles.A, selected.bundles.B]) {
    assert.equal(bundle.manifestVersion, "0.1.0");
    assert.equal(bundle.syntheticVersion, false);
  }
  return { authority: replacementAuthority, packet };
}

export type NativeUpgrade = {
  oldVersion: number;
  newVersion: number | null;
  status: "pending" | "committed" | "aborted";
  stores: string[];
  observedAt: string;
  completedAt: string | null;
};
declare global {
  var __connectorUpgradeProbe: {
    startedAt: string;
    installs: { reason: string; previousVersion: string | null; observedAt: string }[];
    upgrades: NativeUpgrade[];
  };
  var __connectorSeed: typeof import("../src/background");
}

// Serialized into each worker before product evaluation. Native requests and
// handlers are delegated unchanged; this observer never opens a database.
export function installUpgradeObserver() {
  const probe: typeof globalThis.__connectorUpgradeProbe = {
    startedAt: new Date().toISOString(),
    installs: [],
    upgrades: [],
  };
  globalThis.__connectorUpgradeProbe = probe;
  chrome.runtime.onInstalled.addListener(({ reason, previousVersion }) => {
    probe.installs.push({ reason, previousVersion: previousVersion ?? null, observedAt: new Date().toISOString() });
  });
  const open = indexedDB.open.bind(indexedDB);
  indexedDB.open = (...args) => {
    const request = open(...args);
    if (args[0] !== "connector-raw-exports") return request;
    request.addEventListener("upgradeneeded", (event) => {
      const upgrade: NativeUpgrade = {
        oldVersion: event.oldVersion,
        newVersion: event.newVersion,
        status: "pending",
        stores: [],
        observedAt: new Date().toISOString(),
        completedAt: null,
      };
      probe.upgrades.push(upgrade);
      request.transaction!.addEventListener("complete", () => {
        upgrade.status = "committed";
        upgrade.stores = Array.from(request.result.objectStoreNames);
        upgrade.completedAt = new Date().toISOString();
      });
      request.transaction!.addEventListener("abort", () => {
        upgrade.status = "aborted";
        upgrade.completedAt = new Date().toISOString();
      });
    });
    return request;
  };
}

export const currentStores = ["operation-attempts", "raw-exports", "reservations"];
export function assertUpgradeWitness(
  state: {
    identity: { bundle: BundleIdentity | null };
    version: number;
    stores: string[];
    marker: string | null;
    keyPresent: boolean;
    rawExports: unknown[];
    probe: { upgrades: NativeUpgrade[] };
  },
  identity: BundleIdentity,
  marker: string,
) {
  assert.deepEqual(state.identity.bundle, identity, "current executed identity");
  assert.equal(state.version, 3, "current schema version");
  assert.deepEqual(state.stores, currentStores, "complete current schema");
  assert.equal(state.marker, marker, "unchanged profile-continuity marker");
  assert.equal(state.keyPresent, false, "original session key absent after restart");
  assert.deepEqual(state.rawExports, [], "settled normal cleanup");
  assert.equal(state.probe.upgrades.length, 1, "exactly one native upgrade");
  const upgrade = state.probe.upgrades[0]!;
  assert.equal(upgrade.oldVersion, 1, "historical database, not a recreated database");
  assert.equal(upgrade.newVersion, 3);
  assert.equal(upgrade.status, "committed", "native transaction committed");
  assert.deepEqual(upgrade.stores, currentStores);
  assert(Number.isFinite(Date.parse(upgrade.observedAt)));
  assert(upgrade.completedAt !== null && Date.parse(upgrade.completedAt) >= Date.parse(upgrade.observedAt));
}

export function instrumentUpgradeBundle(directory: string, transform: string) {
  const file = resolve(directory, "background.js");
  const source = `(${installUpgradeObserver.toString()})();\n${readFileSync(file, "utf8")}`;
  const identity: BundleIdentity = { sourceSha256: createHash("sha256").update(source).digest("hex"), transform };
  writeFileSync(
    file,
    `${source}\nReflect.set(globalThis, "__connectorExecutedBundle", ${JSON.stringify(identity)});\n`,
  );
  writeFileSync(resolve(directory, "execution-identity.json"), JSON.stringify(identity));
  return identity;
}

export async function buildHistoricalRetentionProduct() {
  const root = resolve(packageRoot, "../..");
  try {
    execFileSync("git", ["cat-file", "-e", `${retentionProductHead}^{commit}`], { cwd: root, stdio: "pipe" });
  } catch {
    execFileSync("git", ["fetch", "--no-tags", "origin", retentionProductHead], { cwd: root, stdio: "pipe" });
  }
  const sources = new Map<string, string>();
  const destination = resolve(proofRoot, "product-7922-v1");
  const config = await loadConnectorBuildConfig();
  const entry = "\0historical-retention-entry";
  await build({
    root: packageRoot,
    configFile: false,
    logLevel: "warn",
    resolve: config.resolve,
    define: {
      "import.meta.env.VITE_PLATFORM_API_URL": JSON.stringify(platformOrigin),
      "import.meta.env.VITE_CONNECTOR_CLIENT_ID": JSON.stringify(synthetic.clientId),
    },
    build: {
      outDir: destination,
      emptyOutDir: true,
      rolldownOptions: {
        preserveEntrySignatures: "strict",
        input: { background: entry },
        output: { entryFileNames: "[name].js", codeSplitting: false },
      },
    },
    plugins: [
      {
        name: "exact-landed-7922-product-source",
        enforce: "pre",
        resolveId(id) {
          return id === entry ? entry : null;
        },
        load(id) {
          if (id === entry)
            return `import * as product from ${JSON.stringify(resolve(packageRoot, "src/background.ts"))}; globalThis.__connectorSeed = product;`;
          const file = relative(root, id).replaceAll("\\", "/");
          if (
            !(
              file.startsWith("bounded-contexts/channels/features/connector-client/") ||
              file === "bounded-contexts/channels/client.ts" ||
              file.startsWith("deployables/tcgplayer-connector-extension/src/")
            )
          )
            return null;
          if (!sources.has(file))
            sources.set(
              file,
              execFileSync("git", ["show", `${retentionProductHead}:${file}`], {
                cwd: root,
                encoding: "utf8",
                maxBuffer: 1048576,
              }),
            );
          return sources.get(file);
        },
        generateBundle() {
          this.emitFile({
            type: "asset",
            fileName: "manifest.json",
            source: JSON.stringify(
              buildConnectorManifest({
                platformOrigin,
                hostRegistry: [],
                permissionRegistry: ["identity", "storage", "alarms"],
              }),
            ),
          });
        },
      },
    ],
  });
  retain("historical-product-source", {
    head: retentionProductHead,
    files: [...sources.keys()].sort(),
    sourceDigests: [...sources].map(([file, source]) => ({
      file,
      sha256: createHash("sha256").update(source).digest("hex"),
    })),
  });
  instrumentUpgradeBundle(destination, `historical-${retentionProductHead}`);
  return destination;
}
