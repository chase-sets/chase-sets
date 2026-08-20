import { execFile, execFileSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(".");
const candidateHookUrl = pathToFileURL(
  path.join(repositoryRoot, "infrastructure/platform-runtime/typescript-resolver.mjs"),
).href;
const expectedCallers = Object.freeze([
  ["scripts/discovery-search-embedding-backfill.mjs", "source", 97, 177],
  ["scripts/discovery-search-relevance-embeddings.mjs", "source", 2, 1],
  ["scripts/discovery-search-relevance.mjs", "source", 12, 14],
  ["scripts/generate-agent-connector-packaging.mjs", "extension", 146, 284],
  ["scripts/representative-snapshot.mjs", "extension", 395, 1544],
  ["scripts/run-catalog-observation-pack-capture.mjs", "extension", 160, 373],
  ["scripts/run-catalog-production-completion-report.mjs", "extension", 8, 12],
  ["scripts/run-catalog-real-provider-proof.mjs", "extension", 191, 492],
  ["scripts/verify-observation-pack.mjs", "extension", 392, 1534],
]);
const PINNED_EXTENSION_LOADER_SOURCE = `import { extname } from "node:path";
export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); } catch (error) {
    const cleanSpecifier = specifier.split(/[?#]/, 1)[0] ?? specifier;
    const eligible = !extname(cleanSpecifier) &&
      (specifier.startsWith(".") || specifier.startsWith("/") || /^[A-Za-z]:[\\\\/]/.test(specifier)) &&
      (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "ERR_UNSUPPORTED_DIR_IMPORT");
    if (!eligible) throw error;
    for (const extension of [".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"]) {
      try { return await nextResolve(\`\${specifier}\${extension}\`, context); }
      catch (nextError) {
        if (nextError?.code !== "ERR_MODULE_NOT_FOUND" && nextError?.code !== "ERR_UNSUPPORTED_DIR_IMPORT") throw nextError;
      }
    }
    throw error;
  }
}
`;
const PINNED_SOURCE_LOADER_SOURCE = `export async function resolve(specifier, context, nextResolve) {
  try { return await nextResolve(specifier, context); } catch (error) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[a-z0-9]+$/iu.test(specifier)) {
      return nextResolve(\`\${specifier}.ts\`, context);
    }
    throw error;
  }
}
`;
const walkerSource = `import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(process.argv[2]);
const traversalRoot = path.resolve(process.argv[3]);
const rootUrl = pathToFileURL(traversalRoot + path.sep).href;
const entryUrl = pathToFileURL(path.resolve(process.argv[4])).href;
const queue = [entryUrl];
const seen = new Set(queue);
const edges = [];
const errors = [];

while (queue.length > 0) {
  const moduleUrl = queue.shift();
  let source;
  try {
    source = await readFile(fileURLToPath(moduleUrl), "utf8");
  } catch {
    continue;
  }
  for (const specifier of literalSpecifiers(source)) {
    if (specifier.startsWith("node:") || specifier.startsWith("data:")) continue;
    try {
      const resolved = import.meta.resolve(specifier, moduleUrl);
      edges.push({ from: moduleUrl.slice(rootUrl.length), specifier, resolved });
      if (resolved.startsWith(rootUrl) && !resolved.includes("/node_modules/") && !seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    } catch (error) {
      const code = error?.code ?? error?.name ?? null;
      edges.push({ from: moduleUrl.slice(rootUrl.length), specifier, resolved: null, code });
      errors.push({ from: moduleUrl.slice(rootUrl.length), specifier, code });
    }
  }
}

edges.sort(compareRecords);
errors.sort(compareRecords);
console.log(JSON.stringify({
  modules: [...seen].map((url) => url.slice(rootUrl.length)).sort(),
  edges,
  errors,
}));

function literalSpecifiers(source) {
  const specifiers = new Set();
  for (const match of source.matchAll(/(?:^|[\\s;{(])(?:import|export)\\s[^'"();]*?from\\s*["']([^"']+)["']/gmu)) specifiers.add(match[1]);
  for (const match of source.matchAll(/(?:^|[^.\\w])import\\s*\\(\\s*["']([^"']+)["']/gmu)) specifiers.add(match[1]);
  for (const match of source.matchAll(/^\\s*(?:import|export)\\s+["']([^"']+)["']/gmu)) specifiers.add(match[1]);
  for (const match of source.matchAll(/^\\s*export\\s+\\*\\s+from\\s*["']([^"']+)["']/gmu)) specifiers.add(match[1]);
  return [...specifiers];
}

function compareRecords(left, right) {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
`;

const temporaryRoots = [];
let harness;
let porcelainBefore;

beforeAll(async () => {
  porcelainBefore = gitPorcelain();
  expect(porcelainBefore).toBe("");
  const discovered = await discoverDirectCallers();
  expect(discovered).toEqual(expectedCallers.map(([file]) => file));
  harness = await createHarness();
});

afterAll(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TypeScript resolver caller parity", () => {
  it("requires the parent-resolution flag and records the seam's no-existence limit", async () => {
    const parentDirectory = path.join(harness.root, "supplied-parent");
    await mkdir(parentDirectory, { recursive: true });
    const parentPath = path.join(parentDirectory, "caller.mjs");
    await writeFile(parentPath, "");
    const unflagged = await runNode([harness.parentProbe, parentPath], harness.root);
    const flagged = await runNode(
      ["--experimental-import-meta-resolve", harness.parentProbe, parentPath],
      harness.root,
    );
    const withoutParentSupport = JSON.parse(unflagged.stdout.trim());
    const withParentSupport = JSON.parse(flagged.stdout.trim());

    expect(withoutParentSupport.relative).toMatch(/\/plain$/u);
    expect(withoutParentSupport.relative).not.toContain("supplied-parent");
    expect(withParentSupport.relative).toMatch(/\/supplied-parent\/plain$/u);
    expect(withParentSupport.missing).toMatch(/\/supplied-parent\/definitely-does-not-exist-xyz\.ts$/u);
    expect(await exists(path.join(parentDirectory, "definitely-does-not-exist-xyz.ts"))).toBe(false);
  });

  it("proves never-called, called, and ordinary static-import execution controls", async () => {
    const fixture = await createSentinelFixture(harness.root);

    await runNode(["--import", harness.candidateShim, fixture.conditionalCaller], harness.root);
    expect(await exists(fixture.dynamicSentinel)).toBe(false);

    const walked = await walkClosure(harness.candidateShim, fixture.conditionalCaller, harness.root);
    expect(walked.errors).toEqual([]);
    expect(walked.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          specifier: "./dynamic-target",
          resolved: expect.stringMatching(/dynamic-target\.ts$/u),
        }),
      ]),
    );
    expect(await exists(fixture.dynamicSentinel)).toBe(false);

    await runNode(
      [
        "--import",
        harness.candidateShim,
        "--input-type=module",
        "--eval",
        `const caller = await import(${JSON.stringify(pathToFileURL(fixture.conditionalCaller).href)}); await caller.run();`,
      ],
      harness.root,
    );
    expect(await readFile(fixture.dynamicSentinel, "utf8")).toBe("SENTINEL-7043-CALLER-BODY-EXECUTED");

    await runNode(["--import", harness.candidateShim, fixture.staticCaller], harness.root);
    expect(await readFile(fixture.staticSentinel, "utf8")).toBe("SENTINEL-7043-STATIC-IMPORT-EXECUTED");
  });

  it.each(expectedCallers)(
    "keeps the %s transitive resolved-URL map byte-identical",
    async (caller, predecessor, expectedModules, expectedEdges) => {
      const [before, after] = await Promise.all([
        walkClosure(harness.predecessorShims[predecessor], path.join(repositoryRoot, caller)),
        walkClosure(harness.candidateShim, path.join(repositoryRoot, caller)),
      ]);
      expect(before.errors, `${caller} predecessor errors`).toEqual([]);
      expect(after.errors, `${caller} consolidated errors`).toEqual([]);
      expect(JSON.stringify(after), caller).toBe(JSON.stringify(before));
      expect(after.modules, `${caller} module count`).toHaveLength(expectedModules);
      expect(after.edges, `${caller} edge count`).toHaveLength(expectedEdges);
    },
  );

  it("retains the extension-loader failure identity and leaves the exact-head worktree clean", async () => {
    const missingRoot = path.join(harness.root, "missing");
    await mkdir(missingRoot, { recursive: true });
    const caller = path.join(missingRoot, "caller.mjs");
    await writeFile(caller, 'await import("./genuine-miss");\n');
    const result = await runNode(["--import", harness.candidateShim, caller], harness.root, false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ERR_MODULE_NOT_FOUND");
    expect(result.stderr).toContain("genuine-miss");
    expect(result.stderr).not.toContain("genuine-miss.ts'");
    expect(gitPorcelain()).toBe(porcelainBefore);
  });
});

async function discoverDirectCallers() {
  const directRegistration = [
    "reg",
    'ister("../infrastructure/platform-runtime/typescript-resolver.mjs", import.meta.url)',
  ].join("");
  const tracked = execFileSync("git", ["ls-files", "*.mjs"], { cwd: repositoryRoot, encoding: "utf8" })
    .split(/\r?\n/u)
    .filter(Boolean);
  const matches = [];
  for (const file of tracked) {
    const source = await readFile(path.join(repositoryRoot, file), "utf8");
    if (source.includes(directRegistration)) {
      matches.push(file.replaceAll("\\", "/"));
    }
  }
  return matches.sort();
}

async function createHarness() {
  const root = await mkdtemp(path.join(tmpdir(), "typescript-resolver-parity-"));
  temporaryRoots.push(root);
  const extensionHook = path.join(root, "pinned-extension-loader.mjs");
  const sourceHook = path.join(root, "pinned-source-loader.mjs");
  const candidateShim = path.join(root, "candidate-register.mjs");
  const extensionShim = path.join(root, "extension-register.mjs");
  const sourceShim = path.join(root, "source-register.mjs");
  const walker = path.join(root, "walker.mjs");
  const parentProbe = path.join(root, "parent-probe.mjs");
  await writeFile(extensionHook, PINNED_EXTENSION_LOADER_SOURCE);
  await writeFile(sourceHook, PINNED_SOURCE_LOADER_SOURCE);
  await writeFile(candidateShim, registerShim(candidateHookUrl));
  await writeFile(extensionShim, registerShim(pathToFileURL(extensionHook).href));
  await writeFile(sourceShim, registerShim(pathToFileURL(sourceHook).href));
  await writeFile(walker, walkerSource);
  await writeFile(
    parentProbe,
    `import { pathToFileURL } from "node:url";
const parentUrl = pathToFileURL(process.argv[2]).href;
console.log(JSON.stringify({
  relative: import.meta.resolve("./plain", parentUrl),
  missing: import.meta.resolve("./definitely-does-not-exist-xyz.ts", parentUrl),
}));
`,
  );
  return {
    root,
    walker,
    parentProbe,
    candidateShim: pathToFileURL(candidateShim).href,
    predecessorShims: {
      extension: pathToFileURL(extensionShim).href,
      source: pathToFileURL(sourceShim).href,
    },
  };
}

function registerShim(hookUrl) {
  return `import { register } from "node:module";\nregister(${JSON.stringify(hookUrl)}, import.meta.url);\n`;
}

async function walkClosure(registerShimPath, callerPath, traversalRoot = repositoryRoot) {
  const result = await runNode(
    [
      "--experimental-import-meta-resolve",
      "--import",
      registerShimPath,
      harness.walker,
      repositoryRoot,
      traversalRoot,
      callerPath,
    ],
    repositoryRoot,
  );
  return JSON.parse(result.stdout.trim());
}

async function createSentinelFixture(root) {
  const directory = path.join(root, "sentinel");
  await mkdir(directory, { recursive: true });
  const dynamicSentinel = path.join(directory, "SENTINEL-7043-CALLER-BODY-EXECUTED.txt");
  const staticSentinel = path.join(directory, "SENTINEL-7043-STATIC-IMPORT-EXECUTED.txt");
  const dynamicTarget = path.join(directory, "dynamic-target.ts");
  const staticTarget = path.join(directory, "static-target.ts");
  const conditionalCaller = path.join(directory, "conditional-caller.mjs");
  const staticCaller = path.join(directory, "static-caller.mjs");
  await writeFile(
    dynamicTarget,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(dynamicSentinel)}, "SENTINEL-7043-CALLER-BODY-EXECUTED");\n`,
  );
  await writeFile(
    staticTarget,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(staticSentinel)}, "SENTINEL-7043-STATIC-IMPORT-EXECUTED");\n`,
  );
  await writeFile(conditionalCaller, 'export async function run() { await import("./dynamic-target"); }\n');
  await writeFile(staticCaller, 'import "./static-target";\n');
  await unlink(dynamicSentinel).catch(() => undefined);
  await unlink(staticSentinel).catch(() => undefined);
  return { conditionalCaller, staticCaller, dynamicSentinel, staticSentinel };
}

async function exists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function runNode(arguments_, cwd, expectSuccess = true) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, arguments_, {
      cwd,
      encoding: "utf8",
      env: process.env,
    });
    const result = { status: 0, stdout, stderr };
    if (expectSuccess) expect(stderr).toBe("");
    return result;
  } catch (error) {
    const result = { status: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    if (expectSuccess) throw new Error(`Node child failed (${arguments_.join(" ")}):\n${result.stderr}`);
    return result;
  }
}

function gitPorcelain() {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}
