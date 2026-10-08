import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { retentionCoverageExemptions, validateRetentionSweepCoverage } from "./retention-sweep-coverage.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("retention sweep coverage", () => {
  it("flags a new expires_at table without a policy", async () => {
    const root = await fixture({
      "bounded-contexts/example/schema.ts": `export const schema = \`CREATE TABLE IF NOT EXISTS example_tokens (
        token_id text PRIMARY KEY,
        expires_at timestamptz NOT NULL
      );\`;`,
    });

    await expect(validateRetentionSweepCoverage({ repoRoot: root })).resolves.toMatchObject({
      violations: [expect.stringContaining("example_tokens")],
    });
  });

  it("accepts a registered terminal table", async () => {
    const root = await fixture({
      "bounded-contexts/example/schema.ts": `export const schema = \`CREATE TABLE IF NOT EXISTS example_jobs (
        job_id text PRIMARY KEY,
        status text NOT NULL CHECK (status IN ('running', 'completed')),
        updated_at timestamptz NOT NULL
      );\`;`,
      "bounded-contexts/example/retention-policy.ts": `export const policy = [{ tableName: "example_jobs" }];`,
    });

    await expect(validateRetentionSweepCoverage({ repoRoot: root })).resolves.toEqual({ violations: [] });
  });

  it("ignores historical SQL fixtures while retaining the production-source check", async () => {
    const root = await fixture({
      "bounded-contexts/example/tests/fixtures/deployed-schema.sql": `CREATE TABLE IF NOT EXISTS historical_job_events (
        event_id text PRIMARY KEY,
        created_at timestamptz NOT NULL
      );`,
      "bounded-contexts/example/schema.ts": `export const schema = \`CREATE TABLE IF NOT EXISTS current_job_events (
        event_id text PRIMARY KEY,
        created_at timestamptz NOT NULL
      );\`;`,
    });

    await expect(validateRetentionSweepCoverage({ repoRoot: root })).resolves.toEqual({
      violations: [expect.stringContaining("current_job_events")],
    });
  });

  it("keeps every exemption justified", () => {
    expect([...retentionCoverageExemptions.values()].every((reason) => reason.trim().length >= 20)).toBe(true);
  });

  it("retains provider-write reconciliation evidence without exempting unrelated journals", async () => {
    const root = await fixture({
      "infrastructure/platform-runtime/schema.ts": `export const schema = \`CREATE TABLE IF NOT EXISTS evidence_window_provider_write (
        state text NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed', 'ambiguous')),
        created_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS unrelated_provider_write (
        state text NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed', 'ambiguous')),
        created_at timestamptz NOT NULL
      );\`;`,
    });
    await expect(validateRetentionSweepCoverage({ repoRoot: root })).resolves.toEqual({
      violations: [
        "infrastructure/platform-runtime/schema.ts: retention candidate 'unrelated_provider_write' has no shared retention-sweep registration or explicit exemption.",
      ],
    });
    expect(retentionCoverageExemptions.get("evidence_window_provider_write")).toContain("reconciliation");
  });

  it("accepts indefinitely valid pricing dry runs but still rejects an unknown terminal table", async () => {
    const root = await fixture({
      "bounded-contexts/pricing/schema.ts": `export const schema = \`CREATE TABLE IF NOT EXISTS pricing_repricing_dry_runs (
        dry_run_id text PRIMARY KEY,
        body_hash text NOT NULL,
        status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
        completed_at timestamptz NULL,
        consumed_at timestamptz NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pricing_unregistered_dry_runs (
        dry_run_id text PRIMARY KEY,
        status text NOT NULL CHECK (status IN ('running', 'completed')),
        completed_at timestamptz NULL
      );\`;`,
    });

    await expect(validateRetentionSweepCoverage({ repoRoot: root })).resolves.toEqual({
      violations: [
        "bounded-contexts/pricing/schema.ts: retention candidate 'pricing_unregistered_dry_runs' has no shared retention-sweep registration or explicit exemption.",
      ],
    });
    expect(retentionCoverageExemptions.get("pricing_repricing_dry_runs")).toContain(
      "valid indefinitely by exact body hash with no clock or expiry",
    );
    expect(retentionCoverageExemptions.get("pricing_repricing_dry_runs")).toContain(
      "durable consumed_at evidence must survive for once-only consumption",
    );
  });
});

describe("connector inbound payload retention coverage", () => {
  const schemaFile = "bounded-contexts/channels/features/connector-feed/read-model/inbound-schema.ts";
  const policyFile = "bounded-contexts/channels/features/connector-feed/read-model/retention-policy.ts";
  const moduleFile = "bounded-contexts/channels/index.ts";
  const policy = `export const connectorInboundRetentionSweeps = [{ tableName: "channel_connector_inbound_payloads" }];
export const connectorInboundRetentionExemptions = [{ tableName: "channel_connector_inbound_events" }];`;
  const mountedModule = `import {
  connectorInboundRetentionExemptions,
  connectorInboundRetentionSweeps,
} from "./features/connector-feed/read-model/retention-policy";
export const module = defineBoundedContextModule({
  retentionSweeps: connectorInboundRetentionSweeps,
  retentionExemptions: connectorInboundRetentionExemptions,
});`;
  const payloadViolation = `${schemaFile}: retention candidate 'channel_connector_inbound_payloads' requires a sweep mounted by ${moduleFile} module.retentionSweeps; a lexical mention, unmounted declaration or exemption does not count.`;
  const connector = (entries = {}) =>
    fixture({
      [schemaFile]: "export const schema = [];",
      [policyFile]: policy,
      [moduleFile]: mountedModule,
      ...entries,
    });

  it("accepts the payload table only through a sweep the Channels module mounts", async () => {
    await expect(validateRetentionSweepCoverage({ repoRoot: await connector() })).resolves.toEqual({ violations: [] });
  });

  it("flags the planted payload table when no policy declares or mounts it", async () => {
    const root = await connector({
      [policyFile]: "export const nothing = [];",
      [moduleFile]: "export const module = {};",
    });
    await expect(validateRetentionSweepCoverage({ repoRoot: root })).resolves.toEqual({
      violations: [payloadViolation],
    });
  });

  it("does not accept a lexical mention in another retention policy", async () => {
    const root = await connector({
      [moduleFile]: "export const module = {};",
      "bounded-contexts/other/retention-policy.ts": `// channel_connector_inbound_payloads
export const otherSweeps = [{ tableName: "channel_connector_inbound_payloads" }];`,
    });
    await expect(validateRetentionSweepCoverage({ repoRoot: root })).resolves.toEqual({
      violations: [payloadViolation],
    });
  });

  it("flags a stale declaration that the module no longer mounts", async () => {
    const root = await connector({
      [moduleFile]: mountedModule.replace("  retentionSweeps: connectorInboundRetentionSweeps,\n", ""),
    });
    await expect(validateRetentionSweepCoverage({ repoRoot: root })).resolves.toEqual({
      violations: [payloadViolation],
    });
  });

  it("flags a mount that resolves to a sweep set without the payload table", async () => {
    const root = await connector({
      [moduleFile]: mountedModule.replace(
        "retentionSweeps: connectorInboundRetentionSweeps,",
        "retentionSweeps: connectorInboundRetentionExemptions,",
      ),
      [policyFile]: policy.replace(
        'export const connectorInboundRetentionSweeps = [{ tableName: "channel_connector_inbound_payloads" }];',
        "export const connectorInboundRetentionSweeps = [];",
      ),
    });
    await expect(validateRetentionSweepCoverage({ repoRoot: root })).resolves.toEqual({
      violations: [payloadViolation],
    });
  });

  it("never lets an exemption stand in for the mounted payload sweep", async () => {
    const root = await connector();
    retentionCoverageExemptions.set(
      "channel_connector_inbound_payloads",
      "Synthetic exemption control for the payload.",
    );
    try {
      await expect(validateRetentionSweepCoverage({ repoRoot: root })).resolves.toEqual({
        violations: [payloadViolation],
      });
    } finally {
      retentionCoverageExemptions.delete("channel_connector_inbound_payloads");
    }
  });

  it("keeps the identity table a required candidate retained only by its #7795 dedupe exemption", async () => {
    const root = await connector({ [policyFile]: policy.split("\n")[0] });
    const reason = retentionCoverageExemptions.get("channel_connector_inbound_events");
    expect(reason).toContain("#7795");
    expect(retentionCoverageExemptions.has("channel_connector_inbound_payloads")).toBe(false);
    retentionCoverageExemptions.delete("channel_connector_inbound_events");
    try {
      await expect(validateRetentionSweepCoverage({ repoRoot: root })).resolves.toEqual({
        violations: [
          `${schemaFile}: retention candidate 'channel_connector_inbound_events' has no shared retention-sweep registration or explicit exemption.`,
        ],
      });
    } finally {
      retentionCoverageExemptions.set("channel_connector_inbound_events", reason);
    }
  });
});

async function fixture(entries) {
  const root = await mkdtemp(path.join(os.tmpdir(), "retention-coverage-"));
  roots.push(root);
  await mkdir(path.join(root, "bounded-contexts"), { recursive: true });
  await mkdir(path.join(root, "infrastructure"), { recursive: true });
  for (const [relativePath, contents] of Object.entries(entries)) {
    const file = path.join(root, relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents, "utf8");
  }
  return root;
}
