import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeManagedPostgresAuthorityManifest } from "./managed-postgres-authority-sources.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const guardEntrypoint = join(repositoryRoot, "scripts", "managed-postgres-authority-guard.mjs");
const schemaPath = join(repositoryRoot, "scripts", "managed-postgres-authority-manifest.schema.json");
const fixtureRoots = [];
const arbitraryWorkflowPath = ".github/workflows/asteroid-field/unfamiliar-probe.yaml";
const canonicalActionTarget = "./.github/actions/export-managed-postgres-authority";
const canonicalActionPath = ".github/actions/export-managed-postgres-authority/action.yml";
const rootSecretNames = ["SPACES_ACCESS_ID", "SPACES_SECRET_KEY", "DIGITALOCEAN_ACCESS_TOKEN"];
const constrainedStackSize = 68;
const largePaddingFileCount = 12_000;
const smallPaddingFileCount = 64;
const probeUses = "synthetic/authority-probe@v1";
const lifecycleProbePath = "lifecycle/probe.mjs";
const lifecycleStep = { name: "Lifecycle probe", run: `node ./${lifecycleProbePath}` };
const benignLifecycleSource = 'export const target = "postgresqx://lifecycle.invalid/db";\n';
const materialLifecycleSource = 'export const target = "postgresql://lifecycle.invalid/db";\n';
const longerMaterialLifecycleSource = 'export const target = "postgresql://lifecycle.invalid/database";\n';
const pinnedLifecycleTime = new Date("2001-02-03T04:05:06.000Z");
const producerActionSource =
  "name: Export managed Postgres authority\ninputs:\n  environment:\n    required: true\n  contexts:\n    required: false\n  connection-mode:\n    required: false\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: node ./scripts/terraform-state-database-urls.mjs\n";

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed Postgres authority guard real entrypoint", () => {
  it("P1 passes the live repository with exact ingress and YAML coverage", async () => {
    const result = await runGuard(repositoryRoot);

    expect(result.exitCode).toBe(0);
    expect(result.report.violations).toEqual([]);
    expect(result.report.ingressCoverage).toMatch(/^\d+\/\d+$/);
    expect(result.report.yamlCoverage).toMatch(/^\d+\/\d+$/);
    expect(result.report.manifestedIngressCount).toBe(result.report.totalIngressCount);
    expect(result.report.scannedYamlFileCount).toBe(result.report.totalYamlFileCount);
    expect(result.stdout).not.toContain('"source"');
  });

  it("P2 accepts a canonical boundary consumer at an arbitrary workflow path", async () => {
    const root = await createFixture();

    const result = await runGuard(root);

    expect(result.exitCode).toBe(0);
    expect(result.report.violations).toEqual([]);
    expect(result.report.boundaryConsumerCount).toBe(1);
    expect(result.report.ingressCoverage).toBe("3/3");
  });

  describe("large subtree discovery", () => {
    let root;
    let fixture;

    beforeAll(async () => {
      root = await createFixture({ registerForCleanup: false });
      fixture = await addSyntheticDiscoverySubtree(root, largePaddingFileCount);
    });

    afterAll(async () => {
      if (root) {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("completes exact discovery beyond the constrained engine argument-spread limit", async () => {
      const preloadRoot = await mkdtemp(join(tmpdir(), "mpa-spread-calibration-"));
      const preload = join(preloadRoot, "spread-overflow-calibration.cjs");
      const spreadOverflowMarker = `authority-spread-overflow:${fixture.overflowingSubtreeFileCount}`;
      await write(
        preload,
        `let overflowed = false;
try {
  const files = [];
  const discoveredFiles = new Array(${fixture.overflowingSubtreeFileCount});
  files.push(...discoveredFiles);
} catch (error) {
  if (!(error instanceof RangeError)) throw error;
  overflowed = true;
}
if (!overflowed) throw new Error("array spread calibration did not overflow");
process.stderr.write(${JSON.stringify(`${spreadOverflowMarker}\n`)});
`,
      );
      try {
        const result = await runGuard(root, { stackSize: constrainedStackSize, preload });
        expect(result.stderr).toBe(`${spreadOverflowMarker}\n`);
        expectExactSyntheticActionDiscovery(result, fixture.actionPaths);
      } finally {
        await rm(preloadRoot, { recursive: true, force: true });
      }
    });

    it("retains the same exact discovery at the default stack size", async () => {
      const result = await runGuard(root);

      expect(result.stderr).toBe("");
      expectExactSyntheticActionDiscovery(result, fixture.actionPaths);
    });
  });

  it("completes the exact below-threshold control at the constrained stack size", async () => {
    const root = await createFixture();
    const fixture = await addSyntheticDiscoverySubtree(root, smallPaddingFileCount);

    const result = await runGuard(root, { stackSize: constrainedStackSize });

    expect(result.stderr).toBe("");
    expectExactSyntheticActionDiscovery(result, fixture.actionPaths);
  });

  it.each([
    {
      label: "N1 Node pg alias",
      path: "nebula/alias/quiet-client.mjs",
      source: 'import postgres from "pg"; new postgres.Pool({ connectionString: process.env.DATABASE_URL });',
    },
    {
      label: "N2 wrapper",
      path: "nebula/wrapper/through-another-layer.mjs",
      source: 'import { connect } from "./adapter.mjs"; await connect();',
      extraFiles: {
        "nebula/wrapper/adapter.mjs": 'export async function connect() { return import("pg"); }',
      },
    },
    {
      label: "N3 dynamic import",
      path: "nebula/dynamic/runtime-choice.mjs",
      source: "const moduleName = process.argv[2]; await import(moduleName);",
    },
    {
      label: "N4 renamed file",
      path: "never-before-used/constellation/fresh-name-947.mjs",
      source: 'process.stdout.write("consumer spelling is intentionally irrelevant");',
    },
  ])(
    "$label fails on authority ingress without recognizing consumer spelling",
    async ({ path, source, extraFiles }) => {
      const root = await createFixture({
        additionalSteps: [
          {
            name: "Opaque consumer",
            env: { DIGITALOCEAN_ACCESS_TOKEN: "${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}" },
            run: `node ./${path}`,
          },
        ],
        files: { [path]: source, ...extraFiles },
      });

      const result = await runGuard(root);

      expect(result.exitCode).toBe(1);
      expect(codes(result.report)).toContain("unmanifested-secret-ingress");
    },
  );

  it("N5 rejects historical direct psql downgrade through inline workflow discovery", async () => {
    const root = await createFixture({
      additionalSteps: [
        {
          name: "Unfamiliar inline command",
          run: "psql 'postgresql://synthetic-user:synthetic-password@example.test/example?sslmode=require'",
        },
      ],
    });

    const result = await runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toEqual(expect.arrayContaining(["connection-material", "tls-downgrade"]));
    expect(result.stdout).not.toContain("synthetic-password");
    expect(result.stdout).not.toContain("postgresql://");
  });

  it("N6 rejects a Docker action in a boundary-authorized job without a CA path mapping", async () => {
    const root = await createFixture({
      additionalSteps: [{ name: "Containerized consumer", uses: "docker://postgres:17" }],
    });

    const result = await runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toContain("docker-consumer-unsupported");
  });

  it("N7 discovers an indirect package client and independently rejects its root-secret ingress", async () => {
    const root = await createFixture({
      packageScripts: { "orbital:probe": "node ./quasar/indirect/assemble.mjs" },
      additionalSteps: [
        {
          name: "Indirect client",
          env: { DIGITALOCEAN_ACCESS_TOKEN: "${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}" },
          run: "pnpm run orbital:probe",
        },
      ],
      files: {
        "quasar/indirect/assemble.mjs":
          "const connection = { PGHOST: process.env.PGHOST, PGUSER: process.env.PGUSER }; console.log(Boolean(connection));",
      },
    });

    const result = await runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toEqual(
      expect.arrayContaining(["connection-material", "unmanifested-secret-ingress"]),
    );
  });

  it("N8 rejects a newly added workflow secret ingress absent from the manifest", async () => {
    const root = await createFixture({
      files: {
        ".github/workflows/unmapped/new-arrival.yml": workflowSource([
          {
            name: "New grant",
            env: { SOME_NEW_SECRET: "${{ secrets.SOME_NEW_SECRET }}" },
            run: 'echo "redacted"',
          },
        ]),
      },
    });

    const result = await runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toContain("unmanifested-secret-ingress");
  });

  it("N9 rejects a stale manifest grant after its workflow is deleted", async () => {
    const root = await createFixture({
      extraGrants: [
        grant({
          file: ".github/workflows/deleted/vanished.yml",
          jobId: "probe",
          stepAnchor: "name:Former grant#1",
          secretName: "FORMER_SECRET",
          purpose: "application-runtime",
        }),
      ],
    });

    const result = await runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toContain("manifest-entry-unmatched");
  });

  it("N10 rejects a second producer target claiming the boundary purpose", async () => {
    const secondTarget = "./odd-capabilities/second-exporter";
    const secondAnchor = `uses:${secondTarget}`;
    const root = await createFixture({
      additionalSteps: [
        {
          uses: secondTarget,
          env: {
            AWS_ACCESS_KEY_ID: "${{ secrets.SPACES_ACCESS_ID }}",
            AWS_SECRET_ACCESS_KEY: "${{ secrets.SPACES_SECRET_KEY }}",
            DIGITALOCEAN_ACCESS_TOKEN: "${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}",
          },
        },
      ],
      files: {
        "odd-capabilities/second-exporter/action.yml":
          "name: second exporter\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo bounded\n",
      },
      extraGrants: rootSecretNames.map((secretName) =>
        grant({ stepAnchor: secondAnchor, secretName, purpose: "managed-postgres-boundary" }),
      ),
    });

    const result = await runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toContain("boundary-producer-duplicate");
  });

  it("N11 rejects root authority widened to workflow scope", async () => {
    const root = await createFixture({
      workflowEnv: { DIGITALOCEAN_ACCESS_TOKEN: "${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}" },
      extraGrants: [
        grant({
          stepAnchor: "workflow",
          secretName: "DIGITALOCEAN_ACCESS_TOKEN",
          purpose: "digitalocean-ops",
        }),
      ],
    });

    const result = await runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toContain("secret-scope-too-wide");
  });

  it("N12 forbids secrets inherit on reusable workflows", async () => {
    const root = await createFixture({
      files: {
        ".github/workflows/reusable/receiver.yml":
          "name: receiver\non:\n  workflow_call:\njobs:\n  receive:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo bounded\n",
        ".github/workflows/reusable/caller.yml":
          "name: caller\non: workflow_dispatch\njobs:\n  call:\n    uses: ./.github/workflows/reusable/receiver.yml\n    secrets: inherit\n",
      },
    });

    const result = await runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toContain("secrets-inherit-forbidden");
  });

  it.each([
    {
      label: "malformed YAML",
      code: "yaml-parse-failed",
      files: { ".github/workflows/nonstandard/broken.yml": "name: [unterminated" },
    },
    {
      label: "missing local action",
      code: "referenced-executable-missing",
      files: {
        ".github/workflows/nonstandard/missing-action.yml": workflowSource([
          { name: "Missing action", uses: "./somewhere-that-does-not-exist" },
        ]),
      },
    },
  ])("N13 fails closed for $label through full discovery", async ({ code, files }) => {
    const root = await createFixture({ files });

    const result = await runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toContain(code);
    if (code === "yaml-parse-failed") {
      expect(result.report.violations).toEqual([
        { code: "authority-source-invalid", file: ".github/authority" },
        {
          code: "yaml-parse-failed",
          file: ".github/workflows/nonstandard/broken.yml",
        },
      ]);
      expect(codes(result.report)).not.toContain("authority-scan-failed");
    }
  });

  it("reports a non-YAML scanner failure without exposing its cause", async () => {
    const root = await mkdtemp(join(tmpdir(), "mpa-private-root-"));
    fixtureRoots.push(root);
    const pathToken = "private-path-token-8041";
    const contentsToken = "private-file-contents-8041";
    const environmentToken = "private-environment-value-8041";
    const repositoryFile = join(root, pathToken);
    await writeFile(repositoryFile, contentsToken, "utf8");

    const result = await runGuard(repositoryFile, {
      env: { AUTHORITY_GUARD_PRIVATE_VALUE: environmentToken },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.report).toEqual({
      schemaVersion: 1,
      totalYamlFileCount: 0,
      scannedYamlFileCount: 0,
      yamlCoverage: "0/0",
      totalIngressCount: 0,
      manifestedIngressCount: 0,
      ingressCoverage: "0/0",
      violations: [{ code: "authority-scan-failed" }],
    });
    for (const privateValue of [pathToken, contentsToken, environmentToken, "ENOTDIR", "RangeError", "scandir"]) {
      expect(result.stdout).not.toContain(privateValue);
    }
    expect(result.report.violations[0]).not.toHaveProperty("cause");
    expect(result.report.violations[0]).not.toHaveProperty("file");
  });

  it("N13 fails closed for a schema-invalid manifest", async () => {
    const root = await createFixture();
    await writeJson(join(root, "scripts/managed-postgres-authority-manifest.json"), {
      schemaVersion: 1,
      grants: [{ file: arbitraryWorkflowPath }],
    });

    const result = await runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toContain("manifest-schema-invalid");
  });

  it("enumerates unreachable action manifests at arbitrary non-vocabulary paths", async () => {
    const root = await createFixture({
      files: {
        "unfamiliar-zone/orphaned-capability/action.yaml":
          "name: orphaned\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: psql 'postgresql://redacted@example.test/db'\n",
      },
    });

    const result = await runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toContain("connection-material");
  });

  it("fails closed for an unpinned remote action", async () => {
    const root = await createFixture({
      additionalSteps: [{ name: "Unpinned", uses: "owner/action@v1" }],
    });

    const result = await runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(codes(result.report)).toContain("uses-kind-unknown");
  });

  it("discovers each workflow and action manifest once at nested, hidden, ignored, generated, untracked and mixed-case paths", async () => {
    const root = await createFixture({
      files: {
        ".gitignore": "ignored-capabilities/\n",
        ".github/workflows/deep/er/nest/nested-probe.yml": probeWorkflowSource(),
        ".github/workflows/action.yml": probeWorkflowSource(),
        ".github/workflows/upper-extension.YML": probeWorkflowSource(),
        ".github/workflows/notes.txt": "not a workflow\n",
        ".hidden-capabilities/probe/action.yaml": probeActionSource(),
        "ignored-capabilities/probe/action.yml": probeActionSource(),
        "generated/dist/probe/Action.YML": probeActionSource(),
        "untracked/probe/ACTION.yaml": probeActionSource(),
        "excluded/node_modules/probe/action.yml": probeActionSource(),
        "excluded/.pnpm/probe/action.yml": probeActionSource(),
        "decoys/probe/action.yml.disabled": probeActionSource(),
        "decoys/probe/composite-action.yml": probeActionSource(),
        "decoys/action.yml/README.md": "a directory named like a manifest\n",
      },
    });
    await write(join(root, ".git/capabilities/action.yml"), probeActionSource());
    await symlink(join(root, ".hidden-capabilities"), join(root, "linked-capabilities"), "junction");

    const result = await runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(result.report).toEqual(
      baseFixtureReport({
        workflowFileCount: 3,
        actionManifestFileCount: 5,
        totalYamlFileCount: 8,
        scannedYamlFileCount: 8,
        yamlCoverage: "8/8",
        violations: [
          probeViolation(".github/workflows/action.yml", "probe"),
          probeViolation(".github/workflows/deep/er/nest/nested-probe.yml", "probe"),
          probeViolation(".hidden-capabilities/probe/action.yaml", "action"),
          probeViolation("generated/dist/probe/Action.YML", "action"),
          probeViolation("ignored-capabilities/probe/action.yml", "action"),
          probeViolation("untracked/probe/ACTION.yaml", "action"),
        ],
      }),
    );
  });

  it("discovers a workflows root that root traversal reaches only through a link", async () => {
    const root = await createFixture();
    await rename(join(root, ".github/workflows"), join(root, "linked-workflows-target"));
    await symlink(join(root, "linked-workflows-target"), join(root, ".github/workflows"), "junction");

    const result = await runGuard(root);

    expect(result.exitCode).toBe(0);
    expect(result.report).toEqual(baseFixtureReport());
  });

  describe("fresh input reads across invocations", () => {
    let root;
    let probe;
    let initial;

    beforeAll(async () => {
      root = await createFixture({
        registerForCleanup: false,
        additionalSteps: [lifecycleStep],
        files: { [lifecycleProbePath]: benignLifecycleSource },
      });
      probe = join(root, lifecycleProbePath);
      await restoreLifecycleProbe(probe);
      initial = await runGuard(root);
    });

    afterAll(async () => {
      if (root) {
        await rm(root, { recursive: true, force: true });
      }
    });

    it("starts from the exact clean report", () => {
      expect(initial.exitCode).toBe(0);
      expect(initial.report).toEqual(baseFixtureReport({ scannedExecutableSurfaceCount: 4 }));
    });

    it("re-reads a changed executable", async () => {
      await writeFile(probe, longerMaterialLifecycleSource, "utf8");
      const changed = await runGuard(root);
      await restoreLifecycleProbe(probe);

      expect(changed.exitCode).toBe(1);
      expect(changed.report).toEqual({
        ...initial.report,
        violations: [lifecycleViolation("connection-material", lifecycleProbePath)],
      });
      expect(changed.stdout).not.toContain("postgresql://");
    });

    it("re-reads a same-length change that keeps size and modification time", async () => {
      const before = await stat(probe);
      await writeFile(probe, materialLifecycleSource, "utf8");
      await utimes(probe, pinnedLifecycleTime, pinnedLifecycleTime);
      const after = await stat(probe);
      const changed = await runGuard(root);
      await restoreLifecycleProbe(probe);

      expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
      expect(changed.exitCode).toBe(1);
      expect(changed.report).toEqual({
        ...initial.report,
        violations: [lifecycleViolation("connection-material", lifecycleProbePath)],
      });
    });

    it("reports a deleted executable as missing", async () => {
      await rm(probe);
      const deleted = await runGuard(root);
      await restoreLifecycleProbe(probe);

      expect(deleted.exitCode).toBe(1);
      expect(deleted.report).toEqual({
        ...initial.report,
        scannedExecutableSurfaceCount: 3,
        violations: [lifecycleViolation("referenced-executable-missing", arbitraryWorkflowPath)],
      });
    });

    it("discovers an added action manifest", async () => {
      const addedAction = "lifecycle/added-capability/action.yml";
      await write(join(root, addedAction), probeActionSource());
      const added = await runGuard(root);
      await rm(join(root, addedAction));

      expect(added.exitCode).toBe(1);
      expect(added.report).toEqual({
        ...initial.report,
        actionManifestFileCount: 2,
        totalYamlFileCount: 3,
        scannedYamlFileCount: 3,
        yamlCoverage: "3/3",
        violations: [probeViolation(addedAction, "action")],
      });
    });

    it("returns the exact initial result once every input is restored", async () => {
      const restored = await runGuard(root);

      expect(restored).toEqual(initial);
    });
  });

  it("fails closed for each malformed or unbounded YAML input without exposing its contents", async () => {
    const root = await createFixture({
      files: {
        ".github/workflows/alias-flood.yml": `anchor: &shared [1]\nflood: [${Array.from({ length: 101 }, () => "*shared").join(", ")}]\n`,
        ".github/workflows/broken-syntax.yml": "name: [unterminated-private-token",
        ".github/workflows/duplicate-keys.yml": "name: first\nname: second\n",
        ".github/workflows/empty.yml": "",
        ".github/workflows/scalar.yaml": "scalar-private-token\n",
        ".github/workflows/zz-valid-probe.yml": probeWorkflowSource(),
        ".hidden-capabilities/list/action.yaml": "- list-private-token\n- second\n",
      },
    });

    const result = await runGuard(root);

    expect(result.exitCode).toBe(1);
    expect(result.report).toEqual(
      baseFixtureReport({
        workflowFileCount: 2,
        totalYamlFileCount: 9,
        scannedYamlFileCount: 3,
        yamlCoverage: "3/9",
        violations: [
          { code: "authority-source-invalid", file: ".github/authority" },
          probeViolation(".github/workflows/zz-valid-probe.yml", "probe"),
          ...[
            ".github/workflows/alias-flood.yml",
            ".github/workflows/broken-syntax.yml",
            ".github/workflows/duplicate-keys.yml",
            ".github/workflows/empty.yml",
            ".github/workflows/scalar.yaml",
            ".hidden-capabilities/list/action.yaml",
          ].map((file) => ({ code: "yaml-parse-failed", file })),
        ],
      }),
    );
    for (const privateValue of ["private-token", "*shared"]) {
      expect(result.stdout).not.toContain(privateValue);
    }
  });

  it.each([
    {
      copies: 1,
      exitCode: 1,
      counts: { manifestedIngressCount: 4, manifestGrantCount: 4, ingressCoverage: "4/5" },
      code: "unmanifested-secret-ingress",
    },
    { copies: 2, exitCode: 0, counts: { manifestedIngressCount: 5, manifestGrantCount: 5, ingressCoverage: "5/5" } },
    {
      copies: 3,
      exitCode: 1,
      counts: { manifestedIngressCount: 5, manifestGrantCount: 6, ingressCoverage: "5/5" },
      code: "manifest-entry-unmatched",
    },
  ])(
    "reconciles $copies repeated grant copies against two identical ingress occurrences",
    async ({ copies, exitCode, counts, code }) => {
      const stepAnchor = "name:Repeated grant#3";
      const root = await createFixture({
        additionalSteps: [
          {
            name: "Repeated grant",
            env: {
              FIRST_COPY: "${{ secrets.REPEATED_PRIVATE_SECRET }}",
              SECOND_COPY: "${{ secrets.REPEATED_PRIVATE_SECRET }}",
            },
            run: 'echo "redacted"',
          },
        ],
        extraGrants: Array.from({ length: copies }, () => grant({ stepAnchor, secretName: "REPEATED_PRIVATE_SECRET" })),
      });

      const result = await runGuard(root);

      expect(result.exitCode).toBe(exitCode);
      expect(result.report).toEqual(
        baseFixtureReport({
          totalIngressCount: 5,
          ...counts,
          scannedExecutableSurfaceCount: 3,
          violations: code ? [{ code, file: arbitraryWorkflowPath, jobId: "probe", stepAnchor }] : [],
        }),
      );
      expect(result.stdout).not.toContain("REPEATED_PRIVATE_SECRET");
    },
  );

  it("keeps missing-descendant findings for every parent and producer context of shared executables", async () => {
    const root = await createFixture({
      additionalSteps: [
        { name: "First consumer", run: "node ./shared/entry.mjs" },
        { name: "Second consumer", run: "node ./shared/entry.mjs" },
        { name: "Repeated consumer", run: "node ./shared/entry.mjs && node ./shared/entry.mjs" },
        { name: "Producer reuse", run: "node ./scripts/terraform-state-database-urls.mjs" },
      ],
      files: {
        [canonicalActionPath]: producerActionSource,
        "scripts/terraform-state-database-urls.mjs": 'import "./absent-producer-helper.mjs";\n',
        "shared/entry.mjs":
          'import { helper } from "./middle.mjs";\nawait import("./absent-entry-helper.mjs");\nhelper();\n',
        "shared/middle.mjs": 'export { helper } from "./absent-middle-helper.mjs";\n',
        "shared/present-main.mjs": 'import "./absent-main-helper.mjs";\n',
        "node-actions/alpha/action.yml": nodeActionSource("../../shared/absent-main.mjs"),
        "node-actions/beta/action.yml": nodeActionSource("../../shared/absent-main.mjs"),
        "node-actions/delta/action.yml": nodeActionSource("../../shared/present-main.mjs"),
        "node-actions/gamma/action.yml": nodeActionSource("../../shared/present-main.mjs"),
      },
    });

    const result = await runGuard(root);

    const consumers = ["name:First consumer#3", "name:Repeated consumer#5", "name:Second consumer#4"];
    const missing = (file, jobId, stepAnchor) => ({ code: "referenced-executable-missing", file, jobId, stepAnchor });
    expect(result.exitCode).toBe(1);
    expect(result.report).toEqual(
      baseFixtureReport({
        actionManifestFileCount: 5,
        totalYamlFileCount: 6,
        scannedYamlFileCount: 6,
        yamlCoverage: "6/6",
        scannedExecutableSurfaceCount: 10,
        violations: [
          missing("node-actions/alpha/action.yml", "action", "action"),
          missing("node-actions/beta/action.yml", "action", "action"),
          missing("scripts/terraform-state-database-urls.mjs", "action", "step:1"),
          missing("scripts/terraform-state-database-urls.mjs", "probe", "name:Producer reuse#6"),
          ...consumers.map((stepAnchor) => missing("shared/entry.mjs", "probe", stepAnchor)),
          ...consumers.map((stepAnchor) => missing("shared/middle.mjs", "probe", stepAnchor)),
          missing("shared/present-main.mjs", "action", "action"),
        ],
      }),
    );
  });
});

async function createFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "mpa-oracle-unfamiliar-"));
  if (options.registerForCleanup !== false) {
    fixtureRoots.push(root);
  }
  const baseSteps = [
    {
      uses: canonicalActionTarget,
      env: {
        AWS_ACCESS_KEY_ID: "${{ secrets.SPACES_ACCESS_ID }}",
        AWS_SECRET_ACCESS_KEY: "${{ secrets.SPACES_SECRET_KEY }}",
        DIGITALOCEAN_ACCESS_TOKEN: "${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}",
      },
      with: {
        environment: "staging",
        contexts: "catalog",
        "connection-mode": "pooled",
      },
    },
    { name: "Remove managed Postgres CA", if: "always()", run: 'rm -f -- "$PGSSLROOTCERT"' },
    ...(options.additionalSteps ?? []),
  ];
  const workflow = workflowSource(baseSteps, options.workflowEnv);
  const action =
    "name: Export managed Postgres authority\ninputs:\n  environment:\n    required: true\n  contexts:\n    required: false\n  connection-mode:\n    required: false\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: echo bounded\n";
  const baseGrants = rootSecretNames.map((secretName) =>
    grant({ stepAnchor: `uses:${canonicalActionTarget}`, secretName, purpose: "managed-postgres-boundary" }),
  );
  const packageJson = {
    name: "synthetic-authority-fixture",
    private: true,
    scripts: options.packageScripts ?? {},
  };
  const files = {
    [arbitraryWorkflowPath]: workflow,
    [canonicalActionPath]: action,
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    ...(options.files ?? {}),
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    if (Object.hasOwn(options.files ?? {}, relativePath)) continue;
    await write(join(root, relativePath), contents);
  }
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(schemaPath, join(root, "scripts/managed-postgres-authority-manifest.schema.json"));
  const owners = new Map();
  for (const record of [...baseGrants, ...(options.extraGrants ?? [])]) {
    const source = `.github/authority/${basename(record.file).replace(/\.ya?ml$/, "")}/${record.jobId}.json`;
    owners.set(source, [...(owners.get(source) ?? []), record]);
    if (!(record.file in files)) {
      await writeJson(join(root, record.file), { jobs: { [record.jobId]: { steps: [] } } });
    }
  }
  for (const [source, grants] of owners) await writeJson(join(root, source), { grants });
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
  await execFileAsync("git", ["add", "--", ".github/authority"], { cwd: root });
  await writeManagedPostgresAuthorityManifest(root);
  for (const [relativePath, contents] of Object.entries(options.files ?? {})) {
    await write(join(root, relativePath), contents);
  }
  // Leave stale reviewed grants behind when exercising deleted-workflow reconciliation.
  for (const record of options.extraGrants ?? []) {
    if (!(record.file in files)) await rm(join(root, record.file), { force: true });
  }
  return root;
}

async function addSyntheticDiscoverySubtree(root, paddingFileCount) {
  const overflowingRoot = "oversized-action-subtree";
  const actionPaths = [
    `${overflowingRoot}/000-front/action.yml`,
    `${overflowingRoot}/200-interior/action.yml`,
    `${overflowingRoot}/400-tail/action.yml`,
    `${overflowingRoot}/400-tail/500-deeper/action.yml`,
    "zz-sibling-after/action.yml",
  ];
  const paddingPaths = Array.from({ length: paddingFileCount }, (_, index) => {
    const group = index < Math.ceil(paddingFileCount / 2) ? "100-padding" : "300-padding";
    return `${overflowingRoot}/${group}-${String(index).padStart(5, "0")}.pad`;
  });
  const rawPreFilterPaths = [...actionPaths, ...paddingPaths].sort((left, right) => left.localeCompare(right));
  const orderedActionPaths = rawPreFilterPaths.filter((path) => path.endsWith("/action.yml"));
  const interiorIndex = rawPreFilterPaths.indexOf(`${overflowingRoot}/200-interior/action.yml`);

  expect(rawPreFilterPaths[0]).toBe(`${overflowingRoot}/000-front/action.yml`);
  expect(rawPreFilterPaths.at(-1)).toBe("zz-sibling-after/action.yml");
  expect(rawPreFilterPaths[interiorIndex - 1]).toMatch(new RegExp(`^${overflowingRoot}/100-padding-[0-9]{5}\\.pad$`));
  expect(rawPreFilterPaths[interiorIndex + 1]).toMatch(new RegExp(`^${overflowingRoot}/300-padding-[0-9]{5}\\.pad$`));
  expect(orderedActionPaths).toContain(`${overflowingRoot}/400-tail/500-deeper/action.yml`);
  expect(rawPreFilterPaths.indexOf("zz-sibling-after/action.yml")).toBeGreaterThan(
    rawPreFilterPaths.lastIndexOf(`${overflowingRoot}/400-tail/500-deeper/action.yml`),
  );

  const source = `${JSON.stringify({
    name: "Synthetic authority probe",
    runs: { using: "composite", steps: [{ uses: "synthetic/authority-probe@v1" }] },
  })}\n`;
  const batchSize = 256;
  const files = [
    ...actionPaths.map((path) => ({ path, contents: source })),
    ...paddingPaths.map((path) => ({ path, contents: "x" })),
  ];
  for (let start = 0; start < files.length; start += batchSize) {
    await Promise.all(
      files.slice(start, start + batchSize).map(({ path, contents }) => write(join(root, path), contents)),
    );
  }
  return {
    actionPaths: orderedActionPaths,
    overflowingSubtreeFileCount:
      actionPaths.filter((path) => path.startsWith(`${overflowingRoot}/`)).length + paddingPaths.length,
  };
}

function expectExactSyntheticActionDiscovery(result, actionPaths) {
  const expectedViolations = actionPaths.map((file) => ({
    code: "uses-kind-unknown",
    file,
    jobId: "action",
    stepAnchor: "uses:synthetic/authority-probe@v1",
  }));
  const expectedActionManifestFileCount = actionPaths.length + 1;
  const expectedTotalYamlFileCount = actionPaths.length + 2;

  expect(result.exitCode).toBe(1);
  expect(result.report.violations).toEqual(expectedViolations);
  expect(result.report.workflowFileCount).toBe(1);
  expect(result.report.actionManifestFileCount).toBe(expectedActionManifestFileCount);
  expect(result.report.totalYamlFileCount).toBe(expectedTotalYamlFileCount);
  expect(result.report.scannedYamlFileCount).toBe(expectedTotalYamlFileCount);
  expect(result.report.yamlCoverage).toBe(`${expectedTotalYamlFileCount}/${expectedTotalYamlFileCount}`);
}

function workflowSource(steps, workflowEnv) {
  const serializedSteps = steps.map((step) => yamlStep(step)).join("");
  const env = workflowEnv ? `env:\n${yamlMap(workflowEnv, 2)}` : "";
  return `name: synthetic\non: workflow_dispatch\n${env}jobs:\n  probe:\n    runs-on: ubuntu-latest\n    steps:\n${serializedSteps}`;
}

function yamlStep(step) {
  let source = "      -";
  if (step.name) source += ` name: ${step.name}\n`;
  else source += "\n";
  if (step.uses) source += `        uses: ${step.uses}\n`;
  if (step.if) source += `        if: ${step.if}\n`;
  if (step.env) source += `        env:\n${yamlMap(step.env, 10)}`;
  if (step.with) source += `        with:\n${yamlMap(step.with, 10)}`;
  if (step.run) source += `        run: ${JSON.stringify(step.run)}\n`;
  return source;
}

function yamlMap(values, indentation) {
  const prefix = " ".repeat(indentation);
  return Object.entries(values)
    .map(([key, value]) => `${prefix}${key}: ${JSON.stringify(value)}\n`)
    .join("");
}

function grant(overrides = {}) {
  return {
    file: arbitraryWorkflowPath,
    jobId: "probe",
    stepAnchor: `uses:${canonicalActionTarget}`,
    secretName: "DIGITALOCEAN_ACCESS_TOKEN",
    purpose: "application-runtime",
    ...overrides,
  };
}

async function runGuard(root, options = {}) {
  const nodeArguments = [
    ...(options.stackSize ? [`--stack-size=${options.stackSize}`] : []),
    ...(options.preload ? ["--require", options.preload] : []),
    guardEntrypoint,
    "--repository-root",
    root,
  ];
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, nodeArguments, {
      cwd: repositoryRoot,
      encoding: "utf8",
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
      maxBuffer: 10 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr, report: JSON.parse(stdout) };
  } catch (error) {
    return {
      exitCode: error.code,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      report: JSON.parse(error.stdout ?? "{}"),
    };
  }
}

function baseFixtureReport(overrides = {}) {
  return {
    schemaVersion: 1,
    workflowFileCount: 1,
    actionManifestFileCount: 1,
    totalYamlFileCount: 2,
    scannedYamlFileCount: 2,
    yamlCoverage: "2/2",
    totalIngressCount: 3,
    manifestedIngressCount: 3,
    manifestGrantCount: 3,
    ingressCoverage: "3/3",
    boundaryConsumerCount: 1,
    boundaryConsumers: [{ file: arbitraryWorkflowPath, jobId: "probe", stepAnchor: `uses:${canonicalActionTarget}` }],
    scannedExecutableSurfaceCount: 2,
    violations: [],
    ...overrides,
  };
}

function probeWorkflowSource() {
  return workflowSource([{ name: "Probe", uses: probeUses }]);
}

function probeActionSource() {
  return `${JSON.stringify({ name: "Synthetic authority probe", runs: { using: "composite", steps: [{ uses: probeUses }] } })}\n`;
}

function probeViolation(file, jobId) {
  return { code: "uses-kind-unknown", file, jobId, stepAnchor: `uses:${probeUses}` };
}

function lifecycleViolation(code, file) {
  return { code, file, jobId: "probe", stepAnchor: "name:Lifecycle probe#3" };
}

async function restoreLifecycleProbe(probe) {
  await writeFile(probe, benignLifecycleSource, "utf8");
  await utimes(probe, pinnedLifecycleTime, pinnedLifecycleTime);
}

function nodeActionSource(main) {
  return `name: node action\nruns:\n  using: node20\n  main: ${main}\n`;
}

function codes(report) {
  return report.violations.map(({ code }) => code);
}

async function write(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function writeJson(path, value) {
  await write(path, `${JSON.stringify(value, null, 2)}\n`);
}
