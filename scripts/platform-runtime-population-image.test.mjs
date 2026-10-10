import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";

const repo = fileURLToPath(new URL("../", import.meta.url));
const entrypoint = "scripts/discovery-search-identity-terms-populate.mjs";
const manifest = "scripts/typescript-resolver-caller-manifests/discovery-search-identity-terms-populate.manifest";
const resolver = "infrastructure/platform-runtime/typescript-resolver.mjs";
const control = "infrastructure/platform-runtime/control-plane.ts";
const adapter = "bounded-contexts/discovery/support/runtime-support/search-identity-terms-population.ts";
const transitive = "infrastructure/platform-runtime/control-dependency.ts";
const pool = "infrastructure/event-core-postgres/pool.ts";
const dockerfile = readFileSync(path.join(repo, "Dockerfile"), "utf8");
const assertion = dockerfile.match(/<<'POPULATION_IMAGE_ASSERT'\r?\n([\s\S]*?)\r?\nPOPULATION_IMAGE_ASSERT/)[1];
const fixtures = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function put(root, filename, content) {
  const destination = path.join(root, filename);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

// Synthetic import closure: callable exports throw if the assertion executes population.
// The actual production-only closure is proved by the final-stage hosted image build.
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "population-image-"));
  fixtures.push(directory);
  const root = path.join(directory, "app");
  const input = path.join(directory, "build-input");
  for (const filename of [entrypoint, manifest]) {
    const content = readFileSync(path.join(repo, filename));
    put(root, filename, content);
    put(input, filename, content);
  }
  put(root, "package.json", '{"type":"module"}');
  put(root, resolver, readFileSync(path.join(repo, resolver)));
  put(root, transitive, "export const marker: string = 'synthetic';");
  put(
    root,
    pool,
    `import { Pool } from 'pg';
    export function createPgPool() { return new Pool(); }`,
  );
  put(
    root,
    control,
    `import { marker } from './control-dependency';
    assertMarker(marker);
    function assertMarker(value: string) { if (value !== 'synthetic') throw new Error('transitive not loaded'); }
    export function createPostgresPlatformControlPlane() { throw new Error('must not create control plane'); }`,
  );
  put(
    root,
    adapter,
    `import '${path.posix.relative(path.posix.dirname(adapter), control)}';
    export function populateDiscoverySearchIdentityTerms() { throw new Error('must not populate'); }`,
  );
  put(root, "node_modules/pg/package.json", '{"type":"module","exports":"./index.mjs"}');
  put(
    root,
    "node_modules/pg/index.mjs",
    "export class Pool { constructor() { throw new Error('must not connect'); } }",
  );
  return { root, input };
}

function runAssertion({ root, input }) {
  return spawnSync(process.execPath, ["--experimental-import-meta-resolve", "--input-type=module", "-", input], {
    cwd: root,
    input: assertion,
    encoding: "utf8",
    env: { SystemRoot: process.env.SystemRoot, NODE_ENV: "production" },
  });
}

function inspectRuntimeStage(source) {
  const runtime = source.split(/^FROM .* AS runtime\s*$/m)[1];
  assert.ok(runtime, "final runtime stage required");
  assert.match(runtime, /WORKDIR \/app/);
  assert.match(runtime, /USER node/);
  assert.match(runtime, /RUN pnpm install --frozen-lockfile --prod/);
  assert.match(runtime, /-name "\*\.test\.\*"/);
  assert.match(runtime, /ENV NODE_ENV=production/);
  const copies = runtime.match(/^COPY[^\r\n]*scripts[^\r\n]*$/gm) ?? [];
  assert.equal(copies.length, 2, "copy exactly two script assets");
  for (const asset of [entrypoint, manifest]) {
    assert.ok(copies.includes(`COPY --chown=node:node ${asset} ./${asset}`), `${asset}: final-stage selective copy`);
    assert.ok(runtime.includes(`source=${asset},target=/build-input/${asset}`), `${asset}: compare build input`);
  }
  const assertionPosition = runtime.indexOf("<<'POPULATION_IMAGE_ASSERT'");
  assert.ok(assertionPosition > runtime.indexOf("pnpm install --frozen-lockfile --prod"));
  assert.ok(assertionPosition > runtime.indexOf('-name "*.test.*"'));
  assert.ok(assertionPosition > runtime.indexOf("ENV NODE_ENV=production"));
  assert.match(
    runtime,
    /RUN --mount=type=bind,[\s\S]*node --experimental-import-meta-resolve --input-type=module - \/build-input <<'POPULATION_IMAGE_ASSERT'/,
  );
  return runtime;
}

test("final runtime stage selectively copies both assets and enforces native imports after production pruning", () => {
  inspectRuntimeStage(dockerfile);
  const buildStageOnly = dockerfile.replaceAll(/^COPY --chown=node:node scripts\/[^\r\n]+\r?\n/gm, "");
  assert.throws(() => inspectRuntimeStage(buildStageOnly), /copy exactly two/);
  const assertionOnlyInBuild = dockerfile.replace(" AS runtime", " AS unchecked-runtime");
  assert.throws(() => inspectRuntimeStage(assertionOnlyInBuild), /final runtime stage/);
  const scriptsTree = dockerfile.replace(
    `COPY --chown=node:node ${entrypoint} ./${entrypoint}`,
    "COPY scripts ./scripts",
  );
  assert.throws(() => inspectRuntimeStage(scriptsTree), /final-stage selective copy/);
});

test("exact Dockerfile assertion accepts valid synthetic assets and imports without calling main or opening connections", () => {
  const result = runAssertion(fixture());
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.match(result.stdout, /native import assertion passed \(3 manifest caller roots; no main or connections\)/);
  assert.equal((result.stdout.match(/sha256=[a-f0-9]{64}/g) ?? []).length, 2);
});

test.each([entrypoint, manifest, resolver, transitive, pool, "node_modules/pg"])(
  "exact Dockerfile assertion rejects omitted runtime asset/import %s",
  (omitted) => {
    const f = fixture();
    rmSync(path.join(f.root, omitted), { recursive: true, force: true });
    const result = runAssertion(f);
    assert.equal(result.status, 1, result.error?.message ?? result.stderr);
    assert.ok(result.stderr.length > 0, "omission must have diagnostic evidence");
  },
);

test.each([entrypoint, manifest])("exact Dockerfile assertion rejects changed bytes in %s", (asset) => {
  const f = fixture();
  put(f.root, asset, "changed build payload");
  const result = runAssertion(f);
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  assert.match(result.stderr, /build input differs/);
});

test("exact Dockerfile assertion rejects unrelated scripts", () => {
  const f = fixture();
  put(f.root, "scripts/unrelated.mjs", "export const unrelated = true;");
  const result = runAssertion(f);
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  assert.match(result.stderr, /Only population assets may ship/);
});

test("manifest caller edges drive imports beyond the three required roots", () => {
  const f = fixture();
  const extraRoot = ["candidate", "edges", { from: entrypoint, specifier: "../infrastructure/missing-new-root.ts" }];
  const content = `${readFileSync(path.join(f.root, manifest), "utf8").trim()}\n${JSON.stringify(extraRoot)}\n`;
  for (const root of [f.root, f.input]) put(root, manifest, content);
  const result = runAssertion(f);
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  assert.match(result.stderr, /missing-new-root/);
  put(f.root, "infrastructure/missing-new-root.ts", "export const present: boolean = true;");
  const repaired = runAssertion(f);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.match(repaired.stdout, /4 manifest caller roots/);
});

test("exact Dockerfile assertion rejects missing expected exports", () => {
  const f = fixture();
  put(f.root, pool, "export const notCreatePgPool = true;");
  const result = runAssertion(f);
  assert.equal(result.status, 1, result.error?.message ?? result.stderr);
  assert.match(result.stderr, /pool.ts: missing createPgPool/);
});
