import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { stableStringify } from "../bounded-contexts/catalog/features/source-observations/api/observation-pack.ts";
import {
  REPRESENTATIVE_SNAPSHOT_INDEX_VERSION,
  REPRESENTATIVE_SNAPSHOT_MANIFEST_VERSION,
  REPRESENTATIVE_SNAPSHOT_PUBLISH_STATES,
  REPRESENTATIVE_SNAPSHOT_RESTORE_STATES,
  RepresentativeSnapshotError,
  buildRepresentativeAcceptedPackSetIdentity,
  buildRepresentativeSnapshotCompatibility,
  representativeSnapshotCompatibilityRefusal,
  resetRepresentativeSnapshotSandbox,
  restoreSnapshot,
  runRepresentativeSnapshotCli,
  validateRepresentativeAssetInventory,
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

it("reuses one ordered immutable accepted-pack identity across snapshot and commerce closure", () => {
  const packs = [
    ...compatibility().acceptedPacks,
    {
      packId: "pack-lorcana",
      packVersion: "2026-07-23.1",
      manifestKey: "observation-packs/lorcana/manifest.json",
      captureContentHash: hash("lorcana-capture"),
    },
  ];
  expect(buildRepresentativeAcceptedPackSetIdentity(packs)).toBe(hash(stableStringify(packs)));
  expect(buildRepresentativeAcceptedPackSetIdentity([...packs].reverse())).not.toBe(
    buildRepresentativeAcceptedPackSetIdentity(packs),
  );
});

function manifest(currentCompatibility, databaseBytes, assetBytes) {
  const assetEntries = [
    {
      path: "catalog/items/cat_test/product-image/high.webp",
      byteCount: assetBytes.length,
      sha256: hash(assetBytes),
    },
  ];
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
      entries: assetEntries,
    },
    verifier: {
      digest: "0".repeat(64),
      packs: [
        {
          packId: "pack-pokemon",
          packVersion: "2026-07-23.1",
          manifestKey: "observation-packs/pokemon/manifest.json",
          captureContentHash: hash("capture"),
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
      schemaVersion: candidate.schemaVersion,
      publishedAt: candidate.publishedAt,
      compatibility: candidate.compatibility,
      databases: candidate.databases,
      assets: candidate.assets,
      verifier: candidate.verifier,
    }),
  );
  return candidate;
}

function recomputeVerifierAndSnapshotIdentity(candidate) {
  candidate.verifier.digest = hash(
    stableStringify({
      packs: candidate.verifier.packs,
      perTableRowCounts: candidate.verifier.perTableRowCounts,
    }),
  );
  candidate.snapshotId = hash(
    stableStringify({
      schemaVersion: candidate.schemaVersion,
      publishedAt: candidate.publishedAt,
      compatibility: candidate.compatibility,
      databases: candidate.databases,
      assets: candidate.assets,
      verifier: candidate.verifier,
    }),
  );
  return candidate;
}

async function createRestoreFixture({ restoreDatabase, resetSandboxAfterFailure, indexMutation } = {}) {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "representative-snapshot-fixture-"));
  temporaryRoots.push(cacheDir);
  const databaseBytes = Buffer.from("valid-database-dump");
  const assetBytes = Buffer.from("valid-asset-bundle");
  const currentCompatibility = compatibility();
  const snapshotManifest = manifest(currentCompatibility, databaseBytes, assetBytes);
  const manifestBody = Buffer.from(JSON.stringify(snapshotManifest));
  const manifestKey = `representative-snapshots/sets/${snapshotManifest.snapshotId}/manifest.json`;
  const index = {
    schemaVersion: REPRESENTATIVE_SNAPSHOT_INDEX_VERSION,
    updatedAt: snapshotManifest.publishedAt,
    entries: [
      {
        snapshotId: snapshotManifest.snapshotId,
        manifestKey,
        manifestSha256: hash(manifestBody),
        publishedAt: snapshotManifest.publishedAt,
        state: "published",
        compatibility: currentCompatibility,
      },
    ],
  };
  indexMutation?.(index, snapshotManifest);
  const getFile = vi.fn(async (key, target) => {
    await mkdir(path.dirname(target), { recursive: true });
    const body = key.endsWith("/manifest.json") ? manifestBody : key.endsWith(".dump") ? databaseBytes : assetBytes;
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
  const pack = currentCompatibility.acceptedPacks[0];
  const profile = currentCompatibility.providerProfiles[0];
  const packSet = [
    {
      sourceManifestKey: pack.manifestKey,
      packRoot: path.join(cacheDir, "packs"),
      manifest: {
        packId: pack.packId,
        packVersion: pack.packVersion,
        captureContentHash: pack.captureContentHash,
        identity: {
          provider: {
            key: profile.providerKey,
            integrationProfileKey: profile.profileKey,
            integrationProfileVersion: profile.profileVersion,
            ingestionUnit: profile.ingestionUnit,
          },
        },
      },
    },
  ];
  const restoreDatabaseSpy = restoreDatabase ?? vi.fn(async () => undefined);
  const restoreAssetBundle = vi.fn(async () => undefined);
  const resetSandbox = resetSandboxAfterFailure ?? vi.fn(async () => undefined);
  const dependencies = {
    storage,
    ensureSandbox: () => ({
      sandbox: {
        controlDatabaseUrl: "postgresql://localhost:6520/control",
        contextDatabaseUrls: { catalog: "postgresql://localhost:6520/catalog" },
      },
    }),
    loadAcceptedPackSet: async () => packSet,
    readMigrationsLedger: async () => ({ hash: currentCompatibility.migrationsHash, ledgers: [] }),
    validateAssetBundle: async () => undefined,
    restoreDatabase: restoreDatabaseSpy,
    restoreAssetBundle,
    resetSandboxAfterFailure: resetSandbox,
    runBootstrap: async () => undefined,
    computeVerifierEvidence: async () => snapshotManifest.verifier,
  };
  return {
    dependencies,
    getFile,
    index,
    options: {
      cacheDir,
      assetRoot: path.resolve("artifacts/representative-snapshot-test-assets"),
    },
    resetSandbox,
    restoreAssetBundle,
    restoreDatabase: restoreDatabaseSpy,
    snapshotManifest,
  };
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

  it.each([
    [
      "manifest key",
      {
        packId: "pack-pokemon",
        packVersion: "2026-07-23.1",
        manifestKey: "observation-packs/substituted/manifest.json",
        captureContentHash: hash("capture"),
      },
    ],
    [
      "capture content hash",
      {
        packId: "pack-pokemon",
        packVersion: "2026-07-23.1",
        manifestKey: "observation-packs/pokemon/manifest.json",
        captureContentHash: hash("substituted-capture"),
      },
    ],
  ])("refuses same-version %s substitution before snapshot selection", (_label, substitutedPack) => {
    const expected = compatibility();
    const substituted = compatibility({ acceptedPacks: [substitutedPack] });

    expect(substituted.key).not.toBe(expected.key);
    expect(representativeSnapshotCompatibilityRefusal(expected, substituted)).toBe(
      "representative-snapshot-pack-content-mismatch",
    );
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
    const validateAssetBundle = vi.fn(async () => undefined);

    const validated = await validateRepresentativeSnapshotFiles({
      manifest: manifest(compatibility(), databaseBytes, assetBytes),
      readFileForObject: async (key) => files.get(key),
      expectedCompatibility: compatibility(),
      expectedDatabaseKeys: ["control", "catalog"],
      validateAssetBundle,
    });
    for (const database of validated.manifest.databases) {
      restoreDatabase(database.key);
    }

    expect(restoreDatabase.mock.calls).toEqual([["control"], ["catalog"]]);
    expect(validateAssetBundle).toHaveBeenCalledWith(assetFile, validated.manifest.assets.entries);
  });

  it("downloads a cold cache once and reuses the fully validated warm cache", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "representative-snapshot-cache-"));
    temporaryRoots.push(cacheDir);
    const databaseBytes = Buffer.from("valid-database-dump");
    const assetBytes = Buffer.from("valid-asset-bundle");
    const currentCompatibility = compatibility();
    const snapshotManifest = manifest(currentCompatibility, databaseBytes, assetBytes);
    const manifestBody = Buffer.from(JSON.stringify(snapshotManifest));
    const manifestKey = `representative-snapshots/sets/${snapshotManifest.snapshotId}/manifest.json`;
    const index = {
      schemaVersion: REPRESENTATIVE_SNAPSHOT_INDEX_VERSION,
      updatedAt: "2026-07-23T12:00:00.000Z",
      entries: [
        {
          snapshotId: snapshotManifest.snapshotId,
          manifestKey,
          manifestSha256: hash(manifestBody),
          publishedAt: snapshotManifest.publishedAt,
          state: "published",
          compatibility: currentCompatibility,
        },
      ],
    };
    const getFile = vi.fn(async (key, target) => {
      await mkdir(path.dirname(target), { recursive: true });
      const body = key.endsWith("/manifest.json") ? manifestBody : key.endsWith(".dump") ? databaseBytes : assetBytes;
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
          controlDatabaseUrl: "postgresql://localhost/control",
          contextDatabaseUrls: { catalog: "postgresql://localhost/catalog" },
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

  it.each([
    ["reordered", (databases) => databases.reverse()],
    ["omitted", (databases) => databases.slice(0, 1)],
    [
      "extra",
      (databases) => [
        ...databases,
        {
          key: "discovery",
          objectKey: "databases/discovery.dump",
          byteCount: databases[0].byteCount,
          sha256: databases[0].sha256,
        },
      ],
    ],
  ])("rejects a %s database inventory", (_label, mutateDatabases) => {
    const databaseBytes = Buffer.from("database");
    const assetBytes = Buffer.from("assets");
    const candidate = manifest(compatibility(), databaseBytes, assetBytes);
    candidate.databases = mutateDatabases(candidate.databases);
    recomputeVerifierAndSnapshotIdentity(candidate);

    expect(() => validateRepresentativeSnapshotManifest(candidate, ["control", "catalog"])).toThrow(
      /representative-snapshot-database-inventory-mismatch/,
    );
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

  it.each([
    ["reordered", (packs) => packs.reverse()],
    ["substituted", (packs) => [{ ...packs[0], manifestKey: "packs/substituted/manifest.json" }, packs[1]]],
    ["omitted", (packs) => packs.slice(0, 1)],
    ["extra", (packs) => [...packs, { ...packs[1], packId: "pack-extra" }]],
  ])("refuses %s verifier pack structures even when their digest is recomputed", (_label, mutatePacks) => {
    const firstPack = compatibility().acceptedPacks[0];
    const secondPack = {
      packId: "pack-lorcana",
      packVersion: "2026-07-23.1",
      manifestKey: "observation-packs/lorcana/manifest.json",
      captureContentHash: hash("lorcana-capture"),
    };
    const currentCompatibility = compatibility({
      acceptedPacks: [firstPack, secondPack],
      providerProfiles: [
        compatibility().providerProfiles[0],
        {
          providerKey: "lorcanajson",
          profileKey: "lorcana-cards",
          profileVersion: "profile-v2",
          ingestionUnit: "cards-by-set",
        },
      ],
    });
    const candidate = manifest(currentCompatibility, Buffer.from("database"), Buffer.from("assets"));
    const baseVerifierPack = candidate.verifier.packs[0];
    candidate.verifier.packs = [
      {
        ...baseVerifierPack,
        packId: firstPack.packId,
        packVersion: firstPack.packVersion,
        manifestKey: firstPack.manifestKey,
        captureContentHash: firstPack.captureContentHash,
      },
      {
        ...baseVerifierPack,
        packId: secondPack.packId,
        packVersion: secondPack.packVersion,
        manifestKey: secondPack.manifestKey,
        captureContentHash: secondPack.captureContentHash,
        verifierDigest: hash("lorcana-verifier"),
        externalReferenceDigest: hash("lorcana-external-references"),
      },
    ];
    candidate.verifier.packs = mutatePacks(candidate.verifier.packs);
    recomputeVerifierAndSnapshotIdentity(candidate);

    expect(() => validateRepresentativeSnapshotManifest(candidate, ["control", "catalog"])).toThrow(
      /representative-snapshot-pack-structure-mismatch/,
    );
  });

  it("refuses substituted database/object mappings even when snapshot identity is recomputed", () => {
    const candidate = manifest(compatibility(), Buffer.from("database"), Buffer.from("assets"));
    candidate.databases[1].objectKey = "databases/control.dump";
    recomputeVerifierAndSnapshotIdentity(candidate);

    expect(() => validateRepresentativeSnapshotManifest(candidate, ["control", "catalog"])).toThrow(
      /representative-snapshot-database-object-mapping-mismatch/,
    );
  });

  it.each([
    ["reordered", (entries) => entries.reverse()],
    ["substituted", (entries) => [{ ...entries[0], sha256: hash("substituted") }, entries[1]]],
    ["omitted", (entries) => entries.slice(0, 1)],
    ["extra", (entries) => [...entries, { path: "catalog/items/extra.webp", byteCount: 5, sha256: hash("extra") }]],
  ])("refuses %s extracted asset inventories before replacement", (_label, mutateEntries) => {
    const expected = [
      { path: "catalog/items/a.webp", byteCount: 1, sha256: hash("a") },
      { path: "catalog/items/b.webp", byteCount: 1, sha256: hash("b") },
    ];

    expect(() => validateRepresentativeAssetInventory(expected, mutateEntries(structuredClone(expected)))).toThrow(
      /representative-snapshot-asset-inventory-mismatch/,
    );
  });

  it("binds the index to the exact manifest bytes before any destructive callback", async () => {
    const fixture = await createRestoreFixture({
      indexMutation: (index) => {
        index.entries[0].manifestSha256 = hash("different-manifest");
      },
    });

    await expect(restoreSnapshot(fixture.options, {}, fixture.dependencies)).rejects.toMatchObject({
      code: "representative-snapshot-index-manifest-mismatch",
    });
    expect(fixture.restoreDatabase).not.toHaveBeenCalled();
    expect(fixture.restoreAssetBundle).not.toHaveBeenCalled();
    expect(fixture.resetSandbox).not.toHaveBeenCalled();
  });

  it("refuses same-version pack-content substitution during index selection", async () => {
    const substitutedCompatibility = compatibility({
      acceptedPacks: [
        {
          ...compatibility().acceptedPacks[0],
          manifestKey: "observation-packs/substituted/manifest.json",
        },
      ],
    });
    const fixture = await createRestoreFixture({
      indexMutation: (index) => {
        index.entries[0].compatibility = substitutedCompatibility;
      },
    });

    await expect(restoreSnapshot(fixture.options, {}, fixture.dependencies)).rejects.toMatchObject({
      code: "representative-snapshot-pack-content-mismatch",
    });
    expect(fixture.getFile).not.toHaveBeenCalled();
    expect(fixture.restoreDatabase).not.toHaveBeenCalled();
    expect(fixture.resetSandbox).not.toHaveBeenCalled();
  });

  it("resets the whole disposable set after a mid-sequence database failure", async () => {
    const state = { control: "old", catalog: "old", assets: "old" };
    const restoreDatabase = vi.fn(async (database) => {
      if (database.key === "catalog") {
        throw new RepresentativeSnapshotError("representative-snapshot-restore-failed:catalog");
      }
      state[database.key] = "new";
    });
    const resetSandboxAfterFailure = vi.fn(async () => {
      state.control = "reset";
      state.catalog = "reset";
      state.assets = "reset";
    });
    const fixture = await createRestoreFixture({ restoreDatabase, resetSandboxAfterFailure });

    await expect(restoreSnapshot(fixture.options, {}, fixture.dependencies)).rejects.toMatchObject({
      code: "representative-snapshot-restore-failed:catalog",
      lifecycle: {
        state: "reset",
        transitions: ["compatible", "restoring", "resetting", "reset"],
      },
    });
    expect(restoreDatabase.mock.calls.map(([database]) => database.key)).toEqual(["control", "catalog"]);
    expect(fixture.restoreAssetBundle).not.toHaveBeenCalled();
    expect(resetSandboxAfterFailure).toHaveBeenCalledTimes(1);
    expect(state).toEqual({ control: "reset", catalog: "reset", assets: "reset" });
  });

  it("implements reset as scoped database-volume destruction plus asset-root removal", async () => {
    const artifactsRoot = path.resolve("artifacts");
    await mkdir(artifactsRoot, { recursive: true });
    const assetRoot = await mkdtemp(path.join(artifactsRoot, "representative-reset-test-"));
    temporaryRoots.push(assetRoot);
    await writeFile(path.join(assetRoot, "old.webp"), "old");
    const sandbox = { id: "lane-01" };
    const env = { PATH: "C:\\tools", PGHOSTADDR: "203.0.113.44" };
    const runProcess = vi.fn(async () => undefined);
    const resolveInvocation = vi.fn(() => ({
      command: "docker",
      args: ["compose", "-p", "chase-sets-lane-01", "down", "-v"],
      env: { PATH: "C:\\tools" },
    }));

    await resetRepresentativeSnapshotSandbox({
      sandbox,
      assetRoot,
      env,
      runProcess,
      resolveInvocation,
    });

    expect(resolveInvocation).toHaveBeenCalledWith(sandbox, env);
    expect(runProcess).toHaveBeenCalledWith(
      "docker",
      ["compose", "-p", "chase-sets-lane-01", "down", "-v"],
      expect.objectContaining({
        env: { PATH: "C:\\tools" },
        label: "representative-snapshot-reset-failed",
      }),
    );
    await expect(stat(assetRoot)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("reports a completed coordinated reset distinctly from a preflight refusal", async () => {
    let output = "";
    const exitCode = await runRepresentativeSnapshotCli(
      ["restore", "--target", "local"],
      {},
      { write: (value) => (output += value) },
      {
        restoreSnapshot: async () => {
          throw new RepresentativeSnapshotError("representative-snapshot-restore-failed:catalog", {
            state: "reset",
            transitions: ["compatible", "restoring", "resetting", "reset"],
          });
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(JSON.parse(output)).toMatchObject({
      command: "restore",
      status: "reset",
      lifecycle: {
        state: "reset",
        transitions: ["compatible", "restoring", "resetting", "reset"],
      },
      diagnostics: [{ code: "representative-snapshot-restore-failed:catalog" }],
    });
  });
});

describe("representative snapshot index contract", () => {
  it("keeps the index version distinct from the immutable set manifest version", () => {
    expect(REPRESENTATIVE_SNAPSHOT_INDEX_VERSION).toBe("representative-snapshot-index/v1");
    expect(REPRESENTATIVE_SNAPSHOT_MANIFEST_VERSION).toBe("representative-snapshot-set/v1");
  });
});
