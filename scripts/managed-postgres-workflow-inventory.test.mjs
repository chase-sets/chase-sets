import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  it("covers every shared, inline, and direct-client workflow candidate by executable shape", async () => {
    const inventory = await scanManagedPostgresWorkflowInventory({ repositoryRoot });

    expect(inventory.candidates.map(({ name }) => name)).toEqual([
      "catalog-integration-staging-reset.yml",
      "catalog-provider-refresh-watch.yml",
      "checkout-order-readiness-trace.yml",
      "marketplace-provider-proof-status.yml",
      "platform-database-restore-drill.yml",
      "platform-postgres-growth-evidence.yml",
      "platform-postgres-slow-query-digest.yml",
      "platform-production.yml",
      "platform-staging-admin-qa-actor-fixtures.yml",
      "platform-staging-bootstrap-hook-drill.yml",
      "platform-staging-representative-commerce-state.yml",
      "platform-staging-wake-drills.yml",
    ]);
    expect(inventory.coverage).toBe("12/12");
    expect(managedPostgresWorkflowTrustViolations(inventory)).toEqual([]);
  });

  it("discovers and rejects the historical inline exporter at an arbitrary realistic workflow path", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "managed-postgres-workflow-inventory-"));
    temporaryDirectories.push(temporaryRoot);
    const workflowDirectory = join(temporaryRoot, ".github", "workflows");
    await cp(join(repositoryRoot, ".github", "workflows"), workflowDirectory, { recursive: true });
    await writeFile(
      join(workflowDirectory, "arbitrary-release-audit.yml"),
      `name: Arbitrary Release Audit
on:
  workflow_dispatch:
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - name: Export audit database URL
        run: |
          TERRAFORM_STATE_PATH="$RUNNER_TEMP/state.json" node <<'NODE'
          const cluster = resources.find((resource) => resource.type === "digitalocean_database_cluster");
          const databases = resources.find((resource) => resource.type === "digitalocean_database_db");
          const users = resources.find((resource) => resource.type === "digitalocean_database_user");
          const url = \`postgresql://\${users.name}:\${users.password}@\${cluster.host}/\${databases.name}?sslmode=require\`;
          fs.appendFileSync(process.env.GITHUB_ENV, \`DATABASE_URL_CHECKOUT=\${url}\\n\`);
          NODE
`,
    );

    const inventory = await scanManagedPostgresWorkflowInventory({
      repositoryRoot,
      workflowDirectory,
    });
    const violations = managedPostgresWorkflowTrustViolations(inventory);

    expect(inventory.candidateCount).toBe(13);
    expect(violations).toContainEqual({
      workflow: "arbitrary-release-audit.yml",
      reason: "inline-managed-postgres-exporter",
    });
    expect(violations.filter(({ workflow }) => workflow !== "arbitrary-release-audit.yml")).toEqual([]);
    expect(await readFile(join(workflowDirectory, "catalog-provider-refresh-watch.yml"), "utf8")).toContain(
      "scripts/terraform-state-database-urls.mjs",
    );
  });
});
