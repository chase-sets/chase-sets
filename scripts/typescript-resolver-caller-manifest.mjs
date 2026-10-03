import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import { acquireHeavySlot } from "./lib/heavy-slot.mjs";
import {
  createHarness,
  discoverDirectCallers,
  exists,
  walkClosure,
} from "./lib/typescript-resolver-caller-harness.mjs";

export const manifestDirectory = "scripts/typescript-resolver-caller-manifests";
const backfillCaller = "scripts/discovery-search-embedding-backfill.mjs";
const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const recordOrder = (left, right) => compare(JSON.stringify(left), JSON.stringify(right));
const edgeKey = ({ from, specifier }) => `${from}|${specifier}`;

export function dependencyDirectoryMap(snapshotKeys, maxLength) {
  assert(Number.isInteger(maxLength) && maxLength > 33, "invalid pnpm virtual-store directory length");
  const directories = new Map();
  for (const snapshot of snapshotKeys) {
    // pnpm 11's directory encoding is host-dependent; the full lock snapshot is not.
    let filename = snapshot.replace(/^\//u, "").replace(/[\\/:*?"<>|#]/gu, "+");
    if (filename.includes("(")) filename = filename.replace(/\)$/u, "").replace(/\)\(|\(|\)/gu, "_");
    if (filename.length > maxLength || (filename !== filename.toLowerCase() && !filename.startsWith("file+"))) {
      const hash = createHash("sha256").update(filename).digest("hex").slice(0, 32);
      filename = `${filename.slice(0, maxLength - 33)}_${hash}`;
    }
    assert(!directories.has(filename), `ambiguous pnpm dependency directory: ${filename}`);
    directories.set(filename, snapshot);
  }
  return directories;
}

export function normalizeGraph(graph, rootUrl, dependencyDirectories = new Map()) {
  const normalizeUrl = (url) => {
    if (typeof url !== "string" || !url.startsWith(rootUrl)) return url;
    let relative = url.slice(rootUrl.length);
    const dependency = /^node_modules\/\.pnpm\/([^/]+)(\/node_modules\/.*)$/u.exec(relative);
    if (dependency) {
      const snapshot = dependencyDirectories.get(decodeURIComponent(dependency[1]));
      assert(snapshot, `unknown pnpm dependency directory: ${dependency[1]}`);
      relative = `node_modules/.pnpm/${encodeURIComponent(snapshot)}${dependency[2]}`;
    }
    return `repo:/${relative}`;
  };
  return {
    modules: [...graph.modules].sort(compare),
    edges: graph.edges.map((edge) => ({ ...edge, resolved: normalizeUrl(edge.resolved) })).sort(recordOrder),
    errors: [...graph.errors].sort(recordOrder),
  };
}

export function serializeManifest(manifest) {
  const records = [
    ["caller", manifest.caller],
    ["predecessor", manifest.predecessor],
    ["check", manifest.check],
  ];
  for (const [name, graph] of Object.entries(manifest.graphs)) {
    for (const kind of ["modules", "edges", "errors"]) {
      for (const record of graph[kind]) records.push([name, kind, record]);
    }
  }
  return `${records
    .map((record) => JSON.stringify(record))
    .sort(compare)
    .join("\n")}\n`;
}

function parseManifest(text, file) {
  const manifest = { file, graphs: {} };
  for (const line of text.trimEnd().split("\n")) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      throw new Error(`${file}: invalid manifest record`);
    }
    assert(Array.isArray(record), `${file}: record must be an array`);
    const [name, kind, value] = record;
    if (["caller", "predecessor", "check"].includes(name)) {
      assert(
        record.length === 2 && typeof kind === "string" && !Object.hasOwn(manifest, name),
        `${file}: duplicate/invalid ${name}`,
      );
      manifest[name] = kind;
    } else {
      assert(
        ["candidate", "source"].includes(name) && ["modules", "edges", "errors"].includes(kind) && record.length === 3,
        `${file}: unknown graph record`,
      );
      const graph = (manifest.graphs[name] ??= { modules: [], edges: [], errors: [] });
      graph[kind].push(value);
    }
  }
  assert(/^scripts\/[a-z0-9-]+\.mjs$/u.test(manifest.caller), `${file}: invalid caller`);
  assert(
    path.basename(file) === `${path.basename(manifest.caller, ".mjs")}.manifest`,
    `${file}: filename does not match ${manifest.caller}`,
  );
  assert(["extension", "source"].includes(manifest.predecessor), `${manifest.caller}: missing/invalid predecessor`);
  assert(
    ["byte-identical", "backfill-widening"].includes(manifest.check),
    `${manifest.caller}: missing/invalid check class`,
  );
  assert(
    (manifest.check === "backfill-widening") === (manifest.caller === backfillCaller),
    `${manifest.caller}: forbidden check class`,
  );
  assert(
    manifest.check !== "backfill-widening" || manifest.predecessor === "source",
    `${manifest.caller}: backfill requires source predecessor`,
  );
  const expectedGraphs = manifest.check === "backfill-widening" ? ["candidate", "source"] : ["candidate"];
  // Metadata-only files explicitly enroll a caller for write mode, never for check mode.
  assert(
    Object.keys(manifest.graphs).length === 0 ||
      JSON.stringify(Object.keys(manifest.graphs).sort()) === JSON.stringify(expectedGraphs),
    `${manifest.caller}: invalid graph coverage`,
  );
  assert(serializeManifest(manifest) === text, `${manifest.caller}: manifest records are not canonical`);
  return manifest;
}

export async function loadManifests(root) {
  const directory = path.join(root, manifestDirectory);
  const files = (await readdir(directory)).sort(compare);
  const manifests = [];
  for (const file of files) {
    assert(file.endsWith(".manifest"), `${manifestDirectory}/${file}: unknown manifest`);
    manifests.push(parseManifest(await readFile(path.join(directory, file), "utf8"), file));
  }
  const callers = manifests.map(({ caller }) => caller).sort(compare);
  assert.deepEqual(
    callers,
    await discoverDirectCallers(root),
    "resolver caller manifest coverage (missing, unknown or duplicate caller)",
  );
  return manifests;
}

export async function validateParity(root, manifest, before, after) {
  const label = manifest.caller;
  assert.deepEqual(before.errors, [], `${label}: predecessor errors`);
  assert.deepEqual(after.errors, [], `${label}: consolidated errors`);
  if (manifest.check === "byte-identical") {
    assert.equal(JSON.stringify(after), JSON.stringify(before), `${label}: predecessor/consolidated divergence`);
    return;
  }
  assert.notEqual(JSON.stringify(after), JSON.stringify(before), `${label}: source-only equality must stay red`);
  const sourceEdges = new Map(before.edges.map((edge) => [edgeKey(edge), edge]));
  const candidateEdges = new Map(after.edges.map((edge) => [edgeKey(edge), edge]));
  const changed = [...sourceEdges]
    .filter(
      ([key, edge]) => candidateEdges.has(key) && JSON.stringify(edge) !== JSON.stringify(candidateEdges.get(key)),
    )
    .map(([key]) => key)
    .sort(compare);
  const targets = [
    "contracts/event-core/index.ts|./public-event-payloads",
    "contracts/event-core/test-support.ts|./public-event-payloads",
  ];
  assert.deepEqual(changed, targets, `${label}: forbidden backfill target changes`);
  assert.deepEqual(
    [...sourceEdges.keys()].filter((key) => !candidateEdges.has(key)),
    [],
    `${label}: lost backfill edges`,
  );
  for (const key of targets) {
    assert.equal(
      sourceEdges.get(key).resolved,
      pathToFileURL(path.join(root, "contracts/event-core/public-event-payloads.ts")).href,
      `${label}: ${key} source-only target`,
    );
    assert.equal(
      candidateEdges.get(key).resolved,
      pathToFileURL(path.join(root, "contracts/event-core/public-event-payloads/index.ts")).href,
      `${label}: ${key} consolidated target`,
    );
  }
  assert.equal(
    await exists(path.join(root, "contracts/event-core/public-event-payloads.ts")),
    false,
    `${label}: forbidden backfill sibling`,
  );
}

export async function collectCaller(harness, manifest) {
  const root = harness.repositoryRoot;
  const caller = path.join(root, manifest.caller);
  const [before, after] = await Promise.all([
    walkClosure(harness, harness.predecessorShims[manifest.predecessor], caller),
    walkClosure(harness, harness.candidateShim, caller),
  ]);
  await validateParity(root, manifest, before, after);
  const rootUrl = pathToFileURL(root + path.sep).href;
  let dependencyDirectories;
  if (
    [before, after].some((graph) =>
      graph.edges.some((edge) => edge.resolved?.startsWith(`${rootUrl}node_modules/.pnpm/`)),
    )
  ) {
    const lock = parse(await readFile(path.join(root, "pnpm-lock.yaml"), "utf8"));
    const modules = parse(await readFile(path.join(root, "node_modules/.modules.yaml"), "utf8"));
    dependencyDirectories = dependencyDirectoryMap(Object.keys(lock.snapshots), modules.virtualStoreDirMaxLength);
  }
  const graphs = { candidate: normalizeGraph(after, rootUrl, dependencyDirectories) };
  if (manifest.check === "backfill-widening") graphs.source = normalizeGraph(before, rootUrl, dependencyDirectories);
  return { ...manifest, graphs };
}

export async function checkCaller(harness, manifest) {
  const actual = await collectCaller(harness, manifest);
  assert.equal(
    serializeManifest(actual),
    serializeManifest(manifest),
    `${manifest.caller}: stale manifest (exact modules/edges/errors)`,
  );
  return actual;
}

export async function processManifests(root, mode) {
  assert(["--check", "--write"].includes(mode), "expected --check or --write");
  const manifests = await loadManifests(root);
  const harness = await createHarness(root);
  try {
    // Validate every independent oracle before writing any expectation.
    const actual = [];
    for (const manifest of manifests) actual.push(await collectCaller(harness, manifest));
    for (let index = 0; index < manifests.length; index += 1) {
      const text = serializeManifest(actual[index]);
      if (mode === "--check") {
        assert.equal(
          text,
          serializeManifest(manifests[index]),
          `${manifests[index].caller}: stale manifest (exact modules/edges/errors)`,
        );
      } else {
        await writeFile(path.join(root, manifestDirectory, manifests[index].file), text);
      }
    }
    return actual;
  } finally {
    await rm(harness.root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  acquireHeavySlot("script-battery");
  const [mode, rootFlag, rootValue, ...extra] = process.argv.slice(2);
  try {
    assert(
      extra.length === 0 && (rootFlag === undefined || (rootFlag === "--root" && rootValue)),
      "usage: --check|--write [--root <checkout>]",
    );
    const root = path.resolve(rootValue ?? ".");
    const manifests = await processManifests(root, mode);
    console.log(`Resolver caller manifests ${mode.slice(2)}: ${manifests.length} callers`);
  } catch (error) {
    console.error(error.message.split("\n")[0]);
    process.exitCode = 1;
  }
}
