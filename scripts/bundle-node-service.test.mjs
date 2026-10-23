import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleNodeService as bundle } from "./bundle-node-service.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const timingReceiptPath = path.join(repoRoot, "scripts/bundle-node-service-timing-receipt.json");
const roots = [];
let timings;
beforeEach(() => {
  timings = Object.fromEntries(
    ["fixtureCreation", "fixtureCopy", "bundleNodeService", "childNode"].map((step) => [
      step,
      { calls: 0, elapsedMs: 0 },
    ]),
  );
});

async function timed(step, action) {
  const entry = timings[step];
  entry.calls++;
  const start = performance.now();
  try {
    return await action();
  } finally {
    entry.elapsedMs += performance.now() - start;
  }
}

const bundleNodeService = (options) => timed("bundleNodeService", () => bundle(options));
function startNode(...args) {
  const start = performance.now();
  try {
    return execFileSync(...args);
  } finally {
    timings.childNode = { calls: 1, elapsedMs: performance.now() - start };
  }
}
const assetSource = "bounded-contexts/platform-operations/features/support-requests/api/evidence-canonicalization.ts";
const baselineScriptDigests = {
  "platform-api": "31f5eb2543bd4855b0a1eac5b488b2706258a3d421987a5bda28a30f4ca3552c",
  "platform-worker": "b968c49f7ec21e7b2ddd4ee0f390f422cdbd408dc108e12bd61f8db83fcf7eac",
};

async function put(root, name, contents) {
  await timed("fixtureCreation", async () => {
    const target = path.join(root, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  });
}

async function fixture(name = "platform-api") {
  const root = await mkdtemp(path.join(tmpdir(), "bundle-node-service-"));
  roots.push(root);
  const service = `deployables/${name}`;
  await put(root, "package.json", JSON.stringify({ type: "module" }));
  await put(
    root,
    `${service}/src/observability-prelude.ts`,
    "globalThis.preludeRuns = (globalThis.preludeRuns ?? 0) + 1;\n",
  );
  await put(root, `${service}/src/main.ts`, 'import "./observability-prelude";\nconsole.log("service started");\n');
  return { root, service, dist: path.join(root, service, "dist"), name };
}

afterEach(async (context) => {
  if (process.env.CHASE_BUNDLE_TIMINGS === "1") {
    console.log("bundle-test-timing/v1", JSON.stringify({ test: context.task.name, steps: timings }));
  }
  // Only directories returned by mkdtemp above are removed.
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bundle-node-service", () => {
  it("records the six baseline timeout cases", async () => {
    const receipt = JSON.parse(await readFile(timingReceiptPath, "utf8"));
    expect(receipt.baselineEvidence.parallel).toMatchObject({ timeoutCases: 6, totalCases: 9 });
    expect(receipt.baselineEvidence.fileSerialSingleWorker).toMatchObject({
      thirdPartyExternalResolution: "timeout",
    });
  });

  it("attributes bundle test work before and after repair", async () => {
    const receipt = JSON.parse(await readFile(timingReceiptPath, "utf8"));
    expect(receipt.schemaVersion).toBe("bundle-node-service-timing/v1");
    expect(receipt.vitestTimeoutMs).toBe(5000);
    expect(receipt.baselineEvidence.parallel.timeoutCases).toBe(6);
    expect(receipt.baselineEvidence.fileSerialSingleWorker.thirdPartyExternalResolution).toBe("timeout");
    expect(receipt.repeatedWorkMeasurement.dominantCost).toBe("bundleNodeService");
    expect(receipt.repeatedWorkMeasurement.runs).toHaveLength(2);
    for (const run of receipt.repeatedWorkMeasurement.runs) {
      expect(run.cases).toHaveLength(6);
      for (const sample of run.cases) {
        expect(Object.keys(sample.steps)).toEqual(["fixtureCreation", "fixtureCopy", "bundleNodeService", "childNode"]);
        expect(sample.steps.bundleNodeService.calls).toBe(1);
        expect(sample.steps.fixtureCreation.calls).toBeGreaterThan(0);
      }
    }
    expect(receipt.repair.status).toBe("not-established");
  });

  it("start:production runs the prebuilt bundle and other deployable scripts are unchanged", async () => {
    for (const [name, digest] of Object.entries(baselineScriptDigests)) {
      const manifest = JSON.parse(await readFile(path.join(repoRoot, "deployables", name, "package.json"), "utf8"));
      expect(manifest.scripts["start:production"]).toBe("node --enable-source-maps dist/main.js");
      expect(manifest.scripts.build).toBe(`node ../../scripts/bundle-node-service.mjs ${name}`);
      const unchanged = Object.entries(manifest.scripts)
        .filter(([key]) => key !== "build" && key !== "start:production")
        .map(([key, value]) => `${key}=${value}\n`)
        .join("");
      expect(createHash("sha256").update(unchanged).digest("hex")).toBe(digest);
    }
  });

  it.each(["platform-api", "platform-worker"])(
    "evaluates the observability prelude before any third-party module (%s)",
    async (name) => {
      const f = await fixture(name);
      await put(
        f.root,
        `${f.service}/node_modules/instrumented/package.json`,
        '{"type":"module","exports":"./index.js"}',
      );
      await put(
        f.root,
        `${f.service}/node_modules/instrumented/index.js`,
        'if (globalThis.preludeRuns !== 1) throw new Error("instrumentation must run exactly once before dependencies"); console.log("patched");',
      );
      await put(
        f.root,
        `${f.service}/src/main.ts`,
        'import "./observability-prelude"; import "instrumented"; console.log("started");',
      );
      const { metafile } = await bundleNodeService({ repoRoot: f.root, deployable: name });
      const launcher = await readFile(path.join(f.dist, "main.js"), "utf8");
      expect(launcher).toBe('import "./observability-prelude.js";\nawait import("./service.js");\n');
      const prelude = Object.values(metafile.outputs).find((output) =>
        output.entryPoint?.endsWith("observability-prelude.ts"),
      );
      expect(prelude.imports.filter((edge) => edge.path.includes("instrumented"))).toEqual([]);
      expect(startNode(process.execPath, [path.join(f.dist, "main.js")], { encoding: "utf8", timeout: 30_000 })).toBe(
        "patched\nstarted\n",
      );
    },
  );

  it("keeps third-party packages external at the path each importer resolves", async () => {
    const f = await fixture();
    for (const [workspace, version] of [
      [f.service, "one"],
      ["infrastructure/adapter", "two"],
    ]) {
      await put(
        f.root,
        `${workspace}/node_modules/versioned/package.json`,
        '{"type":"module","exports":{"import":"./import.js","require":"./require.cjs"}}',
      );
      await put(f.root, `${workspace}/node_modules/versioned/import.js`, `export default ${JSON.stringify(version)};`);
      await put(f.root, `${workspace}/node_modules/versioned/require.cjs`, 'module.exports = "wrong condition";');
    }
    await put(f.root, "infrastructure/adapter/index.ts", 'export { default as second } from "versioned";');
    await put(
      f.root,
      `${f.service}/src/main.ts`,
      'import first from "versioned"; import { second } from "../../../infrastructure/adapter/index"; console.log(first, second);',
    );
    const { metafile, externals } = await bundleNodeService({ repoRoot: f.root, deployable: f.name });
    expect(Object.keys(metafile.inputs).some((input) => input.includes("node_modules"))).toBe(false);
    expect(externals.filter((edge) => edge.specifier === "versioned")).toHaveLength(2);
    for (const edge of externals) {
      expect(edge.resolved).toBe(
        path.join(path.dirname(createRequire(edge.importer).resolve("versioned")), "import.js"),
      );
      expect(path.resolve(f.dist, edge.external)).toBe(edge.resolved);
      expect(
        Object.values(metafile.outputs)
          .flatMap((output) => output.imports)
          .some((entry) => entry.external && entry.path === edge.external),
      ).toBe(true);
    }
    expect(startNode(process.execPath, [path.join(f.dist, "main.js")], { encoding: "utf8", timeout: 30_000 })).toBe(
      "one two\n",
    );
  });

  it("fails on an unlisted import.meta.url asset reference", async () => {
    const f = await fixture();
    await put(f.root, `${f.service}/src/main.ts`, 'console.log(new URL("./missing.json", import.meta.url));');
    await expect(bundleNodeService({ repoRoot: f.root, deployable: f.name })).rejects.toThrow(
      /Unlisted import.meta.url asset reference.*main.ts/,
    );
  });

  it("rejects an unlisted asset even inside the listed source file", async () => {
    const f = await fixture();
    await put(f.root, assetSource, 'console.log(new URL("./another.json", import.meta.url));');
    await put(f.root, `${f.service}/src/main.ts`, `import "../../../${assetSource}";`);
    await expect(bundleNodeService({ repoRoot: f.root, deployable: f.name })).rejects.toThrow(
      /Unlisted import.meta.url asset reference/,
    );
  });

  it("copies the support evidence golden fixtures beside the bundle", async () => {
    const f = await fixture();
    const sourceDirectory = path.dirname(assetSource);
    await mkdir(path.join(f.root, sourceDirectory), { recursive: true });
    await timed("fixtureCopy", () =>
      cp(path.join(repoRoot, sourceDirectory, "__fixtures__"), path.join(f.root, sourceDirectory, "__fixtures__"), {
        recursive: true,
      }),
    );
    await put(f.root, assetSource, 'export const fixtures = new URL("./__fixtures__/evidence/", import.meta.url);');
    await put(
      f.root,
      `${f.service}/src/main.ts`,
      `import { fixtures } from "../../../${assetSource}"; import { readdirSync } from "node:fs"; console.log(readdirSync(fixtures).sort().join("\\n"));`,
    );
    await bundleNodeService({ repoRoot: f.root, deployable: f.name });
    const { readdir } = await import("node:fs/promises");
    const originals = path.join(repoRoot, sourceDirectory, "__fixtures__/evidence");
    const files = (await readdir(originals)).sort();
    for (const file of files)
      expect(await readFile(path.join(f.dist, "__fixtures__/evidence", file))).toEqual(
        await readFile(path.join(originals, file)),
      );
    expect(
      startNode(process.execPath, [path.join(f.dist, "main.js")], { encoding: "utf8", timeout: 30_000 }).trim(),
    ).toBe(files.join("\n"));
  });

  it("maps bundled stack traces to TypeScript sources", async () => {
    const f = await fixture();
    await put(
      f.root,
      `${f.service}/src/failure.ts`,
      'export function fail(): never {\n  throw new Error("source-map-control");\n}\n',
    );
    await put(f.root, `${f.service}/src/main.ts`, 'import { fail } from "./failure";\nfail();\n');
    await bundleNodeService({ repoRoot: f.root, deployable: f.name });
    const result = spawnSync(process.execPath, ["--enable-source-maps", path.join(f.dist, "main.js")], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("source-map-control");
    expect(result.stderr).toMatch(/src[/\\]failure.ts:2:/);
  });

  it("builds and copies both service bundles in the runtime image", async () => {
    const dockerfile = await readFile(path.join(repoRoot, "Dockerfile"), "utf8");
    for (const name of Object.keys(baselineScriptDigests)) {
      expect(dockerfile.split(" AS runtime")[0]).toContain(`pnpm --filter @chase-sets/app-${name} run build`);
      expect(dockerfile).toContain(
        `COPY --chown=node:node --from=build /app/deployables/${name}/dist ./deployables/${name}/dist`,
      );
    }
  });
});
