import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  managedPostgresWorkflowTrustViolations,
  scanManagedPostgresWorkflowInventory,
} from "./managed-postgres-workflow-inventory.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("managed Postgres workflow inventory", () => {
  it("scans every repository executable surface and keeps support output deterministic and source-free", async () => {
    const inventory = await scanManagedPostgresWorkflowInventory({ repositoryRoot });

    expect(inventory.scannedWorkflowCount).toBeGreaterThan(0);
    expect(inventory.scannedSurfaceCount).toBe(inventory.totalSurfaceCount);
    expect(inventory.totalSurfaceCount).toBeGreaterThan(inventory.scannedWorkflowCount);
    expect(inventory.coverage).toBe(`${inventory.scannedSurfaceCount}/${inventory.totalSurfaceCount}`);
    expect(inventory.coverage).not.toBe("12/12");
    expect(inventory.candidateCount).toBeGreaterThan(12);
    expect(inventory.candidateSurfaceCount).toBeGreaterThanOrEqual(inventory.candidateCount);
    expect(inventory.scannedCandidateSurfaceCount).toBe(inventory.totalCandidateSurfaceCount);
    expect(inventory.candidateCoverage).toBe(
      `${inventory.scannedCandidateSurfaceCount}/${inventory.totalCandidateSurfaceCount}`,
    );
    expect(inventory.candidates.flatMap(({ surfaces }) => surfaces).every(({ shapes }) => shapes.length > 0)).toBe(
      true,
    );
    expect(inventory.candidates.map(({ name }) => name)).toEqual(
      inventory.candidates.map(({ name }) => name).toSorted((left, right) => left.localeCompare(right)),
    );
    for (const candidate of inventory.candidates) {
      expect(candidate.surfaces.map(({ id }) => id)).toEqual(
        candidate.surfaces.map(({ id }) => id).toSorted((left, right) => left.localeCompare(right)),
      );
    }
    expect(new Set(inventory.candidates.map(({ scopeClassification }) => scopeClassification).filter(Boolean))).toEqual(
      new Set(["pod-internal-ca-distribution-follow-up", "runtime-secret-ca-distribution-follow-up"]),
    );
    expect(managedPostgresWorkflowTrustViolations(inventory)).toEqual([]);
    expect(JSON.stringify(inventory)).not.toContain('"source"');
  });

  it("discovers and rejects the historical inline exporter at an arbitrary realistic workflow path", async () => {
    const root = await createFixtureRepository({
      ".github/workflows/arbitrary-release-audit.yml": `name: Arbitrary Release Audit
on:
  workflow_dispatch:
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - name: Export audit database URL
        run: |
          node <<'NODE'
          const cluster = resources.find((resource) => resource.type === "digitalocean_database_cluster");
          const url = \`postgresql://operator:secret@\${cluster.host}:25060/audit?sslmode=require\`;
          fs.appendFileSync(process.env.GITHUB_ENV, \`DATABASE_URL_CHECKOUT=\${url}\\n\`);
          NODE
`,
    });

    const inventory = await scanManagedPostgresWorkflowInventory({ repositoryRoot: root });

    expect(inventory.candidateCount).toBe(1);
    expect(managedPostgresWorkflowTrustViolations(inventory)).toEqual([
      { workflow: "arbitrary-release-audit.yml", reason: "tls-downgrade:inline-workflow" },
    ]);
  });

  it("discovers and rejects a bare psql managed-Postgres consumer at an arbitrary workflow path", async () => {
    const root = await createFixtureRepository({
      ".github/workflows/unrelated-maintenance-window.yml": `name: Unrelated Maintenance Window
on:
  workflow_dispatch:
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - name: Export connection
        run: |
          host=$(terraform output -raw postgres_host)
          echo "AUDIT_URL=postgresql://operator:secret@\${host}:25060/audit?sslmode=require" >> "$GITHUB_ENV"
      - name: Run query
        run: psql "$AUDIT_URL" -c "select 1;"
`,
    });

    const inventory = await scanManagedPostgresWorkflowInventory({ repositoryRoot: root });
    const violations = managedPostgresWorkflowTrustViolations(inventory);

    expect({ candidateCount: inventory.candidateCount, violations }).toEqual({
      candidateCount: 1,
      violations: [
        {
          workflow: "unrelated-maintenance-window.yml",
          reason: "tls-downgrade:inline-workflow",
        },
      ],
    });
    expect(inventory.candidates[0].shapes).toEqual(["libpq:psql", "postgres-url-exporter"]);
  });

  it("discovers pg_dump and connection-bearing pg_restore commands", async () => {
    const root = await createFixtureRepository({
      ".github/workflows/archive-rotation.yml": `name: Archive Rotation
on:
  workflow_dispatch:
jobs:
  archive:
    runs-on: ubuntu-latest
    steps:
      - run: |
          URL="postgresql://operator:secret@managed.example:25060/archive?sslmode=require"
          pg_dump "$URL" > archive.sql
          pg_restore --dbname "$URL" archive.dump
`,
    });

    const inventory = await scanManagedPostgresWorkflowInventory({ repositoryRoot: root });

    expect(inventory.candidates[0].shapes).toEqual(["libpq:pg_dump", "libpq:pg_restore"]);
    expect(managedPostgresWorkflowTrustViolations(inventory)).toEqual([
      { workflow: "archive-rotation.yml", reason: "tls-downgrade:inline-workflow" },
    ]);
  });

  it("discovers a direct Node pg client in a referenced script outside top-level scripts", async () => {
    const root = await createFixtureRepository({
      ".github/workflows/customer-snapshot.yml": `name: Customer Snapshot
on:
  workflow_dispatch:
jobs:
  snapshot:
    runs-on: ubuntu-latest
    steps:
      - run: node ./automation/customer-data/snapshot.mjs
`,
      "automation/customer-data/snapshot.mjs": `import pg from "pg";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
`,
    });

    const inventory = await scanManagedPostgresWorkflowInventory({ repositoryRoot: root });

    expect(inventory.candidates[0].surfaces).toContainEqual({
      id: "automation/customer-data/snapshot.mjs",
      kind: "referenced-script",
      path: "automation/customer-data/snapshot.mjs",
      shapes: ["node-pg-client"],
      scopeClassification: null,
    });
    expect(managedPostgresWorkflowTrustViolations(inventory)).toEqual([
      {
        workflow: "customer-snapshot.yml",
        reason: "tls-downgrade:automation/customer-data/snapshot.mjs",
      },
    ]);
  });

  it("discovers a direct Node pg client reached through a package script", async () => {
    const root = await createFixtureRepository(
      {
        ".github/workflows/account-reconciliation.yml": `name: Account Reconciliation
on:
  workflow_dispatch:
jobs:
  reconcile:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm run account-reconciliation
`,
        "operations/accounts/reconcile.mjs": `import { Client } from "pg";
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
`,
      },
      { "account-reconciliation": "node ./operations/accounts/reconcile.mjs" },
    );

    const inventory = await scanManagedPostgresWorkflowInventory({ repositoryRoot: root });

    expect(inventory.candidates[0].shapes).toEqual(["node-pg-client"]);
    expect(managedPostgresWorkflowTrustViolations(inventory).map(({ reason }) => reason)).toEqual([
      "missing-trust:managed-postgres-ca-credential",
      "missing-trust:ca-input",
      "missing-trust:verify-full",
      "missing-trust:ca-cleanup",
    ]);
  });

  it("discovers a direct Node pg client embedded in an inline workflow script", async () => {
    const root = await createFixtureRepository({
      ".github/workflows/inline-status.yml": `name: Inline Status
on:
  workflow_dispatch:
jobs:
  status:
    runs-on: ubuntu-latest
    steps:
      - run: |
          node --input-type=module <<'NODE'
          import pg from "pg";
          const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
          await client.connect();
          NODE
`,
    });

    const inventory = await scanManagedPostgresWorkflowInventory({ repositoryRoot: root });

    expect(inventory.candidates[0].shapes).toEqual(["node-pg-client"]);
    expect(managedPostgresWorkflowTrustViolations(inventory)).toEqual([
      { workflow: "inline-status.yml", reason: "tls-downgrade:inline-workflow" },
    ]);
  });

  it("discovers a database consumer inside a local composite action", async () => {
    const root = await createFixtureRepository({
      ".github/workflows/operations-console.yml": `name: Operations Console
on:
  workflow_dispatch:
jobs:
  query:
    runs-on: ubuntu-latest
    steps:
      - uses: ./operations/database-query
`,
      "operations/database-query/action.yml": `name: Database query
runs:
  using: composite
  steps:
    - shell: bash
      run: psql "postgresql://operator:secret@managed.example:25060/audit?sslmode=require" -c "select 1"
`,
    });

    const inventory = await scanManagedPostgresWorkflowInventory({ repositoryRoot: root });

    expect(inventory.candidates.map(({ name }) => name)).toEqual(["operations-console.yml"]);
    expect(inventory.candidates[0].surfaces[0].kind).toBe("inline-run");
    expect(managedPostgresWorkflowTrustViolations(inventory)).toEqual([
      { workflow: "operations-console.yml", reason: "tls-downgrade:inline-workflow" },
    ]);
  });

  it("discovers a direct Node pg client behind a local Node action main path", async () => {
    const root = await createFixtureRepository({
      ".github/workflows/action-backed-query.yml": `name: Action-backed query
on:
  workflow_dispatch:
jobs:
  query:
    runs-on: ubuntu-latest
    steps:
      - uses: ./operations/node-query
`,
      "operations/node-query/action.yml": `name: Node query
runs:
  using: node24
  main: dist/index.js
`,
      "operations/node-query/dist/index.js": `import pg from "pg";
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
`,
    });

    const inventory = await scanManagedPostgresWorkflowInventory({ repositoryRoot: root });

    expect(inventory.candidates[0].surfaces).toContainEqual({
      id: "operations/node-query/dist/index.js",
      kind: "referenced-script",
      path: "operations/node-query/dist/index.js",
      shapes: ["node-pg-client"],
      scopeClassification: null,
    });
    expect(managedPostgresWorkflowTrustViolations(inventory)).toEqual([
      {
        workflow: "action-backed-query.yml",
        reason: "tls-downgrade:operations/node-query/dist/index.js",
      },
    ]);
  });

  it("discovers a database consumer inside a referenced reusable workflow", async () => {
    const root = await createFixtureRepository({
      ".github/workflows/entrypoint.yml": `name: Entrypoint
on:
  workflow_dispatch:
jobs:
  database:
    uses: ./.github/workflows/reusable-query.yml
`,
      ".github/workflows/reusable-query.yml": `name: Reusable query
on:
  workflow_call:
jobs:
  query:
    runs-on: ubuntu-latest
    steps:
      - run: psql "postgresql://operator:secret@managed.example:25060/audit?sslmode=require" -c "select 1"
`,
    });

    const inventory = await scanManagedPostgresWorkflowInventory({ repositoryRoot: root });
    const entrypoint = inventory.candidates.find(({ name }) => name === "entrypoint.yml");

    expect(entrypoint.surfaces.some(({ kind }) => kind === "inline-run")).toBe(true);
    expect(managedPostgresWorkflowTrustViolations(inventory)).toContainEqual({
      workflow: "entrypoint.yml",
      reason: "tls-downgrade:inline-workflow",
    });
  });

  it("accepts a code-shaped shared exporter with canonical CA, verify-full, and cleanup", async () => {
    const root = await createFixtureRepository({
      ".github/workflows/trusted-export.yml": `name: Trusted Export
on:
  workflow_dispatch:
jobs:
  export:
    runs-on: ubuntu-latest
    env:
      DIGITALOCEAN_ACCESS_TOKEN: \${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}
      MANAGED_POSTGRES_CA_PATH: \${{ runner.temp }}/managed-postgres.pem
    steps:
      - run: node ./automation/trust/database-urls.mjs
      - if: always()
        run: rm -f -- "$MANAGED_POSTGRES_CA_PATH"
`,
      "automation/trust/database-urls.mjs": `const url = new URL("postgresql://operator:secret@managed.example:25060/audit");
url.searchParams.set("sslmode", "verify-full");
url.searchParams.set("sslrootcert", process.env.MANAGED_POSTGRES_CA_PATH);
await fetch("https://api.digitalocean.com/v2/databases/cluster/ca", {
  headers: { authorization: \`Bearer \${process.env.DIGITALOCEAN_ACCESS_TOKEN}\` },
});
process.stdout.write(\`DATABASE_URL=\${url}\\n\`);
`,
    });

    const inventory = await scanManagedPostgresWorkflowInventory({ repositoryRoot: root });

    expect(inventory.candidates[0].shapes).toEqual(["postgres-url-exporter"]);
    expect(managedPostgresWorkflowTrustViolations(inventory)).toEqual([]);
  });

  it("keeps a canonically trusted bare psql command as a passing candidate", async () => {
    const root = await createFixtureRepository({
      ".github/workflows/trusted-psql.yml": `name: Trusted psql
on:
  workflow_dispatch:
jobs:
  query:
    runs-on: ubuntu-latest
    env:
      DIGITALOCEAN_ACCESS_TOKEN: \${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}
      MANAGED_POSTGRES_CA_PATH: \${{ runner.temp }}/managed-postgres.pem
    steps:
      - run: |
          curl -fsS -H "Authorization: Bearer $DIGITALOCEAN_ACCESS_TOKEN" \
            "https://api.digitalocean.com/v2/databases/cluster/ca" > "$MANAGED_POSTGRES_CA_PATH"
          echo "DATABASE_URL=postgresql://operator:secret@managed.example:25060/audit?sslmode=verify-full&sslrootcert=$MANAGED_POSTGRES_CA_PATH" >> "$GITHUB_ENV"
      - run: psql "$DATABASE_URL" -c "select 1"
      - if: always()
        run: rm -f -- "$MANAGED_POSTGRES_CA_PATH"
`,
    });

    const inventory = await scanManagedPostgresWorkflowInventory({ repositoryRoot: root });

    expect(inventory.candidates[0].shapes).toEqual(["libpq:psql", "postgres-url-exporter"]);
    expect(managedPostgresWorkflowTrustViolations(inventory)).toEqual([]);
  });

  it("does not create candidates from generic database words or non-Postgres commands", async () => {
    const root = await createFixtureRepository({
      ".github/workflows/ordinary-housekeeping.yml": `name: Postgres database housekeeping words
on:
  workflow_dispatch:
jobs:
  housekeeping:
    runs-on: ubuntu-latest
    steps:
      - run: echo "psql pg_dump pg_restore sslmode require database Postgres"
      - run: sqlite3 local.db "select 1"
      - run: mysql --version
      - run: pnpm exec pg-format --version
`,
    });

    const inventory = await scanManagedPostgresWorkflowInventory({ repositoryRoot: root });

    expect(inventory.candidateCount).toBe(0);
    expect(inventory.candidateSurfaceCount).toBe(0);
    expect(managedPostgresWorkflowTrustViolations(inventory)).toEqual([]);
  });
});

async function createFixtureRepository(files, scripts = {}) {
  const root = await mkdtemp(join(tmpdir(), "managed-postgres-workflow-inventory-"));
  temporaryDirectories.push(root);
  await writeFixture(
    root,
    "package.json",
    `${JSON.stringify({ name: "inventory-fixture", private: true, type: "module", scripts }, null, 2)}\n`,
  );
  for (const [path, contents] of Object.entries(files)) {
    await writeFixture(root, path, contents);
  }
  return root;
}

async function writeFixture(root, path, contents) {
  const absolutePath = join(root, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, contents);
}
