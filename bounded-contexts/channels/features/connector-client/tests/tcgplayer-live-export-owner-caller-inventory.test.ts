import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const channels = "bounded-contexts/channels";
const deployable = "deployables/tcgplayer-connector-extension/src";
type Source = Readonly<{ path: string; source: string }>;

function sources(directory: string): Source[] {
  return readdirSync(join(root, directory)).flatMap((name) => {
    const path = `${directory}/${name}`;
    if (statSync(join(root, path)).isDirectory())
      return ["tests", "__tests__", "e2e", "node_modules"].includes(name) ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.(?:test|spec)\.tsx?$/.test(name)
      ? [{ path, source: readFileSync(join(root, path), "utf8") }]
      : [];
  });
}

/** Channels owns the executor, authority, handoff, parser and raw store; the deployable only composes them. */
function inventory(files: readonly Source[]): string[] {
  const owners: Record<string, readonly string[]> = {
    // The landed parser has exactly two production callers: manual sync and this executor.
    "parseTcgplayerFullExport(": [
      `${channels}/features/tcgplayer-csv/domain/csv.ts`,
      `${channels}/features/tcgplayer-csv/api/runtime.ts`,
      `${channels}/features/connector-client/domain/tcgplayer-live-export-executor.ts`,
    ],
    "createObjectStore(": [`${channels}/features/connector-client/integrations/connector-indexeddb.ts`],
    DownloadMyExportCSV: [`${channels}/features/connector-client/domain/live-export-authority.ts`],
    "createTcgplayerLiveExportExecutor(": [
      `${channels}/features/connector-client/domain/tcgplayer-live-export-executor.ts`,
      `${deployable}/executors.ts`,
    ],
    "createConnectorRetentionStore(": [
      `${channels}/features/connector-client/domain/connector-retention-store.ts`,
      `${deployable}/compose.ts`,
    ],
  };
  const violations: string[] = [];
  for (const [needle, allowed] of Object.entries(owners))
    for (const { path } of files.filter(({ source }) => source.includes(needle)))
      if (!allowed.includes(path)) violations.push(`${needle} ${path}`);
  for (const { path, source } of files.filter(({ path }) => path.startsWith(deployable)))
    for (const pattern of [
      /\bTextDecoder\b/,
      /\.split\(\s*["'],["']\s*\)/,
      /\bindexedDB\.open\(/,
      /\bsubtle\.(?:en|de)crypt\(/,
      /\bchrome\.downloads\b|["']downloads["']/,
      /type=Pricing|text\/csv/,
    ])
      if (pattern.test(source)) violations.push(`${pattern} ${path}`);
  return violations;
}

describe("tcgplayer-live-export-owner-caller-inventory", () => {
  const files = [...sources(channels), ...sources(deployable)];
  it("executor, authority and handoff live in the Channels connector-client domain", () => {
    for (const name of [
      "tcgplayer-live-export-executor",
      "live-export-authority",
      "live-export-handoff",
      "live-export-execution",
    ])
      expect(files.some(({ path }) => path === `${channels}/features/connector-client/domain/${name}.ts`)).toBe(true);
    const client = readFileSync(join(root, channels, "client.ts"), "utf8");
    expect(client).toContain(
      'export { createTcgplayerLiveExportExecutor } from "./features/connector-client/domain/tcgplayer-live-export-executor";',
    );
  });
  it("the deployable only composes: exact-head callers stay with their owners", () => {
    expect(inventory(files)).toEqual([]);
    expect(
      files
        .filter(({ path }) => path.startsWith(deployable))
        .map(({ path }) => path.slice(deployable.length + 1))
        .sort(),
    ).toEqual([
      "adapters/chrome-action.ts",
      "adapters/chrome-alarms.ts",
      "adapters/chrome-identity.ts",
      "adapters/chrome-indexeddb.ts",
      "adapters/chrome-listener.ts",
      "adapters/chrome-runtime.ts",
      "adapters/chrome-session.ts",
      "adapters/chrome-storage.ts",
      "adapters/connector-transport.ts",
      "background.ts",
      "chrome-globals.d.ts",
      "compose.ts",
      "executors.ts",
      "host-registry.ts",
    ]);
  });
  it.each([
    [
      "second parser",
      `${deployable}/csv.ts`,
      'export const rows = (csv: string) => csv.split("\\n").map((line) => line.split(","));',
    ],
    [
      "reused landed parser",
      `${deployable}/executors.ts`,
      "parseTcgplayerFullExport({ csv, surface: 'live' }, limits);",
    ],
    ["raw store", `${deployable}/raw.ts`, 'indexedDB.open("raw"); db.createObjectStore("raw-exports");'],
    ["plaintext cache", `${deployable}/cache.ts`, "await crypto.subtle.decrypt(algorithm, key, data);"],
    ["download API", `${deployable}/download.ts`, "chrome.downloads.download({ url });"],
    [
      "provider literal",
      `${deployable}/provider.ts`,
      'fetch("https://store.tcgplayer.com/Admin/Pricing/DownloadMyExportCSV?type=Pricing");',
    ],
  ])("a planted %s fails the inventory", (_name, path, source) => {
    expect(inventory([...files, { path, source }])).not.toEqual([]);
  });
});
