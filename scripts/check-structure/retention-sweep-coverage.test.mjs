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

  it("keeps every exemption justified", () => {
    expect([...retentionCoverageExemptions.values()].every((reason) => reason.trim().length >= 20)).toBe(true);
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
