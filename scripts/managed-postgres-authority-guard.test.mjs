import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const guardEntrypoint = join(repositoryRoot, "scripts", "managed-postgres-authority-guard.mjs");
const schemaPath = join(repositoryRoot, "scripts", "managed-postgres-authority-manifest.schema.json");
const fixtureRoots = [];
const arbitraryWorkflowPath = ".github/workflows/asteroid-field/unfamiliar-probe.yaml";
const canonicalActionTarget = "./.github/actions/export-managed-postgres-authority";
const canonicalActionPath = ".github/actions/export-managed-postgres-authority/action.yml";
const rootSecretNames = ["SPACES_ACCESS_ID", "SPACES_SECRET_KEY", "DIGITALOCEAN_ACCESS_TOKEN"];

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
});

async function createFixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "mpa-oracle-unfamiliar-"));
  fixtureRoots.push(root);
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
    await write(join(root, relativePath), contents);
  }
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(schemaPath, join(root, "scripts/managed-postgres-authority-manifest.schema.json"));
  await writeJson(join(root, "scripts/managed-postgres-authority-manifest.json"), {
    schemaVersion: 1,
    grants: [...baseGrants, ...(options.extraGrants ?? [])],
  });
  return root;
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

async function runGuard(root) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [guardEntrypoint, "--repository-root", root], {
      cwd: repositoryRoot,
      encoding: "utf8",
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
