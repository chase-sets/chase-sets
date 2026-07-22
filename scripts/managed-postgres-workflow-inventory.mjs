import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOW_EXTENSION = ".yml";
const LOCAL_SCRIPT_REFERENCE = /scripts\/[a-zA-Z0-9._/-]+\.mjs/g;
const PG_CLIENT_SHAPE =
  /(?:from\s+["']pg["']|import\s+pg\s+from\s+["']pg["']|new\s+(?:pg\.)?(?:Client|Pool)\s*\(|createPgPool\s*\(|postgresClientConfig\s*\()/s;

export const CLASSIFIED_OUTSIDE_SCHEDULED_WORKFLOW_FENCE = Object.freeze({
  "platform-staging-bootstrap-hook-drill.yml": "pod-internal-ca-distribution-follow-up",
});

export async function scanManagedPostgresWorkflowInventory(options = {}) {
  const repositoryRoot = resolve(options.repositoryRoot ?? fileURLToPath(new URL("..", import.meta.url)));
  const workflowDirectory = resolve(
    options.workflowDirectory ?? repositoryRoot,
    options.workflowDirectory ? "" : ".github/workflows",
  );
  const workflowNames = (await readdir(workflowDirectory)).filter((name) => name.endsWith(WORKFLOW_EXTENSION)).sort();
  const candidates = [];

  for (const name of workflowNames) {
    const source = await readFile(resolve(workflowDirectory, name), "utf8");
    const scriptReferences = [...new Set(source.match(LOCAL_SCRIPT_REFERENCE) ?? [])];
    const directClientScripts = [];
    for (const scriptReference of scriptReferences) {
      try {
        const scriptSource = await readFile(resolve(repositoryRoot, scriptReference), "utf8");
        if (PG_CLIENT_SHAPE.test(scriptSource)) {
          directClientScripts.push({ path: scriptReference, source: scriptSource });
        }
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }

    const shapes = [];
    if (source.includes("scripts/terraform-state-database-urls.mjs")) {
      shapes.push("shared-trust-exporter");
    }
    if (isInlineTerraformManagedPostgresExporter(source)) {
      shapes.push("inline-terraform-state-exporter");
    }
    if (directClientScripts.length > 0) {
      shapes.push("direct-pg-client-script");
    }
    if (shapes.length === 0) {
      continue;
    }

    candidates.push({
      name,
      scheduled: /\n\s*schedule\s*:/.test(source),
      shapes,
      source,
      directClientScripts,
      scopeClassification: CLASSIFIED_OUTSIDE_SCHEDULED_WORKFLOW_FENCE[name] ?? null,
    });
  }

  return {
    scannedWorkflowCount: workflowNames.length,
    candidateCount: candidates.length,
    coverage: `${candidates.length}/${candidates.length}`,
    candidates,
  };
}

export function managedPostgresWorkflowTrustViolations(inventory) {
  const violations = [];
  for (const candidate of inventory.candidates) {
    if (candidate.shapes.includes("inline-terraform-state-exporter")) {
      violations.push({ workflow: candidate.name, reason: "inline-managed-postgres-exporter" });
    }

    if (candidate.shapes.includes("shared-trust-exporter")) {
      requireSource(candidate, "DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}", violations);
      requireSource(
        candidate,
        "MANAGED_POSTGRES_CA_PATH: ${{ runner.temp }}/digitalocean-managed-postgres-ca.pem",
        violations,
      );
      requireSource(candidate, '--ca-path "$MANAGED_POSTGRES_CA_PATH"', violations);
      requireSource(candidate, "Remove managed Postgres CA", violations);
    }

    const directOnly =
      candidate.shapes.includes("direct-pg-client-script") && !candidate.shapes.includes("shared-trust-exporter");
    if (directOnly && candidate.scheduled) {
      requireSource(candidate, "DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}", violations);
      requireSource(
        candidate,
        "MANAGED_POSTGRES_CA_PATH: ${{ runner.temp }}/digitalocean-managed-postgres-ca.pem",
        violations,
      );
      requireSource(candidate, "Remove managed Postgres CA", violations);
    } else if (directOnly && !candidate.scopeClassification) {
      violations.push({ workflow: candidate.name, reason: "unclassified-direct-managed-postgres-client" });
    }

    if (!candidate.scopeClassification) {
      for (const script of candidate.directClientScripts) {
        if (/rejectUnauthorized\s*:\s*false|sslmode=require/.test(script.source)) {
          violations.push({ workflow: candidate.name, reason: `tls-downgrade:${script.path}` });
        }
      }
    }
    if (/NODE_TLS_REJECT_UNAUTHORIZED/.test(candidate.source)) {
      violations.push({ workflow: candidate.name, reason: "global-tls-verification-disabled" });
    }
  }
  return violations;
}

export function isInlineTerraformManagedPostgresExporter(source) {
  return (
    /digitalocean_database_cluster/.test(source) &&
    /digitalocean_database_(?:db|user)/.test(source) &&
    /(?:postgresql:\/\/|sslmode\s*=|sslmode=)/.test(source) &&
    /GITHUB_ENV/.test(source)
  );
}

function requireSource(candidate, required, violations) {
  if (!candidate.source.includes(required)) {
    violations.push({ workflow: candidate.name, reason: `missing-trust-input:${required}` });
  }
}
