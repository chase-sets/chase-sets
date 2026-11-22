import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bundleNodeService } from "./bundle-node-service.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const roots = [];
const assetSource = "bounded-contexts/platform-operations/features/support-requests/api/evidence-canonicalization.ts";
const baselineScriptDigests = {
  "platform-api": "a8b9aa44b2fc28e36c3e2995ee43b68d695b56928876ef93624b11792542f0c1",
  "platform-worker": "b968c49f7ec21e7b2ddd4ee0f390f422cdbd408dc108e12bd61f8db83fcf7eac",
};

async function put(root, name, contents) {
  const target = path.join(root, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
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

afterEach(async () => {
  // Only directories returned by mkdtemp above are removed.
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bundle-node-service", () => {
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
      expect(
        execFileSync(process.execPath, [path.join(f.dist, "main.js")], { encoding: "utf8", timeout: 30_000 }),
      ).toBe("patched\nstarted\n");
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
    expect(execFileSync(process.execPath, [path.join(f.dist, "main.js")], { encoding: "utf8", timeout: 30_000 })).toBe(
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
    await cp(path.join(repoRoot, sourceDirectory, "__fixtures__"), path.join(f.root, sourceDirectory, "__fixtures__"), {
      recursive: true,
    });
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
      execFileSync(process.execPath, [path.join(f.dist, "main.js")], { encoding: "utf8", timeout: 30_000 }).trim(),
    ).toBe(files.join("\n"));
  });

  it.each([true, false])("loads the bundled product cards HTML only when built (built: %s)", async (built) => {
    const f = await fixture();
    const html = "<!doctype html><title>Product cards</title>";
    const asset = "deployables/agent-apps/build/product-cards.html";
    if (built) await put(f.root, asset, html);
    await put(
      f.root,
      `${f.service}/src/main.ts`,
      `import { readFile } from "node:fs/promises";
const html = await readFile(new URL("../../agent-apps/build/product-cards.html", import.meta.url), "utf8")
  .catch((error) => { if (error.code !== "ENOENT") throw error; });
console.log(html ?? "unavailable");`,
    );
    await bundleNodeService({ repoRoot: f.root, deployable: f.name });
    const copy = readFile(path.join(f.dist, "product-cards.html"), "utf8");
    if (built) {
      await expect(copy).resolves.toBe(html);
      await rm(path.join(f.root, asset));
    } else {
      await expect(copy).rejects.toMatchObject({ code: "ENOENT" });
    }
    expect(execFileSync(process.execPath, [path.join(f.dist, "main.js")], { encoding: "utf8", timeout: 30_000 })).toBe(
      `${built ? html : "unavailable"}\n`,
    );
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

  it("builds the product cards HTML before bundling Platform API in the image", async () => {
    const dockerfile = await readFile(path.join(repoRoot, "Dockerfile"), "utf8");
    const [buildStage] = dockerfile.split(" AS runtime");
    const widget = buildStage.indexOf("pnpm --filter @chase-sets/app-agent-apps run build");
    const api = buildStage.indexOf("pnpm --filter @chase-sets/app-platform-api run build");
    expect(widget).toBeGreaterThanOrEqual(0);
    expect(api).toBeGreaterThan(widget);
  });
});
