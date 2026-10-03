import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHarness,
  discoverDirectCallers,
  exists,
  runNode,
  walkClosure as walk,
} from "./lib/typescript-resolver-caller-harness.mjs";
import {
  loadManifests,
  checkCaller,
  processManifests,
  serializeManifest,
  normalizeGraph,
  validateParity,
  manifestDirectory,
} from "./typescript-resolver-caller-manifest.mjs";
const repositoryRoot = path.resolve(".");
const temporaryRoots = [];
const manifests = await loadManifests(repositoryRoot);
let harness;
let porcelainBefore;
const walkClosure = (shim, caller, root) => walk(harness, shim, caller, root);
beforeAll(async () => {
  porcelainBefore = gitPorcelain();
  expect(porcelainBefore).toBe("");
  const discovered = await discoverDirectCallers(repositoryRoot);
  expect(discovered).toEqual(manifests.map(({ caller }) => caller).sort());
  harness = await createHarness(repositoryRoot);
  temporaryRoots.push(harness.root);
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

  it.each(manifests)("keeps $caller exact against its manifest and independent predecessor", async (manifest) => {
    await checkCaller(harness, manifest);
  });

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

describe("Resolver caller manifest detection", () => {
  let fixture;
  beforeAll(async () => {
    fixture = await createGraphRepository("shared");
  });

  it.each(["dropped module", "extra edge", "stale manifest target with unchanged counts"])(
    "rejects the %s mutant through the real read-only check and restores green",
    async (name) => {
      const file =
        name === "dropped module"
          ? path.join(fixture, "graph/hub.ts")
          : name === "extra edge"
            ? path.join(fixture, "scripts/left.mjs")
            : path.join(fixture, manifestDirectory, "left.manifest");
      const original = await readFile(file, "utf8");
      if (name === "dropped module") await writeFile(file, original.replace('import "./z";\n', ""));
      else if (name === "extra edge") await writeFile(file, original + 'import "../graph/a";\n');
      else {
        const manifest = (await loadManifests(fixture))[0];
        manifest.graphs.candidate.edges[0].resolved = "repo:/stale.ts";
        await writeFile(file, serializeManifest(manifest));
      }
      try {
        const result = await runNode(
          [path.join(repositoryRoot, "scripts/typescript-resolver-caller-manifest.mjs"), "--check", "--root", fixture],
          repositoryRoot,
          false,
        );
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("scripts/left.mjs: stale manifest");
        retainEvidence(`mutant-${name.replaceAll(" ", "-")}.txt`, JSON.stringify(result));
      } finally {
        await writeFile(file, original);
      }
      await processManifests(fixture, "--check");
    },
  );

  it("rejects missing, unknown and duplicate manifests in both modes", async () => {
    const file = path.join(fixture, manifestDirectory, "left.manifest");
    const original = await readFile(file, "utf8");
    await unlink(file);
    for (const mode of ["--check", "--write"])
      await expect(processManifests(fixture, mode)).rejects.toThrow("coverage");
    await writeFile(file, original);
    const unknown = path.join(fixture, manifestDirectory, "unknown.manifest");
    const unknownManifest = (await loadManifests(fixture))[0];
    unknownManifest.caller = "scripts/unknown.mjs";
    await writeFile(unknown, serializeManifest(unknownManifest));
    for (const mode of ["--check", "--write"])
      await expect(processManifests(fixture, mode)).rejects.toThrow("coverage");
    await unlink(unknown);
    await writeFile(file, original + '["caller","scripts/left.mjs"]\n');
    for (const mode of ["--check", "--write"])
      await expect(processManifests(fixture, mode)).rejects.toThrow("duplicate");
    await writeFile(file, original);
  });

  it("requires caller-owned predecessor and check metadata even in write mode", async () => {
    const file = path.join(fixture, manifestDirectory, "left.manifest");
    const original = await readFile(file, "utf8");
    for (const key of ["predecessor", "check"]) {
      const withoutMetadata =
        original
          .trimEnd()
          .split("\n")
          .filter((line) => JSON.parse(line)[0] !== key)
          .join("\n") + "\n";
      await writeFile(file, withoutMetadata);
      for (const mode of ["--check", "--write"])
        await expect(processManifests(fixture, mode)).rejects.toThrow(`missing/invalid ${key}`);
      await writeFile(file, original);
    }
  });

  it("discovers a realistically named new sibling and never invents its metadata", async () => {
    const sibling = "scripts/run-catalog-new-proof.mjs";
    await writeFile(path.join(fixture, sibling), callerSource("../graph/hub"));
    git(fixture, "add", sibling);
    expect(await discoverDirectCallers(fixture)).toContain(sibling);
    for (const mode of ["--check", "--write"])
      await expect(processManifests(fixture, mode)).rejects.toThrow("coverage");
    git(fixture, "rm", "-f", sibling);
    await processManifests(fixture, "--check");
  });

  it("write mode cannot bless candidate-only predecessor divergence", async () => {
    const file = path.join(fixture, "scripts/left.mjs");
    const original = await readFile(file, "utf8");
    const manifestFile = path.join(fixture, manifestDirectory, "left.manifest");
    const manifest = (await loadManifests(fixture))[0];
    manifest.predecessor = "source";
    const saved = await readFile(manifestFile, "utf8");
    await writeFile(manifestFile, serializeManifest(manifest));
    await mkdir(path.join(fixture, "graph/directory"));
    await writeFile(path.join(fixture, "graph/directory/index.ts"), "export {};\n");
    await writeFile(file, original + 'import "../graph/directory";\n');
    for (const mode of ["--check", "--write"])
      await expect(processManifests(fixture, mode)).rejects.toThrow(
        "scripts/left.mjs: predecessor/consolidated divergence",
      );
    expect(await readFile(manifestFile, "utf8")).toBe(serializeManifest(manifest));
    await writeFile(file, original);
    await writeFile(manifestFile, saved);
    await processManifests(fixture, "--check");
  });

  it("rejects forbidden backfill target changes and a newly present absent sibling", async () => {
    const manifest = manifests.find(({ check }) => check === "backfill-widening");
    const caller = path.join(repositoryRoot, manifest.caller);
    const before = await walkClosure(harness.predecessorShims.source, caller);
    const after = await walkClosure(harness.candidateShim, caller);
    const mutated = structuredClone(after);
    mutated.edges.find((edge) => edge.specifier === "./public-event-payloads").resolved = "file:///forbidden.ts";
    await expect(validateParity(repositoryRoot, manifest, before, mutated)).rejects.toThrow("target");
    const fakeRoot = await temporaryDirectory();
    await mkdir(path.join(fakeRoot, "contracts/event-core"), { recursive: true });
    const sibling = path.join(fakeRoot, "contracts/event-core/public-event-payloads.ts");
    const relocated = (graph) => ({
      ...graph,
      edges: graph.edges.map((edge) => ({
        ...edge,
        resolved: edge.resolved.replace(
          pathToFileURL(repositoryRoot + path.sep).href,
          pathToFileURL(fakeRoot + path.sep).href,
        ),
      })),
    });
    await writeFile(sibling, "export {};\n");
    await expect(validateParity(fakeRoot, manifest, relocated(before), relocated(after))).rejects.toThrow(
      "forbidden backfill sibling",
    );
  });

  it("normalizes Windows and POSIX checkout URLs without losing records or multiplicity", () => {
    const graph = (root) => ({
      modules: ["scripts/a.mjs"],
      edges: [
        { from: "scripts/a.mjs", specifier: "../a?x#y", resolved: `${root}a.ts?x#y` },
        { from: "scripts/a.mjs", specifier: "../a?x#y", resolved: `${root}a.ts?x#y` },
        { from: "scripts/a.mjs", specifier: "pkg", resolved: "node:fs" },
      ],
      errors: [{ from: "scripts/a.mjs", specifier: "missing", code: "ERR_MODULE_NOT_FOUND" }],
    });
    const win = "file:///D:/a%20checkout/";
    const posix = "file:///tmp/a%20checkout/";
    const normalized = normalizeGraph(graph(win), win);
    expect(normalized).toEqual(normalizeGraph(graph(posix), posix));
    expect(normalized.edges).toHaveLength(3);
    expect(normalized.edges[0].resolved).toBe("repo:/a.ts?x#y");
    expect(normalized.errors[0].code).toBe("ERR_MODULE_NOT_FOUND");
  });

  it("write mode refuses a forbidden additional backfill target change without writing", async () => {
    const root = await temporaryDirectory();
    for (const directory of [
      manifestDirectory,
      "infrastructure/platform-runtime",
      "contracts/event-core/public-event-payloads",
      "contracts/event-core/forbidden",
    ]) {
      await mkdir(path.join(root, directory), { recursive: true });
    }
    await writeFile(
      path.join(root, "infrastructure/platform-runtime/typescript-resolver.mjs"),
      await readFile(path.join(repositoryRoot, "infrastructure/platform-runtime/typescript-resolver.mjs")),
    );
    await writeFile(
      path.join(root, "scripts/discovery-search-embedding-backfill.mjs"),
      callerSource("../contracts/event-core/index"),
    );
    await writeFile(
      path.join(root, "contracts/event-core/index.ts"),
      'import "./public-event-payloads";\nimport "./test-support";\n',
    );
    await writeFile(path.join(root, "contracts/event-core/test-support.ts"), 'import "./public-event-payloads";\n');
    for (const directory of ["public-event-payloads", "forbidden"])
      await writeFile(path.join(root, `contracts/event-core/${directory}/index.ts`), "export {};\n");
    const file = path.join(root, manifestDirectory, "discovery-search-embedding-backfill.manifest");
    await writeFile(
      file,
      serializeManifest({
        caller: "scripts/discovery-search-embedding-backfill.mjs",
        predecessor: "source",
        check: "backfill-widening",
        graphs: {},
      }),
    );
    git(root, "init", "-b", "baseline");
    git(root, "add", ".");
    await manifestCli(root, "--write");
    const before = await readFile(file, "utf8");
    await writeFile(
      path.join(root, "contracts/event-core/test-support.ts"),
      'import "./public-event-payloads";\nimport "./forbidden";\n',
    );
    for (const mode of ["--check", "--write"])
      await expect(processManifests(root, mode)).rejects.toThrow("forbidden backfill target changes");
    expect(await readFile(file, "utf8")).toBe(before);
    await writeFile(path.join(root, "contracts/event-core/test-support.ts"), 'import "./public-event-payloads";\n');
    await processManifests(root, "--check");
  });

  it("writes deterministically twice and repeated checks leave tracked bytes unchanged", async () => {
    const before = await manifestBytes(fixture);
    await processManifests(fixture, "--write");
    const first = await manifestBytes(fixture);
    await processManifests(fixture, "--write");
    expect(await manifestBytes(fixture)).toEqual(first);
    expect(first).toEqual(before);
    await processManifests(fixture, "--check");
    await processManifests(fixture, "--check");
    expect(await manifestBytes(fixture)).toEqual(before);
    expect(git(fixture, "diff", "--exit-code")).toBe("");
  });
});

describe("Baseline shared-row collision red control", () => {
  let fixture;
  let baseline;
  beforeAll(async () => {
    fixture = await createGraphRepository("shared");
    await writeLegacyPins(fixture);
    git(fixture, "add", ".");
    git(fixture, "commit", "-m", "baseline rows");
    baseline = git(fixture, "rev-parse", "HEAD").trim();
  });
  it.each(["b", "v"])("recounts the old row format for independent addition %s", async (addition) => {
    git(fixture, "switch", "-c", addition, baseline);
    await addGraphModule(fixture, "shared", addition);
    await manifestCli(fixture, "--write");
    await writeLegacyPins(fixture);
    git(fixture, "add", ".");
    git(fixture, "commit", "-m", addition);
    retainEvidence(`baseline-${addition}.patch`, git(fixture, "show", "--format=", "HEAD"));
  });
  it("reproduces a textual conflict in the baseline parity rows", () => {
    const result = gitResult(fixture, "merge", "--no-edit", "b");
    retainEvidence("baseline-conflict.txt", JSON.stringify(result));
    expect(result.status).not.toBe(0);
    expect(git(fixture, "diff", "--name-only", "--diff-filter=U")).toContain(
      "scripts/typescript-resolver-caller-parity.test.mjs",
    );
    retainEvidence(
      "baseline-conflict.patch",
      git(fixture, "diff", "--", "scripts/typescript-resolver-caller-parity.test.mjs"),
    );
    git(fixture, "merge", "--abort");
  });
});

for (const shape of ["shared", "disjoint"]) {
  describe(`Independent ${shape} caller additions`, () => {
    let fixture;
    let baseline;
    beforeAll(async () => {
      fixture = await createGraphRepository(shape);
      baseline = git(fixture, "rev-parse", "HEAD").trim();
    });
    it.each(["b", "v"])("generates the %s branch with the real write mode", async (addition) => {
      git(fixture, "switch", "-c", addition, baseline);
      await addGraphModule(fixture, shape, addition);
      await manifestCli(fixture, "--write");
      const touched = git(fixture, "diff", "--name-only").trim().split(/\r?\n/u);
      expect(touched).not.toContain("scripts/typescript-resolver-caller-parity.test.mjs");
      expect(touched.filter((file) => file.endsWith(".manifest"))).toEqual(
        shape === "shared"
          ? [
              "scripts/typescript-resolver-caller-manifests/left.manifest",
              "scripts/typescript-resolver-caller-manifests/right.manifest",
            ]
          : [`scripts/typescript-resolver-caller-manifests/${addition === "b" ? "left" : "right"}.manifest`],
      );
      git(fixture, "add", ".");
      git(fixture, "commit", "-m", addition);
      retainEvidence(`${shape}-${addition}.patch`, git(fixture, "show", "--format=", "HEAD"));
    });
    it.each([
      ["b", "v"],
      ["v", "b"],
    ])("merges %s then %s without conflict and checks the final graphs", async (first, second) => {
      git(fixture, "switch", "-c", `merge-${first}`, first);
      const result = gitResult(fixture, "merge", "--no-edit", second);
      retainEvidence(`${shape}-${first}-${second}-merge.txt`, JSON.stringify(result));
      expect(result.status).toBe(0);
      await manifestCli(fixture, "--check");
      const final = await manifestBytes(fixture);
      retainEvidence(`${shape}-${first}-${second}-checked.json`, JSON.stringify(final));
      expect(git(fixture, "status", "--porcelain")).toBe("");
    });
  });
}

async function temporaryDirectory() {
  const root = await mkdtemp(path.join(tmpdir(), "resolver-caller-manifests-"));
  temporaryRoots.push(root);
  return root;
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitResult(root, ...args) {
  try {
    return { status: 0, stdout: git(root, ...args) };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout), stderr: String(error.stderr) };
  }
}

function callerSource(target) {
  const registration = [
    "reg",
    'ister("../infrastructure/platform-runtime/typescript-resolver.mjs", import.meta.url);',
  ].join("");
  return `import { register } from "node:module";\n${registration}\nawait import(${JSON.stringify(target)});\n`;
}

const anchors = ["a", "c", "e", "g", "i", "m", "q", "u", "w", "z"];
async function createGraphRepository(shape) {
  const root = await temporaryDirectory();
  for (const directory of ["scripts", manifestDirectory, "graph", "infrastructure/platform-runtime"])
    await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(
    path.join(root, "infrastructure/platform-runtime/typescript-resolver.mjs"),
    await readFile(path.join(repositoryRoot, "infrastructure/platform-runtime/typescript-resolver.mjs")),
  );
  for (const anchor of anchors) await writeFile(path.join(root, `graph/${anchor}.ts`), "export {};\n");
  const source = anchors.map((anchor) => `import "./${anchor}";`).join("\n") + "\n";
  await writeFile(path.join(root, "graph/hub.ts"), source);
  if (shape === "disjoint") await writeFile(path.join(root, "graph/other-hub.ts"), source);
  for (const caller of ["left", "right"]) {
    await writeFile(
      path.join(root, `scripts/${caller}.mjs`),
      callerSource(`../graph/${shape === "disjoint" && caller === "right" ? "other-hub" : "hub"}`),
    );
    await writeFile(
      path.join(root, manifestDirectory, `${caller}.manifest`),
      serializeManifest({
        caller: `scripts/${caller}.mjs`,
        predecessor: "extension",
        check: "byte-identical",
        graphs: {},
      }),
    );
  }
  git(root, "init", "-b", "baseline");
  git(root, "config", "user.name", "Resolver parity fixture");
  git(root, "config", "user.email", "resolver-parity@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "add", ".");
  await manifestCli(root, "--write");
  git(root, "add", ".");
  git(root, "commit", "-m", "baseline");
  return root;
}

async function addGraphModule(root, shape, addition) {
  const hub = path.join(root, `graph/${shape === "disjoint" && addition === "v" ? "other-hub" : "hub"}.ts`);
  const specifiers = (await readFile(hub, "utf8")).trim().split("\n");
  specifiers.push(`import "./${addition}";`);
  await writeFile(hub, specifiers.sort().join("\n") + "\n");
  await writeFile(path.join(root, `graph/${addition}.ts`), addition === "v" ? 'import "./a";\n' : "export {};\n");
}

async function manifestCli(root, mode) {
  return runNode(
    [path.join(repositoryRoot, "scripts/typescript-resolver-caller-manifest.mjs"), mode, "--root", root],
    repositoryRoot,
  );
}

async function manifestBytes(root) {
  const result = {};
  for (const manifest of await loadManifests(root))
    result[manifest.file] = await readFile(path.join(root, manifestDirectory, manifest.file), "utf8");
  return result;
}

async function writeLegacyPins(root) {
  const manifests = await loadManifests(root);
  const rows = manifests.map(
    (manifest) =>
      `  [${JSON.stringify(manifest.caller)}, ${JSON.stringify(manifest.predecessor)}, ${manifest.graphs.candidate.modules.length}, ${manifest.graphs.candidate.edges.length}],`,
  );
  await writeFile(
    path.join(root, "scripts/typescript-resolver-caller-parity.test.mjs"),
    `const expectedCallers = Object.freeze([\n${rows.join("\n")}\n]);\n`,
  );
}

function retainEvidence(file, text) {
  const directory = process.env.CHASE_SETS_RESOLVER_PARITY_EVIDENCE;
  if (directory) writeFileSync(path.join(directory, file), text);
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

function gitPorcelain() {
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}
