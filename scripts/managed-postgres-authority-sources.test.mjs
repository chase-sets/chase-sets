import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateManagedPostgresAuthority,
  validateManagedPostgresAuthoritySources,
  writeManagedPostgresAuthorityManifest,
} from "./managed-postgres-authority-sources.mjs";

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture(fragment = {}) {
  const root = await mkdtemp(join(tmpdir(), "managed-postgres-authority-sources-"));
  roots.push(root);
  await mkdir(join(root, ".github/workflows"), { recursive: true });
  await mkdir(join(root, ".github/authority/platform-production"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(
    join(root, ".github/workflows/platform-production.yml"),
    "jobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps: []\n",
  );
  await writeFile(
    join(root, ".github/authority/platform-production/deploy.json"),
    `${JSON.stringify(
      {
        grants: [
          {
            file: ".github/workflows/platform-production.yml",
            jobId: "deploy",
            stepAnchor: "job",
            secretName: "A_SECRET",
            purpose: "application-runtime",
          },
          ...(fragment.grants ?? []),
        ],
        ...(fragment.dockerConsumers ? { dockerConsumers: fragment.dockerConsumers } : {}),
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

describe("managed Postgres authority source generator", () => {
  it("preserves reviewed record multiplicity and omits empty docker consumers", async () => {
    const root = await fixture({
      grants: [
        {
          file: ".github/workflows/platform-production.yml",
          jobId: "deploy",
          stepAnchor: "job",
          secretName: "A_SECRET",
          purpose: "application-runtime",
        },
      ],
    });
    const manifest = await generateManagedPostgresAuthority(root);
    expect(manifest.grants).toHaveLength(2);
    expect(manifest.dockerConsumers).toBeUndefined();
  });

  it("preserves populated docker consumer mappings", async () => {
    const root = await fixture({
      dockerConsumers: [
        {
          file: ".github/workflows/platform-production.yml",
          jobId: "deploy",
          stepAnchor: "step:1",
          pathMapping: "/tmp/ca:/etc/ssl/ca.pem",
        },
      ],
    });
    const manifest = await generateManagedPostgresAuthority(root);
    expect(manifest.dockerConsumers).toEqual([
      {
        file: ".github/workflows/platform-production.yml",
        jobId: "deploy",
        stepAnchor: "step:1",
        pathMapping: "/tmp/ca:/etc/ssl/ca.pem",
      },
    ]);
  });

  it("rejects mismatched owners and stale canonical output", async () => {
    const root = await fixture({
      grants: [
        {
          file: ".github/workflows/other.yml",
          jobId: "deploy",
          stepAnchor: "job",
          secretName: "A_SECRET",
          purpose: "application-runtime",
        },
      ],
    });
    const result = await validateManagedPostgresAuthoritySources(root, { checkManifest: false });
    expect(result.valid).toBe(false);
    await writeFile(
      join(root, "scripts/managed-postgres-authority-manifest.json"),
      '{"schemaVersion":1,"grants":[]}\n',
    );
    await expect(writeManagedPostgresAuthorityManifest(root, { check: true })).rejects.toThrow(
      /source validation failed/,
    );
    expect(await readFile(join(root, "scripts/managed-postgres-authority-manifest.json"), "utf8")).toContain("grants");
  });
});
