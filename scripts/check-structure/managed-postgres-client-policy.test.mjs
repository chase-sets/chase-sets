import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GIT_LISTING_MAX_BUFFER } from "../lib/git-listing.mjs";
import {
  managedPostgresClientPolicyFailures,
  managedPostgresClientPolicySource,
  managedPostgresClientPolicyVersion,
  scanManagedPostgresClientPolicy,
} from "./managed-postgres-client-policy.mjs";

const guardPath = fileURLToPath(new URL("./managed-postgres-client-policy.mjs", import.meta.url));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// A minimal repository with the same trust shapes as the real one: one seam
// owner, one runner URL producer behind a local action, a pod command, a
// Terraform local-exec and a dispatching ops script.
const base = {
  ".gitignore": "dist/\ngenerated/\nartifacts/\n",
  "package.json": JSON.stringify({
    name: "fixture",
    scripts: {
      start: "node --import tsx app/main.ts",
      ops: "node tools/ops.mjs",
    },
  }),
  "lib/pool.ts": [
    'import pg from "pg";',
    "export function admitPostgresClientConnection(url: string) { return url; }",
    "export function createPgPool(url: string) { return new pg.Pool({ connectionString: admitPostgresClientConnection(url) }); }",
    "export function createPgClient(url: string) { return new pg.Client({ connectionString: admitPostgresClientConnection(url) }); }",
  ].join("\n"),
  "lib/url-producer.mjs": [
    "export function managedPostgresRunnerCaPath(runnerTemp) { return `${runnerTemp}/ca.pem`; }",
    "export function managedPostgresConnectionUrl(url) { return url; }",
  ].join("\n"),
  ".github/actions/export-authority/action.yml": [
    "name: export",
    "runs:",
    "  using: composite",
    "  steps:",
    "    - shell: bash",
    '      run: node lib/url-producer.mjs >> "$GITHUB_ENV"',
  ].join("\n"),
  ".github/workflows/ops.yml": [
    "on: workflow_dispatch",
    "jobs:",
    "  managed:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: ./.github/actions/export-authority",
    "      - run: node tools/runner-client.mjs",
    "      - run: pnpm run ops report",
    "  sandbox:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: node tools/sandbox-client.mjs",
  ].join("\n"),
  "deploy/values.yaml": ["components:", "  api:", '    command: "pnpm run start"'].join("\n"),
  "app/main.ts": [
    'import { createPgPool } from "../lib/pool.ts";',
    "createPgPool(process.env.DATABASE_URL ?? '');",
  ].join("\n"),
  "tools/runner-client.mjs": [
    'import { createPgClient } from "../lib/pool.ts";',
    "await createPgClient(process.env.DATABASE_URL).connect();",
  ].join("\n"),
  "tools/sandbox-client.mjs": [
    'import pg from "pg";',
    'await new pg.Client({ connectionString: "postgresql://localhost:5432/app" }).connect();',
  ].join("\n"),
  "tools/ops.mjs": [
    'import { spawn } from "node:child_process";',
    "const commands = {",
    '  report: { script: "report.mjs" },',
    '  "local-measure": { script: "local-measure.mjs" },',
    "};",
    "spawn(process.execPath, [new URL(commands[process.argv[2]].script, import.meta.url).pathname]);",
  ].join("\n"),
  "tools/report.mjs": ['import { createPgClient } from "../lib/pool.ts";', "createPgClient(process.env.URL);"].join(
    "\n",
  ),
  "tools/local-measure.mjs": ['import pg from "pg";', "new pg.Client({ connectionString: process.env.URL });"].join(
    "\n",
  ),
  "tools/grant.mjs": ['import { createPgClient } from "../lib/pool.ts";', "createPgClient(process.env.URL);"].join(
    "\n",
  ),
  "infra/main.tf": [
    'resource "null_resource" "grant" {',
    '  provisioner "local-exec" {',
    '    working_dir = "${path.module}/.."',
    '    command     = "node tools/grant.mjs"',
    "  }",
    "}",
  ].join("\n"),
};

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: GIT_LISTING_MAX_BUFFER,
    windowsHide: true,
  });
}

function fixtureRepo(overrides = {}, { removals = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "managed-postgres-client-policy-"));
  roots.push(root);
  const files = { ...base, ...overrides };
  for (const removal of removals) delete files[removal];
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, ["init", "-q"]);
  git(root, ["config", "core.autocrlf", "false"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "fixture"]);
  return root;
}

// Runs the real CLI entrypoint the package script runs.
function runGuard(root) {
  const out = join(root, "artifacts", "inventory.json");
  const result = spawnSync(process.execPath, [guardPath, "--out", out], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return { ...result, report: JSON.parse(readFileSync(out, "utf8")) };
}

function member(report, path) {
  return report.members.find((entry) => entry.path === path);
}

describe("managed Postgres client policy inventory (#7313)", () => {
  it("partitions every tracked file and admits the canonical shapes with their execution locations", () => {
    const root = fixtureRepo();
    const { status, stdout, report } = runGuard(root);

    expect(status, stdout).toBe(0);
    expect(report.derivation).toMatchObject({
      command: "pnpm run check:managed-postgres-client-policy",
      source: managedPostgresClientPolicySource,
      head: git(root, ["rev-parse", "HEAD"]).trim(),
      version: managedPostgresClientPolicyVersion,
    });
    const tracked = git(root, ["ls-files", "-z", "--cached"]).split("\0").filter(Boolean);
    expect(report.total).toBe(tracked.length);
    expect(report.scanned).toBe(report.total);
    expect(report.handled + report.indeterminate).toBe(report.total);
    expect(Object.values(report.classes).reduce((sum, count) => sum + count, 0)).toBe(report.total);
    expect([report.indeterminate, report.unsafe]).toEqual([0, 0]);
    expect(stdout).toContain(`scanned ${report.total}/${report.total}`);

    expect(member(report, "lib/pool.ts").class).toBe("validated-seam-owner");
    expect(member(report, "app/main.ts")).toMatchObject({
      class: "validated-seam-consumer",
      locations: ["pod:managed-authority"],
    });
    expect(member(report, "tools/runner-client.mjs")).toMatchObject({
      class: "validated-seam-consumer",
      locations: ["github-runner:managed-authority"],
    });
    expect(member(report, "tools/grant.mjs")).toMatchObject({
      class: "validated-seam-consumer",
      locations: ["terraform-runner:managed-authority"],
    });
    // A runner job without the managed URL producer reaches only local databases.
    expect(member(report, "tools/sandbox-client.mjs")).toMatchObject({
      class: "runner-local-tool",
      locations: ["github-runner"],
    });
    // The ops job selects `report`; the other dispatch entry stays a local tool.
    expect(member(report, "tools/report.mjs").locations).toEqual(["github-runner:managed-authority"]);
    expect(member(report, "tools/local-measure.mjs")).toMatchObject({
      class: "local-tool",
      locations: ["operator-invoked"],
    });
    expect(member(report, "tools/runner-client.mjs").reachability).toEqual([
      ".github/workflows/ops.yml#jobs.managed (entrypoint github-runner:managed-authority)",
      "tools/runner-client.mjs (command tools/runner-client.mjs)",
    ]);
  });

  const bypasses = [
    {
      name: "aliased pg in pod code",
      files: {
        "app/main.ts":
          'import { Client as Conn } from "pg";\nawait new Conn({ connectionString: process.env.DATABASE_URL }).connect();',
      },
      path: "app/main.ts",
      reason: "seam-bypass-driver",
      location: "pod:managed-authority",
    },
    {
      name: "raw pg behind a pod command that runs an ignored build output",
      files: {
        "package.json": JSON.stringify({
          name: "fixture",
          scripts: { ...JSON.parse(base["package.json"]).scripts, serve: "node dist/worker.js" },
        }),
        "deploy/values.yaml": `${base["deploy/values.yaml"]}\n  worker:\n    command: "pnpm run serve"`,
        "app/worker.ts":
          'import pg from "pg";\nawait new pg.Client({ connectionString: process.env.DATABASE_URL }).connect();',
      },
      path: "app/worker.ts",
      reason: "seam-bypass-driver",
      location: "pod:managed-authority",
    },
    {
      name: "default pg in a managed runner client",
      files: {
        "tools/runner-client.mjs":
          'import pg from "pg";\nawait new pg.Pool({ connectionString: process.env.DATABASE_URL }).query("select 1");',
      },
      path: "tools/runner-client.mjs",
      reason: "seam-bypass-driver",
      location: "github-runner:managed-authority",
    },
    {
      name: "dynamic pg",
      files: {
        "tools/runner-client.mjs":
          'const { default: pg } = await import("pg");\nawait new pg.Client(process.env.DATABASE_URL).connect();',
      },
      path: "tools/runner-client.mjs",
      reason: "seam-bypass-driver",
    },
    {
      name: "shared-pool call",
      files: {
        "tools/shared.mjs":
          'import pg from "pg";\nexport const sharedPool = (url) => new pg.Pool({ connectionString: url });',
        "tools/runner-client.mjs":
          'import { sharedPool } from "./shared.mjs";\nawait sharedPool(process.env.DATABASE_URL).query("select 1");',
      },
      path: "tools/shared.mjs",
      reason: "seam-bypass-driver",
      chainEnd: "tools/shared.mjs (import ./shared.mjs)",
    },
    {
      name: "copied parser, even off every entrypoint",
      files: {
        "tools/parser.mjs": [
          'import { readFileSync } from "node:fs";',
          "export function ssl(url) {",
          "  const parsed = new URL(url);",
          '  return { ca: readFileSync(parsed.searchParams.get("sslrootcert"), "utf8") };',
          "}",
        ].join("\n"),
      },
      path: "tools/parser.mjs",
      reason: "copied-parser",
    },
    {
      name: "bare psql in a managed workflow step",
      files: {
        ".github/workflows/ops.yml": base[".github/workflows/ops.yml"].replace(
          "      - run: node tools/runner-client.mjs",
          '      - run: psql "$DATABASE_URL_CATALOG" -c "select 1"',
        ),
      },
      path: ".github/workflows/ops.yml",
      reason: "bare-postgres-cli psql",
    },
    {
      name: "bare pg_dump through a package script",
      files: {
        "package.json": JSON.stringify({
          name: "fixture",
          scripts: { ...JSON.parse(base["package.json"]).scripts, backup: 'pg_dump --dbname "$DATABASE_URL"' },
        }),
        ".github/workflows/ops.yml": base[".github/workflows/ops.yml"].replace(
          "      - run: node tools/runner-client.mjs",
          "      - run: pnpm run backup",
        ),
      },
      path: "package.json",
      reason: "bare-postgres-cli pg_dump",
    },
    {
      name: "bare pg_restore spawned by a managed runner client",
      files: {
        "tools/runner-client.mjs":
          'import { spawnSync } from "node:child_process";\nspawnSync("pg_restore", ["--dbname", process.env.DATABASE_URL, "dump"]);',
      },
      path: "tools/runner-client.mjs",
      reason: "bare-postgres-cli pg_restore",
    },
    {
      name: "Terraform local-exec",
      files: {
        "infra/main.tf": base["infra/main.tf"].replace(
          '"node tools/grant.mjs"',
          '"psql \\"$GRANT_URL\\" -f grants.sql"',
        ),
      },
      path: "infra/main.tf",
      reason: "bare-postgres-cli psql",
      location: "terraform-runner:managed-authority",
    },
    {
      name: "inline program in a managed workflow step",
      files: {
        ".github/workflows/ops.yml": base[".github/workflows/ops.yml"].replace(
          "      - run: node tools/runner-client.mjs",
          [
            "      - run: |",
            "          node --input-type=module <<'NODE'",
            '          import pg from "pg";',
            "          await new pg.Client(process.env.DATABASE_URL_CATALOG).connect();",
            "          NODE",
          ].join("\n"),
        ),
      },
      path: ".github/workflows/ops.yml",
      reason: "seam-bypass-driver",
    },
    {
      name: "reusable action",
      files: {
        ".github/actions/query/action.yml": [
          "name: query",
          "runs:",
          "  using: composite",
          "  steps:",
          "    - shell: bash",
          '      run: psql "$DATABASE_URL_CATALOG" -c "select 1"',
        ].join("\n"),
        ".github/workflows/ops.yml": base[".github/workflows/ops.yml"].replace(
          "      - run: node tools/runner-client.mjs",
          "      - uses: ./.github/actions/query",
        ),
      },
      path: ".github/actions/query/action.yml",
      reason: "bare-postgres-cli psql",
    },
    {
      name: "test-library script run by a managed job",
      files: {
        "tools/runner-client.mjs": [
          'import test from "node:test";',
          'import pg from "pg";',
          'test("reads", async () => { await new pg.Client(process.env.DATABASE_URL).connect(); });',
        ].join("\n"),
      },
      path: "tools/runner-client.mjs",
      reason: "seam-bypass-driver",
      location: "github-runner:managed-authority",
    },
    {
      name: "test-library helper imported by a managed runner client",
      files: {
        "tools/helper.mjs": [
          'import { vi } from "vitest";',
          'import pg from "pg";',
          "export const open = (url) => new pg.Pool({ connectionString: url });",
        ].join("\n"),
        "tools/runner-client.mjs":
          'import { open } from "./helper.mjs";\nawait open(process.env.DATABASE_URL).query("select 1");',
      },
      path: "tools/helper.mjs",
      reason: "seam-bypass-driver",
      chainEnd: "tools/helper.mjs (import ./helper.mjs)",
    },
    {
      name: "kubectl exec psql against a managed URL in a workflow step",
      files: {
        ".github/workflows/ops.yml": base[".github/workflows/ops.yml"].replace(
          "      - run: node tools/runner-client.mjs",
          '      - run: kubectl exec deploy/api -- psql "$DATABASE_URL_CATALOG" -c "select 1"',
        ),
      },
      path: ".github/workflows/ops.yml",
      reason: "in-container-cli-target psql",
    },
    {
      name: "kubectl exec psql argv with a managed URL",
      files: {
        "tools/runner-client.mjs": [
          'import { spawnSync } from "node:child_process";',
          'spawnSync("kubectl", ["exec", "deploy/api", "--", "psql", process.env.DATABASE_URL, "-c", "select 1"]);',
        ].join("\n"),
      },
      path: "tools/runner-client.mjs",
      reason: "in-container-cli-target psql",
      location: "github-runner:managed-authority",
    },
    {
      name: "kubectl exec psql with an attached host flag in a workflow step",
      files: {
        ".github/workflows/ops.yml": base[".github/workflows/ops.yml"].replace(
          "      - run: node tools/runner-client.mjs",
          '      - run: kubectl exec sample -- psql -hsynthetic-managed.invalid -c "select 1"',
        ),
      },
      path: ".github/workflows/ops.yml",
      reason: "in-container-cli-target psql",
    },
    {
      name: "kubectl exec psql argv with an attached short host flag",
      files: {
        "tools/runner-client.mjs": [
          'import { spawnSync } from "node:child_process";',
          'spawnSync("kubectl", ["exec", "sample", "--", "psql", "-hsynthetic-managed.invalid", "-c", "select 1"]);',
        ].join("\n"),
      },
      path: "tools/runner-client.mjs",
      reason: "in-container-cli-target psql",
      location: "github-runner:managed-authority",
    },
    {
      name: "kubectl exec psql argv with an attached long host flag",
      files: {
        "tools/runner-client.mjs": [
          'import { spawnSync } from "node:child_process";',
          'spawnSync("kubectl", ["exec", "sample", "--", "psql", "--host=synthetic-managed.invalid", "-c", "select 1"]);',
        ].join("\n"),
      },
      path: "tools/runner-client.mjs",
      reason: "in-container-cli-target psql",
      location: "github-runner:managed-authority",
    },
    {
      name: "require producer",
      files: { "tools/urls.mjs": "export const url = (host) => `postgresql://app@${host}:25060/app?sslmode=require`;" },
      path: "tools/urls.mjs",
      reason: "tls-downgrade sslmode=require",
    },
    {
      name: "rejectUnauthorized:false",
      files: {
        "app/main.ts":
          'import { createPgPool } from "../lib/pool.ts";\nexport const ssl = { rejectUnauthorized: false };\ncreatePgPool("");',
      },
      path: "app/main.ts",
      reason: "tls-downgrade rejectUnauthorized: false",
    },
  ];

  it.each(bypasses)("fails the real entrypoint for $name", ({ files, path, reason, location, chainEnd }) => {
    const { status, stderr, report } = runGuard(fixtureRepo(files));

    expect(status).toBe(1);
    const flagged = member(report, path);
    expect(flagged?.class, stderr).toBe("unsafe");
    expect(flagged.reasons).toContain(reason);
    if (location) expect(flagged.locations).toContain(location);
    if (chainEnd) expect(flagged.reachability.at(-1)).toBe(chainEnd);
    expect(stderr).toContain(`unsafe: ${path}`);
    expect(report.unsafe).toBeGreaterThan(0);
    expect(managedPostgresClientPolicyFailures(report)).toContain("unsafe-members");
  });

  it("classifies by code shape, not by file name or directory (renamed-file control)", () => {
    const renamed = fixtureRepo({
      "zz/any-name.mjs":
        'import pg from "pg";\nawait new pg.Pool({ connectionString: process.env.DATABASE_URL }).query("select 1");',
      ".github/workflows/ops.yml": base[".github/workflows/ops.yml"].replace(
        "tools/runner-client.mjs",
        "zz/any-name.mjs",
      ),
    });
    expect(member(runGuard(renamed).report, "zz/any-name.mjs")).toMatchObject({
      class: "unsafe",
      reasons: ["seam-bypass-driver"],
    });

    // Moving the seam owner keeps every consumer classified: the owner is the
    // unique module defining the validated factories.
    const moved = fixtureRepo();
    mkdirSync(join(moved, "elsewhere"), { recursive: true });
    renameSync(join(moved, "lib/pool.ts"), join(moved, "elsewhere/connections.ts"));
    for (const path of ["app/main.ts", "tools/runner-client.mjs", "tools/report.mjs", "tools/grant.mjs"]) {
      const text = readFileSync(join(moved, path), "utf8").replace("../lib/pool.ts", "../elsewhere/connections.ts");
      writeFileSync(join(moved, path), text);
    }
    git(moved, ["add", "-A"]);
    git(moved, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "move"]);
    const { status, report } = runGuard(moved);
    expect(status).toBe(0);
    expect(member(report, "elsewhere/connections.ts").class).toBe("validated-seam-owner");
    expect(member(report, "app/main.ts").class).toBe("validated-seam-consumer");

    // A second definer is not an owner: both stay INDETERMINATE.
    const duplicate = runGuard(fixtureRepo({ "copy/pool.ts": base["lib/pool.ts"] }));
    expect(duplicate.status).toBe(1);
    expect(member(duplicate.report, "copy/pool.ts")).toMatchObject({
      class: "INDETERMINATE",
      reasons: ["duplicate-trust-owner"],
    });
  });

  it("follows a tsconfig wildcard alias literally, even when the specifier holds `$` patterns", () => {
    const root = fixtureRepo({
      "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@fixture/*": ["drivers/*"] } } }),
      "drivers/$&raw.mjs":
        'import pg from "pg";\nawait new pg.Pool({ connectionString: process.env.DATABASE_URL }).query("select 1");',
      "tools/runner-client.mjs": 'import "@fixture/$&raw.mjs";',
    });
    expect(member(runGuard(root).report, "drivers/$&raw.mjs")).toMatchObject({
      class: "unsafe",
      reasons: ["seam-bypass-driver"],
    });
  });

  it("fails instead of passing vacuously when a trust anchor disappears", () => {
    const withoutProducer = runGuard(fixtureRepo({}, { removals: ["lib/url-producer.mjs"] }));
    expect(withoutProducer.status).toBe(1);
    expect(withoutProducer.report.trustAnchors.runnerUrlProducer).toEqual([]);
    expect(withoutProducer.stderr).toContain("runner-url-producer-not-unique");

    const withoutSeam = runGuard(fixtureRepo({}, { removals: ["lib/pool.ts"] }));
    expect(withoutSeam.status).toBe(1);
    expect(managedPostgresClientPolicyFailures(withoutSeam.report)).toContain("validated-seam-not-unique");
  });

  it("keeps safe controls green: local-socket in-container CLIs, local tools and tests", () => {
    const { status, stderr, report } = runGuard(
      fixtureRepo({
        // Managed jobs whose container execs name no connection target reach only the container's own socket.
        ".github/workflows/ops.yml": base[".github/workflows/ops.yml"].replace(
          "      - run: node tools/runner-client.mjs",
          [
            '      - run: docker exec "$POSTGRES_CONTAINER" psql -U postgres -c "select 1"',
            '      - run: kubectl exec deploy/preview-postgres -c postgres -- psql --username postgres -c "select 1"',
            "      - run: kubectl exec deploy/preview-postgres -c postgres -- psql -h/var/run/postgresql -U postgres",
            "      - run: kubectl exec deploy/preview-postgres -c postgres -- psql --host=/var/run/postgresql -U postgres",
            "      - run: node tools/snapshot.mjs",
          ].join("\n"),
        ),
        "tools/snapshot.mjs": [
          'import { spawnSync } from "node:child_process";',
          "const statements = ['SHOW max_connections'];",
          'spawnSync("kubectl", ["exec", "deployment/preview-postgres", "--container", "postgres", "--", "psql",',
          '  "--username", "postgres", "-h", "/var/run/postgresql", ...statements.flatMap((s) => ["--command", s])]);',
        ].join("\n"),
        "tools/compose.mjs": [
          'import { spawnSync } from "node:child_process";',
          'spawnSync("docker", ["compose", "exec", "-T", "postgres", "psql", "-U", "postgres"]);',
        ].join("\n"),
        "tools/client.test.mjs": [
          'import { it } from "vitest";',
          'import pg from "pg";',
          'it("refuses", () => new pg.Client({ ssl: { rejectUnauthorized: false } }));',
        ].join("\n"),
      }),
    );

    expect(status, stderr).toBe(0);
    expect(member(report, ".github/workflows/ops.yml").class).toBe("in-container-cli");
    expect(member(report, "tools/snapshot.mjs")).toMatchObject({
      class: "in-container-cli",
      locations: ["github-runner:managed-authority"],
    });
    expect(member(report, "tools/compose.mjs").class).toBe("in-container-cli");
    expect(member(report, "tools/client.test.mjs")).toMatchObject({ class: "test-tool", locations: ["test-runner"] });
  });

  it("treats prose and data as data-only and unknown executable grammars as INDETERMINATE", () => {
    const data = runGuard(
      fixtureRepo({
        "docs/runbook.md":
          '```sh\npsql "postgresql://app@db?sslmode=require"\n```\n\n```js\nimport pg from "pg";\n```\n',
        "fixtures/urls.csv": "postgresql://app@db?sslmode=require\n",
      }),
    );
    expect(data.status).toBe(0);
    expect(data.report.classes["data-only"]).toBeGreaterThanOrEqual(2);
    expect(member(data.report, "docs/runbook.md")).toBeUndefined();

    const unknown = runGuard(fixtureRepo({ "tools/export.py": "import psycopg2\npsycopg2.connect('')\n" }));
    expect(unknown.status).toBe(1);
    expect(member(unknown.report, "tools/export.py")).toMatchObject({
      class: "INDETERMINATE",
      reasons: ["client-shape-in-unsupported-grammar"],
    });
    expect(unknown.report.handled + unknown.report.indeterminate).toBe(unknown.report.total);
  });

  it("reads only the git ls-files -z --cached source, so clean and built trees inventory identically", () => {
    const root = fixtureRepo();
    const clean = scanManagedPostgresClientPolicy({ repoRoot: root, head: "fixture" });

    // Build outputs, generated files and untracked scratch carry raw clients but are not tracked.
    for (const [path, content] of Object.entries({
      "dist/main.js": 'import pg from "pg";\nnew pg.Pool({ ssl: { rejectUnauthorized: false } });',
      "generated/urls.mjs": "export const url = 'postgresql://db?sslmode=require';",
      "scratch.mjs": 'import pg from "pg";\nnew pg.Client("postgresql://db?sslmode=prefer");',
    })) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    const built = scanManagedPostgresClientPolicy({ repoRoot: root, head: "fixture" });

    expect(git(root, ["status", "--porcelain", "--ignored"])).toMatch(/dist\//u);
    expect(built).toEqual(clean);
    expect(built.derivation.source).toBe("git ls-files -z --cached --stage");
    expect(built.total).toBe(git(root, ["ls-files", "-z", "--cached"]).split("\0").filter(Boolean).length);
  });

  it("flags the superseded drill parser and require-mode pool shapes", () => {
    const { status, report } = runGuard(
      fixtureRepo({
        "tools/drill.mjs": [
          "export function injectorShell() {",
          "  return `node --input-type=module <<'NODE'",
          'import pg from "pg";',
          'import { readFileSync } from "node:fs";',
          "const url = new URL(process.env.DATABASE_URL);",
          'const ca = readFileSync(url.searchParams.get("sslrootcert"), "utf8");',
          "await new pg.Client({ connectionString: url.toString(), ssl: { ca } }).connect();",
          "NODE`;",
          "}",
        ].join("\n"),
        "lib/legacy-pool.ts": [
          'import pg from "pg";',
          "export const legacy = (url: string) =>",
          '  new pg.Pool({ connectionString: url, ssl: url.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined });',
        ].join("\n"),
      }),
    );

    expect(status).toBe(1);
    expect(member(report, "tools/drill.mjs")).toMatchObject({ class: "unsafe", reasons: ["copied-parser"] });
    expect(member(report, "lib/legacy-pool.ts").reasons).toContain("tls-downgrade rejectUnauthorized: false");
  });
});
