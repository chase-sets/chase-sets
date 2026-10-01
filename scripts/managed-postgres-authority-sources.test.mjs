import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTHORITY_ROOT,
  MANIFEST_PATH,
  generateManagedPostgresAuthority,
  validateManagedPostgresAuthoritySources,
  writeManagedPostgresAuthorityManifest,
} from "./managed-postgres-authority-sources.mjs";
import {
  parseNameStatusZ,
  parseVerifyStaticChain,
  runVerifyStaticScoped,
  selectVerifyStaticLinks,
} from "./verify-static-scoped.mjs";
import { ALWAYS_RUN, VERIFY_STATIC_SURFACES } from "./verify-static-surfaces.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
// Immutable pre-migration oracle for #8289; never derive expectations from candidate sources or ingress.
const migrationBase = "d6ac09c6422d6505b537d5c38e7259277083b918";
const sourceCli = "scripts/managed-postgres-authority-sources.mjs";
const guardCli = "scripts/managed-postgres-authority-guard.mjs";
const schemaPath = "scripts/managed-postgres-authority-manifest.schema.json";
const workflowPath = ".github/workflows/platform-production.yml";
const fragmentPath = `${AUTHORITY_ROOT}/platform-production/deploy.json`;
const boundaryTarget = "./.github/actions/export-managed-postgres-authority";
const reviewedCatalogDelta = [
  {
    file: ".github/workflows/platform-ephemeral-verification.yml",
    jobId: "verify-release",
    stepAnchor: "name:Apply verification Kubernetes runtime secrets#14",
    secretName: "CATALOG_OPERATOR_SESSION_KEYRING_JSON",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/platform-merge-gate-verification.yml",
    jobId: "verify",
    stepAnchor: "name:Apply gate Kubernetes runtime secrets#11",
    secretName: "CATALOG_OPERATOR_SESSION_KEYRING_JSON",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/platform-pr.yml",
    jobId: "preview-deploy-smoke",
    stepAnchor: "name:Apply preview Kubernetes runtime secrets#13",
    secretName: "CATALOG_OPERATOR_SESSION_KEYRING_JSON",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/platform-production.yml",
    jobId: "deploy-production",
    stepAnchor: "name:Apply production Kubernetes runtime secrets#33",
    secretName: "CATALOG_OPERATOR_SESSION_KEYRING_JSON",
    purpose: "application-runtime",
  },
  {
    file: ".github/workflows/platform-production.yml",
    jobId: "deploy-staging",
    stepAnchor: "name:Apply staging Kubernetes runtime secrets#31",
    secretName: "CATALOG_OPERATOR_SESSION_KEYRING_JSON",
    purpose: "application-runtime",
  },
];
const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function write(root, path, contents) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), contents);
}

async function writeJson(root, path, value) {
  await write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

async function readJson(root, path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

async function trackSources(root) {
  await execFileAsync("git", ["add", "-A", "--", AUTHORITY_ROOT], { cwd: root });
}

async function materializeImmutableMigrationInput(original) {
  const root = await mkdtemp(join(tmpdir(), "managed-postgres-authority-migration-"));
  roots.push(root);
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
  const { stdout } = await execFileAsync(
    "git",
    ["ls-tree", "-r", "--name-only", migrationBase, "--", ".github/workflows", AUTHORITY_ROOT],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  for (const path of stdout.split("\n").filter(Boolean)) {
    const file = await execFileAsync("git", ["show", `${migrationBase}:${path}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    await write(root, path, file.stdout);
  }
  const expectedOwners = new Map();
  for (const record of original.grants) {
    const owner = `${AUTHORITY_ROOT}/${basename(record.file).replace(/\.ya?ml$/, "")}/${record.jobId}.json`;
    expectedOwners.set(owner, [...(expectedOwners.get(owner) ?? []), record]);
  }
  for (const [owner, grants] of expectedOwners) await writeJson(root, owner, { grants });
  await trackSources(root);
  return root;
}

function grant(overrides = {}) {
  return {
    file: workflowPath,
    jobId: "deploy",
    stepAnchor: "step:1",
    secretName: "A_SECRET",
    purpose: "application-runtime",
    ...overrides,
  };
}

function dockerConsumer(overrides = {}) {
  return {
    file: workflowPath,
    jobId: "deploy",
    stepAnchor: "step:1",
    pathMapping: "/tmp/ca:/etc/ssl/ca.pem",
    ...overrides,
  };
}

async function fixture(fragment = { grants: [grant()] }) {
  const root = await mkdtemp(join(tmpdir(), "managed-postgres-authority-sources-"));
  roots.push(root);
  await execFileAsync("git", ["init", "--initial-branch=main"], { cwd: root });
  await writeJson(root, workflowPath, { jobs: { deploy: { "runs-on": "ubuntu-latest", steps: [] } } });
  await writeJson(root, fragmentPath, fragment);
  await trackSources(root);
  await mkdir(join(root, "scripts"), { recursive: true });
  await copyFile(join(repositoryRoot, schemaPath), join(root, schemaPath));
  return root;
}

async function boundaryFixture() {
  const grants = ["SPACES_ACCESS_ID", "SPACES_SECRET_KEY", "DIGITALOCEAN_ACCESS_TOKEN"].map((secretName) =>
    grant({ secretName, stepAnchor: `uses:${boundaryTarget}`, purpose: "managed-postgres-boundary" }),
  );
  const root = await fixture({ grants });
  await writeJson(root, workflowPath, {
    jobs: {
      deploy: {
        "runs-on": "ubuntu-latest",
        steps: [
          {
            uses: boundaryTarget,
            env: Object.fromEntries(grants.map(({ secretName }) => [secretName, `\${{ secrets.${secretName} }}`])),
            with: { environment: "staging", contexts: "catalog", "connection-mode": "pooled" },
          },
          { name: "Remove managed Postgres CA", if: "always()", run: 'rm -f -- "$PGSSLROOTCERT"' },
        ],
      },
    },
  });
  await writeJson(root, `${boundaryTarget.slice(2)}/action.yml`, {
    runs: { using: "composite", steps: [{ shell: "bash", run: "echo bounded" }] },
  });
  return root;
}

async function addWorkflow(root) {
  const file = ".github/workflows/unfamiliar-zone/new-owner.yaml";
  const source = `${AUTHORITY_ROOT}/new-owner/probe.json`;
  const record = grant({ file, jobId: "probe", secretName: "SYNTHETIC_NEW_SECRET" });
  await writeJson(root, file, {
    jobs: {
      probe: {
        "runs-on": "ubuntu-latest",
        steps: [{ env: { TOKEN: "${{ secrets.SYNTHETIC_NEW_SECRET }}" }, run: "echo bounded" }],
      },
    },
  });
  await writeJson(root, source, { grants: [record] });
  await trackSources(root);
  return { file, source, record };
}

async function runCli(script, root, args = []) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [join(repositoryRoot, script), "--repository-root", root, ...args],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    return { ...result, exitCode: 0 };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { stdout: error.stdout, stderr: error.stderr, exitCode: error.code };
  }
}

async function runGuard(root, args = []) {
  const result = await runCli(guardCli, root, args);
  return { ...result, report: JSON.parse(result.stdout) };
}

async function snapshot(root, prefix = "") {
  const files = {};
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(files, await snapshot(root, path));
    else files[path] = await readFile(join(root, path), "utf8");
  }
  return files;
}

// Sort object keys independently of generator tuple sorting; retain every occurrence.
function multiset(records) {
  return records
    .map((record) =>
      JSON.stringify(Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))),
    )
    .sort();
}

function expectParity(expected, actual) {
  expect(actual.schemaVersion).toBe(expected.schemaVersion);
  expect(multiset(actual.grants)).toEqual(multiset(expected.grants));
  expect(multiset(actual.dockerConsumers ?? [])).toEqual(multiset(expected.dockerConsumers ?? []));
}

describe("managed Postgres authority source generator", () => {
  it("authority source migration preserves all reviewed records", async () => {
    const { stdout } = await execFileAsync("git", ["show", `${migrationBase}:${MANIFEST_PATH}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
    });
    const original = JSON.parse(stdout);
    expect(original.grants).toHaveLength(1609);
    expect(original.dockerConsumers ?? []).toEqual([]);

    const historicalRoot = await materializeImmutableMigrationInput(original);
    const historicalGenerated = await generateManagedPostgresAuthority(historicalRoot);
    expectParity(original, historicalGenerated);

    const generated = await generateManagedPostgresAuthority(repositoryRoot);
    const canonical = await readJson(repositoryRoot, MANIFEST_PATH);
    const expected = { ...original, grants: [...original.grants, ...reviewedCatalogDelta] };
    expect(expected.grants).toHaveLength(1614);
    expect(generated.grants.filter(({ secretName }) => secretName === "CATALOG_OPERATOR_SESSION_KEYRING_JSON")).toEqual(
      reviewedCatalogDelta,
    );
    expectParity(expected, generated);
    expectParity(expected, canonical);
    expect(canonical).toEqual(generated);
    expect(generated).not.toHaveProperty("dockerConsumers");

    const expectedOwners = new Map();
    for (const record of expected.grants) {
      const owner = `${AUTHORITY_ROOT}/${basename(record.file).replace(/\.ya?ml$/, "")}/${record.jobId}.json`;
      expectedOwners.set(owner, [...(expectedOwners.get(owner) ?? []), record]);
    }
    const sources = await snapshot(repositoryRoot, AUTHORITY_ROOT);
    expect(Object.keys(sources).sort()).toEqual([...expectedOwners.keys()].sort());
    for (const [owner, records] of expectedOwners) {
      expect(multiset(JSON.parse(sources[owner]).grants)).toEqual(multiset(records));
    }

    const repeatedIndex = generated.grants.findIndex(
      (record, index, all) => all.findIndex((other) => JSON.stringify(other) === JSON.stringify(record)) < index,
    );
    expect(repeatedIndex).toBeGreaterThan(0);
    const mutations = [
      { ...generated, grants: generated.grants.slice(1) },
      { ...generated, grants: [...generated.grants, grant({ secretName: "SYNTHETIC_EXTRA_SECRET" })] },
      { ...generated, grants: generated.grants.filter((_, index) => index !== repeatedIndex) },
      { ...generated, grants: [...generated.grants, generated.grants[repeatedIndex]] },
      {
        ...generated,
        grants: generated.grants.map((record, index) => (index === 0 ? { ...record, purpose: "alerting" } : record)),
      },
      {
        ...generated,
        grants: generated.grants.filter((record) => JSON.stringify(record) !== JSON.stringify(reviewedCatalogDelta[0])),
      },
      {
        ...generated,
        grants: [...generated.grants, { ...reviewedCatalogDelta[0], stepAnchor: "name:Apply sixth Catalog grant#99" }],
      },
    ];
    for (const mutation of mutations) expect(() => expectParity(expected, mutation)).toThrow();

    const populated = {
      schemaVersion: 1,
      grants: [grant(), grant()],
      dockerConsumers: [dockerConsumer(), dockerConsumer({ pathMapping: "/var/ca:/etc/ssl/ca.pem" }), dockerConsumer()],
    };
    const root = await fixture({ grants: populated.grants, dockerConsumers: populated.dockerConsumers });
    const populatedResult = await generateManagedPostgresAuthority(root);
    expectParity(populated, populatedResult);
    for (const dockerConsumers of [
      populatedResult.dockerConsumers.slice(1),
      [...populatedResult.dockerConsumers, dockerConsumer()],
      [dockerConsumer({ pathMapping: "/wrong:/mapping" })],
    ]) {
      expect(() => expectParity(populated, { ...populatedResult, dockerConsumers })).toThrow();
    }
    await writeJson(root, fragmentPath, { grants: [grant()], dockerConsumers: [] });
    expect(await generateManagedPostgresAuthority(root)).not.toHaveProperty("dockerConsumers");
  });

  it("missing authority fragment cannot authorize ingress", async () => {
    const root = await boundaryFixture();
    const added = await addWorkflow(root);
    expect((await runCli(sourceCli, root)).exitCode).toBe(0);
    expect((await runGuard(root)).report.violations).toEqual([]);
    const yamlBefore = await readFile(join(root, added.file), "utf8");
    await rm(join(root, added.source));
    expect((await runCli(sourceCli, root)).exitCode).toBe(0);
    expect((await runCli(sourceCli, root, ["--check"])).exitCode).toBe(0);
    expect(await readFile(join(root, added.file), "utf8")).toBe(yamlBefore);
    expect((await readJson(root, MANIFEST_PATH)).grants).not.toContainEqual(added.record);
    const result = await runGuard(root);
    expect(result.exitCode).toBe(1);
    expect(result.report.ingressCoverage).toBe("3/4");
    expect(result.report.violations).toEqual([
      {
        code: "unmanifested-secret-ingress",
        file: added.file,
        jobId: "probe",
        stepAnchor: "step:1",
      },
    ]);
  });

  it("discovers tracked JSON only and refuses freshness bypass by removing all sources", async () => {
    const root = await boundaryFixture();
    await writeManagedPostgresAuthorityManifest(root);
    const before = await readJson(root, MANIFEST_PATH);
    await write(root, `${AUTHORITY_ROOT}/untracked/job.json`, "{invalid");
    await write(root, `${AUTHORITY_ROOT}/README.md`, "Not authorization data.\n");
    await execFileAsync("git", ["add", "--", `${AUTHORITY_ROOT}/README.md`], { cwd: root });
    expect(await generateManagedPostgresAuthority(root)).toEqual(before);
    expect((await runGuard(root)).exitCode).toBe(0);
    await rm(join(root, AUTHORITY_ROOT), { recursive: true });
    expect(await writeManagedPostgresAuthorityManifest(root, { check: true })).toBe(false);
    const stale = await runGuard(root);
    expect(stale.exitCode).toBe(1);
    expect(stale.report.violations.map(({ code }) => code)).toContain("authority-source-invalid");
    expect(await readJson(root, MANIFEST_PATH)).toEqual(before);
    await writeManagedPostgresAuthorityManifest(root);
    expect(await readJson(root, MANIFEST_PATH)).toEqual({ schemaVersion: 1, grants: [] });
    const empty = await runGuard(root);
    expect(empty.exitCode).toBe(1);
    expect(empty.report.violations.map(({ code }) => code)).toContain("unmanifested-secret-ingress");
  });

  describe("authority source validation and scoped selection fail closed", () => {
    const invalidFragments = [
      ["null source", null, "source shape"],
      ["array source", [], "source shape"],
      ["unknown root key", { grants: [], unexpected: true }, "source shape"],
      ["non-array grants", { grants: {} }, "source shape"],
      ["non-array consumers", { grants: [], dockerConsumers: {} }, "source shape"],
      ...[
        null,
        [],
        "grant",
        { ...grant(), unexpected: true },
        { ...grant(), secretName: "invalid-name" },
        { ...grant(), purpose: "unreviewed" },
      ].map((value, index) => [`malformed grant ${index}`, { grants: [value] }, "authority"]),
      ...Object.keys(grant()).flatMap((key) => [
        [
          `missing grant ${key}`,
          { grants: [Object.fromEntries(Object.entries(grant()).filter(([name]) => name !== key))] },
          "record shape",
        ],
        [`nested grant ${key}`, { grants: [{ ...grant(), [key]: {} }] }, "record shape"],
        [`empty grant ${key}`, { grants: [{ ...grant(), [key]: "" }] }, "record shape"],
      ]),
      ...Object.keys(dockerConsumer()).flatMap((key) => [
        [
          `missing consumer ${key}`,
          {
            grants: [],
            dockerConsumers: [Object.fromEntries(Object.entries(dockerConsumer()).filter(([name]) => name !== key))],
          },
          "record shape",
        ],
        [
          `nested consumer ${key}`,
          { grants: [], dockerConsumers: [{ ...dockerConsumer(), [key]: [] }] },
          "record shape",
        ],
      ]),
      ["null consumer", { grants: [], dockerConsumers: [null] }, "record shape"],
      [
        "unknown consumer key",
        { grants: [], dockerConsumers: [{ ...dockerConsumer(), unexpected: true }] },
        "record shape",
      ],
      ["wrong workflow", { grants: [grant({ file: ".github/workflows/other.yml" })] }, "owner mismatch"],
      ["wrong job", { grants: [grant({ jobId: "other" })] }, "owner mismatch"],
      ["wrong consumer owner", { grants: [], dockerConsumers: [dockerConsumer({ jobId: "other" })] }, "owner mismatch"],
    ];
    it.each(invalidFragments)("rejects %s without writing", async (_label, fragment, message) => {
      const root = await fixture(fragment);
      const before = await snapshot(root);
      const result = await validateManagedPostgresAuthoritySources(root, { checkManifest: false });
      expect(result.valid).toBe(false);
      expect(result.errors.join("; ")).toContain(message);
      await expect(generateManagedPostgresAuthority(root)).rejects.toThrow(/source validation failed/);
      await expect(writeManagedPostgresAuthorityManifest(root)).rejects.toThrow(/source validation failed/);
      expect(await snapshot(root)).toEqual(before);
    });

    it.each([
      ["invalid JSON", async (root) => write(root, fragmentPath, "{broken"), "not valid JSON"],
      [
        "orphaned job",
        async (root) =>
          rename(join(root, fragmentPath), join(root, `${AUTHORITY_ROOT}/platform-production/absent.json`)),
        "job is orphaned",
      ],
      ["orphaned workflow", async (root) => rm(join(root, workflowPath)), "not a workflow"],
      [
        "non-workflow owner",
        async (root) => {
          await rm(join(root, workflowPath));
          await writeJson(root, ".github/actions/platform-production/action.yml", {
            runs: { using: "composite", steps: [] },
          });
        },
        "not a workflow",
      ],
      [
        "owner case mismatch",
        async (root) =>
          rename(
            join(root, `${AUTHORITY_ROOT}/platform-production`),
            join(root, `${AUTHORITY_ROOT}/Platform-Production`),
          ),
        "case mismatch",
      ],
      [
        "ambiguous extension",
        async (root) => copyFile(join(root, workflowPath), join(root, ".github/workflows/platform-production.yaml")),
        "ambiguous workflow basename",
      ],
      [
        "ambiguous nested basename",
        async (root) =>
          write(root, ".github/workflows/nested/platform-production.yml", await readFile(join(root, workflowPath))),
        "ambiguous workflow basename",
      ],
      [
        "ambiguous case",
        async (root) => copyFile(join(root, workflowPath), join(root, ".github/workflows/Platform-Production.yaml")),
        "ambiguous workflow basename casing",
      ],
      [
        "cross-fragment duplicate grants",
        async (root) => {
          await writeJson(root, workflowPath, { jobs: { deploy: {}, other: {} } });
          await writeJson(root, `${AUTHORITY_ROOT}/platform-production/other.json`, { grants: [grant()] });
        },
        "owner mismatch",
      ],
      [
        "cross-fragment duplicate consumers",
        async (root) => {
          await writeJson(root, workflowPath, { jobs: { deploy: {}, other: {} } });
          await writeJson(root, fragmentPath, { grants: [], dockerConsumers: [dockerConsumer()] });
          await writeJson(root, `${AUTHORITY_ROOT}/platform-production/other.json`, {
            grants: [],
            dockerConsumers: [dockerConsumer()],
          });
        },
        "owner mismatch",
      ],
      [
        "nested source path",
        async (root) =>
          writeJson(root, `${AUTHORITY_ROOT}/nested/platform-production/deploy.json`, { grants: [grant()] }),
        "must be <workflow-basename>",
      ],
      [
        "invalid workflow YAML",
        async (root) => write(root, workflowPath, "jobs: [unterminated"),
        "workflow cannot be parsed",
      ],
    ])("rejects %s", async (_label, mutate, message) => {
      const root = await fixture();
      await mutate(root);
      await trackSources(root);
      const result = await validateManagedPostgresAuthoritySources(root, { checkManifest: false });
      expect(result.valid).toBe(false);
      expect(result.errors.join("; ")).toContain(message);
      await expect(generateManagedPostgresAuthority(root)).rejects.toThrow(/source validation failed/);
    });

    it("sorts every tuple field by code unit across shuffled sources and records", async () => {
      const grants = [];
      const dockerConsumers = [];
      for (const owner of ["Z-owner", "a-owner"])
        for (const jobId of ["Z_job", "a_job"])
          for (const stepAnchor of ["Z", "a"]) {
            const file = `.github/workflows/${owner}.yml`;
            for (const secretName of ["Z_SECRET", "a_SECRET"])
              for (const purpose of ["alerting", "application-runtime"])
                grants.push(grant({ file, jobId, stepAnchor, secretName, purpose }));
            for (const pathMapping of ["/Z:/ca", "/a:/ca"])
              dockerConsumers.push(dockerConsumer({ file, jobId, stepAnchor, pathMapping }));
          }
      const results = [];
      for (const reverse of [false, true]) {
        const root = await fixture({ grants: [] });
        const ordered = reverse ? [...grants].reverse() : grants;
        const consumers = reverse ? [...dockerConsumers].reverse() : dockerConsumers;
        const owners = [...new Set(ordered.map(({ file, jobId }) => `${file}\0${jobId}`))];
        for (const owner of owners) {
          const [file, jobId] = owner.split("\0");
          await writeJson(root, file, { jobs: { Z_job: {}, a_job: {} } });
          await writeJson(root, `${AUTHORITY_ROOT}/${basename(file, ".yml")}/${jobId}.json`, {
            grants: ordered.filter((r) => r.file === file && r.jobId === jobId),
            dockerConsumers: consumers.filter((r) => r.file === file && r.jobId === jobId),
          });
        }
        await trackSources(root);
        results.push(await generateManagedPostgresAuthority(root));
      }
      const grantTuples = grants
        .map(({ file, jobId, stepAnchor, secretName, purpose }) =>
          [file, jobId, stepAnchor, secretName, purpose].join("\0"),
        )
        .sort();
      const dockerTuples = dockerConsumers
        .map(({ file, jobId, stepAnchor, pathMapping }) => [file, jobId, stepAnchor, pathMapping].join("\0"))
        .sort();
      expect(results[0].grants.map((r) => [r.file, r.jobId, r.stepAnchor, r.secretName, r.purpose].join("\0"))).toEqual(
        grantTuples,
      );
      expect(results[0].dockerConsumers.map((r) => [r.file, r.jobId, r.stepAnchor, r.pathMapping].join("\0"))).toEqual(
        dockerTuples,
      );
      expect(results[1]).toEqual(results[0]);
    });

    it("authority source validation and scoped selection fail closed", async () => {
      const root = await boundaryFixture();
      expect((await runCli(sourceCli, root)).exitCode).toBe(0);
      expect((await runCli(sourceCli, root, ["--check"])).exitCode).toBe(0);
      expect((await runGuard(root)).exitCode).toBe(0);
      await addWorkflow(root);
      expect((await validateManagedPostgresAuthoritySources(root, { checkManifest: false })).valid).toBe(true);
      const before = await snapshot(root);
      const validation = await validateManagedPostgresAuthoritySources(root);
      expect(validation.errors).toEqual(["canonical manifest is stale; regenerate from authority fragments"]);
      expect(await writeManagedPostgresAuthorityManifest(root, { check: true })).toBe(false);
      expect((await runCli(sourceCli, root, ["--check"])).exitCode).toBe(1);
      const direct = await runGuard(root);
      expect(direct.exitCode).toBe(1);
      expect(direct.report.violations.map(({ code }) => code)).toContain("authority-source-invalid");
      expect(await snapshot(root)).toEqual(before);
      expect((await runCli(sourceCli, root)).exitCode).toBe(0);
      expect((await runCli(sourceCli, root, ["--check"])).exitCode).toBe(0);
      expect((await runGuard(root)).exitCode).toBe(0);
    });

    it.each([
      ["added source", `A\0${fragmentPath}\0`],
      ["edited source", `M\0${fragmentPath}\0`],
      ["deleted source", `D\0${fragmentPath}\0`],
      ["renamed source", `R100\0${fragmentPath}\0${AUTHORITY_ROOT}/new-owner/probe.json\0`],
      ["renamed out of sources", `R100\0${fragmentPath}\0elsewhere/reviewed.json\0`],
      ["arbitrary executable", "M\0unknown-zone/entry.mjs\0"],
    ])("selects generator and independent guard for %s", async (_label, diff) => {
      const pkg = await readJson(repositoryRoot, "package.json");
      const chain = parseVerifyStaticChain(pkg);
      const selected = selectVerifyStaticLinks({
        chain,
        changedFiles: parseNameStatusZ(diff),
        repoRoot: repositoryRoot,
      });
      expect(VERIFY_STATIC_SURFACES["check:managed-postgres-authority"].classification).toBe(ALWAYS_RUN);
      expect(chain.map(({ name }) => name)).toContain("check:managed-postgres-authority");
      expect(selected.selected.map(({ name }) => name)).toContain("check:managed-postgres-authority");
      expect(pkg.scripts["check:managed-postgres-authority"]).toBe(`node ./${guardCli}`);

      const root = await boundaryFixture();
      await writeManagedPostgresAuthorityManifest(root);
      await addWorkflow(root);
      const visited = [];
      const status = await runVerifyStaticScoped({
        repoRoot: repositoryRoot,
        env: { CHANGED_FILES_JSON: JSON.stringify(parseNameStatusZ(diff)) },
        readPackageJson: () => pkg,
        stdout: () => {},
        stderr: () => {},
        runLink: async ({ name }) => {
          visited.push(name);
          // Exercise the selected authority command; unrelated static guards are outside this fixture.
          if (name !== "check:managed-postgres-authority") return 0;
          return (await runCli(guardCli, root)).exitCode;
        },
      });
      expect(visited).toContain("check:managed-postgres-authority");
      expect(status).toBe(1);
    });
  });

  it("new workflow authority uses only its owner fragment", async () => {
    const root = await boundaryFixture();
    expect((await runCli(sourceCli, root)).exitCode).toBe(0);
    const before = await snapshot(root);
    const added = await addWorkflow(root);
    expect((await runCli(sourceCli, root)).exitCode).toBe(0);
    const after = await snapshot(root);
    expect(
      Object.keys(after)
        .filter((path) => !(path in before))
        .sort(),
    ).toEqual([added.file, added.source].sort());
    for (const path of Object.keys(before).filter((path) => path !== MANIFEST_PATH))
      expect(after[path]).toBe(before[path]);
    expectParity(
      { schemaVersion: 1, grants: [...JSON.parse(before[MANIFEST_PATH]).grants, added.record] },
      JSON.parse(after[MANIFEST_PATH]),
    );
    const result = await runGuard(root);
    expect(result.exitCode).toBe(0);
    expect(result.report.violations).toEqual([]);
    expect(result.report.ingressCoverage).toBe("4/4");
    expect(result.report.manifestGrantCount).toBe(4);
  });

  it("rejects the retired manifest writer flag without canonical or source writes", async () => {
    const root = await boundaryFixture();
    await writeManagedPostgresAuthorityManifest(root);
    await addWorkflow(root);
    const before = await snapshot(root);
    const result = await runCli(guardCli, root, ["--generate-manifest"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("--generate-manifest has been retired");
    expect(await snapshot(root)).toEqual(before);
    const guardSource = await readFile(join(repositoryRoot, guardCli), "utf8");
    for (const retired of ["writeSuggestedManifest", "suggestedManifestForReport", "suggestedPurpose"])
      expect(guardSource).not.toContain(retired);
  });
});
