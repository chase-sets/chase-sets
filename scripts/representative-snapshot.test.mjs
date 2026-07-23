import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stableStringify } from "../bounded-contexts/catalog/features/source-observations/api/observation-pack.ts";
import {
  REPRESENTATIVE_SNAPSHOT_INDEX_VERSION,
  REPRESENTATIVE_SNAPSHOT_MANIFEST_VERSION,
  REPRESENTATIVE_SNAPSHOT_PUBLISH_STATES,
  REPRESENTATIVE_SNAPSHOT_RESTORE_STATES,
  buildRepresentativeSnapshotCompatibility,
  representativeSnapshotCompatibilityRefusal,
  restoreSnapshot,
  runRepresentativeSnapshotCli,
  validateRepresentativeSnapshotFiles,
  validateRepresentativeSnapshotManifest,
} from "./representative-snapshot.mjs";

const temporaryRoots = [];
const hash = (value) => createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function compatibility(overrides = {}) {
  return buildRepresentativeSnapshotCompatibility({
    acceptedPacks: [
      {
        packId: "pack-pokemon",
        packVersion: "2026-07-23.1",
        manifestKey: "observation-packs/pokemon/manifest.json",
        captureContentHash: hash("capture"),
      },
    ],
    providerProfiles: [
      {
        providerKey: "tcgdex",
        profileKey: "pokemon-cards",
        profileVersion: "profile-v3",
        ingestionUnit: "cards-by-set",
      },
    ],
    replayContractVersion: "source-observation-replay-v1",
    migrationsHash: hash("migrations"),
    ...overrides,
  });
}

function manifest(currentCompatibility, databaseBytes, assetBytes) {
  const candidate = {
    schemaVersion: REPRESENTATIVE_SNAPSHOT_MANIFEST_VERSION,
    snapshotId: "0".repeat(64),
    publishedAt: "2026-07-23T12:00:00.000Z",
    lifecycle: {
      state: "published",
      publishStates: REPRESENTATIVE_SNAPSHOT_PUBLISH_STATES,
      restoreStates: REPRESENTATIVE_SNAPSHOT_RESTORE_STATES,
    },
    compatibility: currentCompatibility,
    databases: [
      {
        key: "control",
        objectKey: "databases/control.dump",
        byteCount: databaseBytes.length,
        sha256: hash(databaseBytes),
      },
      {
        key: "catalog",
        objectKey: "databases/catalog.dump",
        byteCount: databaseBytes.length,
        sha256: hash(databaseBytes),
      },
    ],
    assets: {
      objectKey: "assets/catalog-assets.tar.gz",
      byteCount: assetBytes.length,
      sha256: hash(assetBytes),
      fileCount: 1,
    },
    verifier: {
      digest: "0".repeat(64),
      packs: [
        {
          packId: "pack-pokemon",
          packVersion: "2026-07-23.1",
          verifierDigest: hash("pack-verifier"),
          externalReferenceDigest: hash("external-references"),
          counts: {
            envelopes: 1,
            observations: 1,
            catalogItems: 1,
            productAssetSets: 1,
            storedAssetUrls: 7,
            discoverySearchItems: 1,
            discoveryItemDetails: 1,
          },
        },
      ],
      perTableRowCounts: [
        { table: "catalog.public.catalog_items", rowCount: "1" },
        { table: "discovery.public.discovery_search_catalog_items", rowCount: "1" },
      ],
    },
  };
  candidate.verifier.digest = hash(
    stableStringify({
      packs: candidate.verifier.packs,
      perTableRowCounts: candidate.verifier.perTableRowCounts,
    }),
  );
  candidate.snapshotId = hash(
    stableStringify({
      publishedAt: candidate.publishedAt,
      compatibilityKey: candidate.compatibility.key,
      verifierDigest: candidate.verifier.digest,
      databases: candidate.databases.map(({ key, sha256 }) => ({ key, sha256 })),
      assets: candidate.assets.sha256,
    }),
  );
  return candidate;
}

describe("representative snapshot compatibility", () => {
  it("binds ordered pack versions, provider profiles, replay contract, and the all-database migration ledger", () => {
    const current = compatibility();

    expect(current.key).toMatch(/^[a-f0-9]{64}$/);
    expect(current.acceptedPacks).toEqual([
      expect.objectContaining({ packId: "pack-pokemon", packVersion: "2026-07-23.1" }),
    ]);
    expect(current.providerProfiles).toEqual([
      expect.objectContaining({ providerKey: "tcgdex", profileVersion: "profile-v3" }),
    ]);
  });

  it.each([
    [
      "pack version",
      compatibility({
        acceptedPacks: [
          {
            packId: "pack-pokemon",
            packVersion: "2026-07-23.2",
            manifestKey: "observation-packs/pokemon-v2/manifest.json",
            captureContentHash: hash("capture-v2"),
          },
        ],
      }),
      "representative-snapshot-pack-version-mismatch",
    ],
    [
      "provider profile",
      compatibility({
        providerProfiles: [
          {
            providerKey: "tcgdex",
            profileKey: "pokemon-cards",
            profileVersion: "profile-v4",
            ingestionUnit: "cards-by-set",
          },
        ],
      }),
      "representative-snapshot-profile-version-mismatch",
    ],
    [
      "replay contract",
      compatibility({ replayContractVersion: "source-observation-replay-v2" }),
      "representative-snapshot-replay-contract-version-mismatch",
    ],
    [
      "migration ledger",
      compatibility({ migrationsHash: hash("new-migrations") }),
      "representative-snapshot-migrations-hash-mismatch",
    ],
  ])("names a %s incompatibility instead of silently restoring stale state", (_label, actual, expectedCode) => {
    expect(representativeSnapshotCompatibilityRefusal(compatibility(), actual)).toBe(expectedCode);
  });
});

describe("representative snapshot all-or-nothing validation", () => {
  it("validates every dump and the asset bundle before a restore callback can run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "representative-snapshot-"));
    temporaryRoots.push(root);
    const databaseBytes = Buffer.from("valid-database-dump");
    const assetBytes = Buffer.from("valid-asset-bundle");
    const files = new Map();
    for (const key of ["databases/control.dump", "databases/catalog.dump"]) {
      const file = path.join(root, key.replaceAll("/", "-"));
      await writeFile(file, databaseBytes);
      files.set(key, file);
    }
    const assetFile = path.join(root, "assets.tar.gz");
    await writeFile(assetFile, assetBytes);
    files.set("assets/catalog-assets.tar.gz", assetFile);
    const restoreDatabase = vi.fn();

    const validated = await validateRepresentativeSnapshotFiles({
      manifest: manifest(compatibility(), databaseBytes, assetBytes),
      readFileForObject: async (key) => files.get(key),
      expectedCompatibility: compatibility(),
      expectedDatabaseKeys: ["control", "catalog"],
      validateAssetBundle: vi.fn(async () => undefined),
    });
    for (const database of validated.manifest.databases) {
      restoreDatabase(database.key);
    }

    expect(restoreDatabase.mock.calls).toEqual([["control"], ["catalog"]]);
  });

  it("downloads a cold cache once and reuses the fully validated warm cache", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "representative-snapshot-cache-"));
    temporaryRoots.push(cacheDir);
    const databaseBytes = Buffer.from("valid-database-dump");
    const assetBytes = Buffer.from("valid-asset-bundle");
    const currentCompatibility = compatibility();
    const snapshotManifest = manifest(currentCompatibility, databaseBytes, assetBytes);
    const manifestKey = `representative-snapshots/sets/${snapshotManifest.snapshotId}/manifest.json`;
    const index = {
      schemaVersion: REPRESENTATIVE_SNAPSHOT_INDEX_VERSION,
      updatedAt: "2026-07-23T12:00:00.000Z",
      entries: [
        {
          snapshotId: snapshotManifest.snapshotId,
          manifestKey,
          publishedAt: snapshotManifest.publishedAt,
          state: "published",
          compatibility: currentCompatibility,
        },
      ],
    };
    const getFile = vi.fn(async (key, target) => {
      await mkdir(path.dirname(target), { recursive: true });
      const body = key.endsWith("/manifest.json")
        ? Buffer.from(JSON.stringify(snapshotManifest))
        : key.endsWith(".dump")
          ? databaseBytes
          : assetBytes;
      await writeFile(target, body);
      return { byteCount: body.length, contentType: "application/octet-stream" };
    });
    const storage = {
      getObject: vi.fn(async (key) =>
        key === "representative-snapshots/index.json"
          ? { body: Buffer.from(JSON.stringify(index)), contentType: "application/json" }
          : null,
      ),
      getFile,
    };
    const packSet = [
      {
        sourceManifestKey: currentCompatibility.acceptedPacks[0].manifestKey,
        packRoot: path.join(cacheDir, "packs"),
        manifest: {
          packId: currentCompatibility.acceptedPacks[0].packId,
          packVersion: currentCompatibility.acceptedPacks[0].packVersion,
          captureContentHash: currentCompatibility.acceptedPacks[0].captureContentHash,
          identity: {
            provider: {
              key: currentCompatibility.providerProfiles[0].providerKey,
              integrationProfileKey: currentCompatibility.providerProfiles[0].profileKey,
              integrationProfileVersion: currentCompatibility.providerProfiles[0].profileVersion,
              ingestionUnit: currentCompatibility.providerProfiles[0].ingestionUnit,
            },
          },
        },
      },
    ];
    const restoreDatabase = vi.fn(async () => undefined);
    const restoreAssetBundle = vi.fn(async () => undefined);
    const dependencies = {
      storage,
      ensureSandbox: () => ({
        sandbox: {
          controlDatabaseUrl: "postgresql://local/control",
          contextDatabaseUrls: { catalog: "postgresql://local/catalog" },
        },
      }),
      loadAcceptedPackSet: async () => packSet,
      readMigrationsLedger: async () => ({ hash: currentCompatibility.migrationsHash, ledgers: [] }),
      validateAssetBundle: async () => undefined,
      restoreDatabase,
      restoreAssetBundle,
      runBootstrap: async () => undefined,
      computeVerifierEvidence: async () => snapshotManifest.verifier,
    };
    const options = {
      cacheDir,
      assetRoot: path.resolve("artifacts/representative-snapshot-test-assets"),
    };

    await expect(restoreSnapshot(options, {}, dependencies)).resolves.toMatchObject({
      status: "restored",
      cache: "cold",
    });
    const coldFetches = getFile.mock.calls.length;
    await expect(restoreSnapshot(options, {}, dependencies)).resolves.toMatchObject({
      status: "restored",
      cache: "warm",
    });

    expect(coldFetches).toBe(4);
    expect(getFile).toHaveBeenCalledTimes(coldFetches);
    expect(restoreDatabase).toHaveBeenCalledTimes(4);
    expect(restoreAssetBundle).toHaveBeenCalledTimes(2);
  });

  it("refuses a corrupted dump digest before any database restore is attempted", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "representative-snapshot-corrupt-"));
    temporaryRoots.push(root);
    const databaseBytes = Buffer.from("valid-database-dump");
    const assetBytes = Buffer.from("valid-asset-bundle");
    const corrupt = path.join(root, "corrupt.dump");
    const valid = path.join(root, "valid.dump");
    const assets = path.join(root, "assets.tar.gz");
    await writeFile(corrupt, "tampered");
    await writeFile(valid, databaseBytes);
    await writeFile(assets, assetBytes);
    const restoreDatabase = vi.fn();

    await expect(
      validateRepresentativeSnapshotFiles({
        manifest: manifest(compatibility(), databaseBytes, assetBytes),
        readFileForObject: async (key) =>
          key === "databases/control.dump" ? corrupt : key === "databases/catalog.dump" ? valid : assets,
        expectedCompatibility: compatibility(),
        expectedDatabaseKeys: ["control", "catalog"],
      }),
    ).rejects.toMatchObject({ code: "representative-snapshot-dump-digest-mismatch" });
    expect(restoreDatabase).not.toHaveBeenCalled();
  });

  it("rejects a partial or reordered database inventory", () => {
    const databaseBytes = Buffer.from("database");
    const assetBytes = Buffer.from("assets");

    expect(() =>
      validateRepresentativeSnapshotManifest(manifest(compatibility(), databaseBytes, assetBytes), [
        "control",
        "catalog",
        "discovery",
      ]),
    ).toThrow(/representative-snapshot-database-inventory-mismatch/);
  });

  it("closes nested manifest objects against silent contract drift", () => {
    const databaseBytes = Buffer.from("database");
    const assetBytes = Buffer.from("assets");
    const candidate = manifest(compatibility(), databaseBytes, assetBytes);
    candidate.assets.unreviewed = true;

    expect(() => validateRepresentativeSnapshotManifest(candidate, ["control", "catalog"])).toThrow(
      /representative-snapshot-manifest-schema-invalid/,
    );
  });

  it("refuses internally inconsistent compatibility and verifier digests", () => {
    const databaseBytes = Buffer.from("database");
    const assetBytes = Buffer.from("assets");
    const incompatible = manifest(compatibility(), databaseBytes, assetBytes);
    incompatible.compatibility.key = hash("forged-compatibility");
    expect(() => validateRepresentativeSnapshotManifest(incompatible, ["control", "catalog"])).toThrow(
      /representative-snapshot-compatibility-key-mismatch/,
    );

    const unverifiable = manifest(compatibility(), databaseBytes, assetBytes);
    unverifiable.verifier.packs[0].counts.catalogItems += 1;
    expect(() => validateRepresentativeSnapshotManifest(unverifiable, ["control", "catalog"])).toThrow(
      /representative-snapshot-verifier-digest-mismatch/,
    );
  });
});

describe("representative snapshot credential refusal", () => {
  it("withholds both scoped Space credentials and fails before any provider or restore call", async () => {
    let output = "";
    const exitCode = await runRepresentativeSnapshotCli(
      ["restore", "--pack-manifest-keys", "observation-packs/pokemon/manifest.json"],
      {},
      { write: (value) => (output += value) },
    );

    expect(exitCode).toBe(1);
    expect(output).toContain(
      "representative-snapshot-space-credentials-missing:SEED_PACKS_SPACES_ACCESS_ID,SEED_PACKS_SPACES_SECRET_KEY",
    );
    expect(output).not.toContain("observation-packs/pokemon");
  });
});

describe("representative snapshot index contract", () => {
  it("keeps the index version distinct from the immutable set manifest version", () => {
    expect(REPRESENTATIVE_SNAPSHOT_INDEX_VERSION).toBe("representative-snapshot-index/v1");
    expect(REPRESENTATIVE_SNAPSHOT_MANIFEST_VERSION).toBe("representative-snapshot-set/v1");
  });
});
