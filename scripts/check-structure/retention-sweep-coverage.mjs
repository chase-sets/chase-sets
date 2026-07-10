import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const terminalStatePattern = /'(?:sent|failed|expired|released|resolved|ignored|succeeded|cancelled|completed)'/;
const insertOnlyNamePattern =
  /(?:_events|_runs|_audit|_idempotency|_outbox|_snapshots|_claims|_tokens|_states|_cache)$/;
const timestampPattern =
  /\b(?:created_at|updated_at|received_at|completed_at|recorded_at|expires_at|stale_until|released_at)\b/;
const requiredKnownTables = new Map([
  ["notification_outbox", "infrastructure/notification-outbox/index.ts"],
  ["checkout_session_pages", "bounded-contexts/checkout/features/sessions/read-model/schema.ts"],
  ["payments_provider_idempotency_keys", "bounded-contexts/payments/features/payments/read-model/schema.ts"],
  ["settlement_provider_idempotency_keys", "bounded-contexts/settlement/features/payouts/read-model/schema.ts"],
]);

// These tables already have a purpose-built cleanup path or are durable
// records whose deletion needs a separate accounting/security decision.
export const retentionCoverageExemptions = new Map([
  ["event_store_events", "Canonical event ledgers are permanent and are never age-swept."],
  ["payments_work_claims", "Claim rows are mutable coordination state, not append-only history."],
  ["settlement_work_claims", "Claim rows are mutable coordination state, not append-only history."],
  ["platform_control_lease_fencing_tokens", "Monotonic fencing tokens must survive lease row cleanup."],
  ["platform_control_leases", "Lease acquisition already deletes expired lease rows."],
  ["platform_post_write_tokens", "The post-write token store prunes expired rows on store access."],
  ["platform_projection_checkpoint_readiness", "The scheduled work-signal cleanup runner owns this table."],
  ["platform_projection_checkpoint_waiters", "The scheduled work-signal cleanup runner owns this table."],
  ["platform_projection_wake_intents", "The scheduled work-signal cleanup runner owns this table."],
  ["platform_realtime_stream_leases", "The realtime stream limiter cleans expired leases on admission/release."],
  ["platform_ucp_agent_profiles", "Agent profile expiry is authorization state, not disposable request history."],
  ["platform_ucp_idempotency_records", "The UCP idempotency store has its own expiry pruning path."],
]);

export async function validateRetentionSweepCoverage({ repoRoot }) {
  const sourceFiles = await listSourceFiles(repoRoot);
  const policyFiles = sourceFiles.filter((file) => {
    const normalized = file.replaceAll("\\", "/");
    return normalized.endsWith("retention-policy.ts") || normalized.endsWith("platform-runtime/retention-sweep.ts");
  });
  const policySource = (await Promise.all(policyFiles.map((file) => readFile(file, "utf8")))).join("\n");
  const relativeSourceFiles = new Set(sourceFiles.map((file) => relative(repoRoot, file)));
  const candidates = new Map([...requiredKnownTables].filter(([, sourceFile]) => relativeSourceFiles.has(sourceFile)));

  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*?)\);/gs)) {
      const [, tableName, body] = match;
      const hasExpiry = /\bexpires_at\b/.test(body);
      const hasTerminalState = /\b(?:status|state)\s+text\b/.test(body) && terminalStatePattern.test(body);
      const looksInsertOnly = insertOnlyNamePattern.test(tableName) && timestampPattern.test(body);
      if (hasExpiry || hasTerminalState || looksInsertOnly) {
        candidates.set(tableName, relative(repoRoot, file));
      }
    }
  }

  const violations = [];
  for (const [tableName, file] of [...candidates].sort(([left], [right]) => left.localeCompare(right))) {
    if (retentionCoverageExemptions.has(tableName)) {
      continue;
    }
    if (!new RegExp(`(?:^|[^a-zA-Z0-9_])${escapeRegExp(tableName)}(?:$|[^a-zA-Z0-9_])`).test(policySource)) {
      violations.push(
        `${file}: retention candidate '${tableName}' has no shared retention-sweep registration or explicit exemption.`,
      );
    }
  }

  return { violations };
}

async function listSourceFiles(repoRoot) {
  const files = [];
  for (const rootName of ["bounded-contexts", "infrastructure"]) {
    await walk(path.join(repoRoot, rootName), files);
  }
  return files.filter((file) => /\.(?:ts|sql)$/.test(file));
}

async function walk(directory, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath, files);
    } else {
      files.push(entryPath);
    }
  }
}

function relative(repoRoot, file) {
  return path.relative(repoRoot, file).replaceAll("\\", "/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
