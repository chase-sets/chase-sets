import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { parseProductionCatalogCompletionManifest } from "../bounded-contexts/catalog/features/completion-report/domain/manifest.ts";
import {
  completionManifestFilename,
  completionManifestWindow,
  produceProductionCatalogCompletionManifest,
} from "../bounded-contexts/catalog/features/completion-report/read-model/freeze-manifest.ts";
import { runCatalogCompletionDatabaseVerifier } from "./catalog-production-completion-report.ts";
import { repoRoot } from "./lib/repo.mjs";

const providerBoundary = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Provider boundary must not be used");
  }),
);
vi.mock("../bounded-contexts/catalog/features/source-observations/api/provider-adapters/registry.ts", () => ({
  ProviderAdapterRegistry: providerBoundary,
}));

const clock = () => new Date("2026-11-21T09:00:00Z");
const updated = "2026-11-20T08:00:00.000Z";
const input = {
  batchId: "synthetic-batch",
  mainCommit: "a".repeat(40),
  launchCutoff: "2026-11-21T10:00:00Z",
  expiresAt: "2026-11-22T10:00:00Z",
};
const window = completionManifestWindow(input, clock);
const pair = (provider, form = "single-card") => `${provider}:pokemon:${form}`;
const browserUnit = pair("tcgplayer", "sealed-product");
const scopes = [
  { id: "scope-a", provider: "tcgdex", language: "en" },
  { id: "scope-b", provider: "scrydex", language: "ja" },
];

function profileRow(provider, unit = pair(provider), lifecycle = "active") {
  return {
    provider_key: provider,
    ingestion_unit_key: unit,
    profile_key: `${provider}-profile`,
    profile_version: "synthetic-v1",
    lifecycle,
    active: lifecycle === "active",
    profile_json: { status: "active", capabilities: ["source-observation-import"], supportedScopes: ["expansion"] },
  };
}

function mappingRow(scope, provider, unit = pair(provider)) {
  return {
    scope_record_id: scope.id,
    mapping_id: `${scope.id}-${provider}`,
    review_status: "accepted",
    provider_key: provider,
    unit_key: unit,
    set_id: "synthetic-coordinate",
    updated_at: updated,
  };
}

function snapshot({ reverse = false, drift = null } = {}) {
  const ordered = (rows) => (reverse ? [...rows].reverse() : rows);
  const query = vi.fn(async (sql) => {
    const rows = (result) => ({ rows: ordered(result) });
    if (sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" || sql === "ROLLBACK") return rows([]);
    expect(sql.trim()).toMatch(/^(SELECT|WITH)\b/);
    expect(sql).not.toMatch(/\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|TRUNCATE|ALTER TABLE)\b/i);
    expect(sql).not.toMatch(/session|cookie|credential/i);
    if (sql.includes("FROM catalog_scope_sync_batches")) {
      return rows([
        {
          batch_id: input.batchId,
          plan_fingerprint: "synthetic-plan-fingerprint",
          status: "queued",
          created_at: updated,
          selection: { mode: "ids", scopeRecordIds: scopes.map((scope) => scope.id) },
        },
      ]);
    }
    if (sql.includes("FROM catalog_scope_sync_batch_units")) {
      return rows(
        scopes.map((scope) => ({
          scope_record_id: scope.id,
          sync_run_id: null,
          plan: {
            scopeRecordVersion: updated,
            scope: { languageCode: scope.language },
            mappingVersions: [{ mappingId: `${scope.id}-${scope.provider}`, version: updated }],
            participationPreview: {
              units: [
                {
                  providerKey: scope.provider,
                  unitKey: pair(scope.provider),
                  profileKey: `${scope.provider}-profile`,
                  profileVersion: "synthetic-v1",
                  selected: true,
                  eligibility: "eligible",
                },
              ],
            },
          },
        })),
      );
    }
    if (sql.includes("FROM catalog_scope_records")) {
      return rows(
        scopes
          .filter((scope) => drift !== "scope" || scope.id !== "scope-b")
          .map((scope) => ({
            scope_record_id: scope.id,
            lifecycle_status: "active",
            scope_kind: "expansion",
            product_domain: "pokemon",
            language_editions: [scope.language],
            updated_at: updated,
          })),
      );
    }
    if (sql.includes("FROM catalog_provider_scope_mappings")) {
      expect(sql).toContain("review_status IN ('accepted', 'auto-accepted')");
      return rows([
        ...scopes.map((scope) => ({
          ...mappingRow(scope, scope.provider),
          ...(drift === "mapping" && { updated_at: input.launchCutoff }),
        })),
        mappingRow(scopes[0], "validation"),
        mappingRow(scopes[0], "tcgplayer", browserUnit),
      ]);
    }
    if (sql.includes("FROM catalog_provider_integration_profile_versions")) {
      return rows([
        profileRow("scrydex"),
        { ...profileRow("tcgdex"), ...(drift === "profile" && { profile_version: "synthetic-v2" }) },
        profileRow("validation", pair("validation"), "test"),
        profileRow("tcgplayer", browserUnit),
        profileRow("tcgplayer", pair("tcgplayer"), "retired"),
      ]);
    }
    if (sql.includes("FROM catalog_scope_sync_state")) {
      return rows([
        ...scopes.map((scope) => ({
          scope_record_id: scope.id,
          provider_key: scope.provider,
          unit_key: pair(scope.provider),
          state: "completed",
          last_sync_run_id: null,
          last_completed_at: input.launchCutoff,
          observed_count: 7,
          changed_count: 2,
          failed_count: 0,
        })),
        {
          scope_record_id: "scope-a",
          provider_key: "tcgplayer",
          unit_key: browserUnit,
          state: "completed",
          last_sync_run_id: null,
          last_completed_at: null,
          observed_count: 0,
          changed_count: 0,
          failed_count: 0,
        },
      ]);
    }
    return rows([]);
  });
  const release = vi.fn();
  return { query, release, connect: vi.fn(async () => ({ query, release })), end: vi.fn(async () => {}) };
}

afterEach(() => vi.unstubAllGlobals());

describe("production completion manifest", () => {
  it("freezes deterministic bytes in a read-only snapshot, with no provider boundary, and round-trips through the report", async () => {
    const network = vi.fn(() => {
      throw new Error("No provider network calls");
    });
    vi.stubGlobal("fetch", network);
    const pool = snapshot();
    const result = await produceProductionCatalogCompletionManifest(pool, window);
    const reordered = await produceProductionCatalogCompletionManifest(snapshot({ reverse: true }), window);
    expect(reordered.json).toBe(result.json);
    expect(reordered.sha256).toBe(result.sha256);
    expect(result.sha256).toBe(createHash("sha256").update(result.json, "utf8").digest("hex"));
    expect(result.manifest).toEqual(parseProductionCatalogCompletionManifest(JSON.parse(result.json)));
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(pool.query.mock.calls.at(-1)[0]).toBe("ROLLBACK");
    expect(pool.release).toHaveBeenCalledOnce();
    expect(result.manifest.batch).toEqual({
      batchId: input.batchId,
      planFingerprint: "synthetic-plan-fingerprint",
      status: "queued",
    });
    expect(result.manifest.frozenAt).toBe(clock().toISOString());
    expect(result.manifest.launchCutoff).toBe("2026-11-21T10:00:00.000Z");
    expect(result.manifest.freezeEvidence).toMatchObject({
      mainCommit: input.mainCommit,
      expiresAt: "2026-11-22T10:00:00.000Z",
      counts: {
        scopesByDomain: { pokemon: 2 },
        scopesByLanguage: { en: 1, ja: 1 },
        scopesByKind: { expansion: 2 },
        pairsByProvider: { scrydex: 1, tcgdex: 1 },
        pairsByUnit: { [pair("scrydex")]: 1, [pair("tcgdex")]: 1 },
      },
      mappingVersions: [
        { mappingId: "scope-a-tcgdex", version: updated },
        { mappingId: "scope-b-scrydex", version: updated },
      ],
      profileVersions: [
        {
          providerKey: "scrydex",
          unitKey: pair("scrydex"),
          profileKey: "scrydex-profile",
          profileVersion: "synthetic-v1",
        },
        {
          providerKey: "tcgdex",
          unitKey: pair("tcgdex"),
          profileKey: "tcgdex-profile",
          profileVersion: "synthetic-v1",
        },
      ],
    });
    expect(result.manifest.exclusions.map(({ unitKey, reason }) => [unitKey, reason])).toEqual([
      [browserUnit, "browser-extension-only"],
      [pair("tcgplayer"), "browser-extension-only"],
      [pair("validation"), "validation-only"],
    ]);
    expect(result.json.match(/tcgplayer/g)).toHaveLength(4);
    expect(result.json).not.toContain("synthetic-coordinate");

    const dir = mkdtempSync(join(tmpdir(), "catalog-completion-manifest-"));
    const manifestPath = join(dir, completionManifestFilename);
    try {
      writeFileSync(manifestPath, result.json);
      const { record } = await runCatalogCompletionDatabaseVerifier(
        {
          batchId: input.batchId,
          environment: "synthetic",
          checkedAt: clock().toISOString(),
          catalogDatabaseUrl: "postgresql://localhost/synthetic",
          manifestPath,
          acceptedManifestPath: null,
          launchCutoff: null,
          sample: null,
        },
        () => snapshot(),
      );
      expect(record.completionProof).toBe(true);
      expect(record.report.coverage.requiredProviderUnitCount).toBe(2);
      expect(record.report.batch.planFingerprint).toBe("synthetic-plan-fingerprint");
    } finally {
      unlinkSync(manifestPath);
      rmdirSync(dir);
    }
    expect(providerBoundary).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it.each(["scope", "mapping", "profile"])("fails closed and rolls back on %s drift", async (drift) => {
    const pool = snapshot({ drift });
    await expect(produceProductionCatalogCompletionManifest(pool, window)).rejects.toThrow();
    expect(pool.query.mock.calls.at(-1)[0]).toBe("ROLLBACK");
    expect(pool.release).toHaveBeenCalledOnce();
  });

  it("rejects an expiry at or before the cutoff or generation time", () => {
    expect(() => completionManifestWindow({ ...input, expiresAt: input.launchCutoff }, clock)).toThrow(
      "manifest-window-invalid",
    );
    expect(() => completionManifestWindow(input, () => new Date(input.expiresAt))).toThrow("manifest-window-invalid");
  });
});

it("uses the production-only workflow authority and refuses a CLI without the Catalog credential", () => {
  const workflow = parse(readFileSync(join(repoRoot, ".github/workflows/catalog-completion-manifest.yml"), "utf8"));
  const { manifest: job } = workflow.jobs;
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(job).toMatchObject({
    environment: "production",
    if: "${{ github.ref == 'refs/heads/main' }}",
    permissions: { contents: "read" },
  });
  expect(job.steps.find((step) => step.uses === "./.github/actions/export-managed-postgres-authority").with).toEqual({
    environment: "production",
    contexts: "catalog",
    "connection-mode": "direct",
  });
  expect(
    job.steps
      .find((step) => step.name === "Upload frozen manifest and SHA-256")
      .with.path.trim()
      .split("\n"),
  ).toEqual([
    "artifacts/catalog-completion-manifest/catalog-completion-manifest.json",
    "artifacts/catalog-completion-manifest/catalog-completion-manifest.json.sha256",
  ]);
  const args = [
    "--batch-id",
    input.batchId,
    "--main-commit",
    input.mainCommit,
    "--launch-cutoff",
    input.launchCutoff,
    "--expires-at",
    "2099-01-01T00:00:00Z",
    "--out-dir",
    "unused",
  ];
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/catalog-production-completion-manifest.ts", ...args],
    {
      cwd: repoRoot,
      env: { TSX_DISABLE_CACHE: "1" },
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toContain("catalog-database-url-missing");
});
