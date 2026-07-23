#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

import { readEnvFile } from "./lib/env.mjs";
import { ensureWorktreeSandboxEnvironment, listSandboxDatabases } from "./lib/sandbox.mjs";

register("./typescript-extension-loader.mjs", import.meta.url);

const [
  { createFilesystemObjectFileStorage, createFilesystemObjectStorage, createS3ObjectFileStorage },
  { OBSERVATION_PACK_REPLAY_CONTRACT_VERSION, observationPackManifestV1Schema, stableStringify, verifyObservationPack },
  { getActiveCatalogProviderIntegrationProfileVersion },
  { verifyPostReplay },
] = await Promise.all([
  import("../infrastructure/object-storage/index.ts"),
  import("../bounded-contexts/catalog/features/source-observations/api/observation-pack.ts"),
  import("../bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.ts"),
  import("./verify-observation-pack.mjs"),
]);

export const REPRESENTATIVE_SNAPSHOT_MANIFEST_VERSION = "representative-snapshot-set/v1";
export const REPRESENTATIVE_SNAPSHOT_INDEX_VERSION = "representative-snapshot-index/v1";
export const REPRESENTATIVE_SNAPSHOT_PUBLISH_STATES = Object.freeze([
  "replaying",
  "published",
  "superseded",
  "deleted",
]);
export const REPRESENTATIVE_SNAPSHOT_RESTORE_STATES = Object.freeze(["compatible", "restoring", "restored"]);
export const REPRESENTATIVE_SNAPSHOT_PUBLISH_CONFIRMATION = "publish representative snapshot";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const indexObjectKey = "representative-snapshots/index.json";
const maxPackCount = 4;
const bootstrapProfiles = "critical-bootstrap,catalog-integration-bootstrap";
const representativeProfiles = `${bootstrapProfiles},representative-catalog`;
const snapshotCredentialNames = Object.freeze(["SEED_PACKS_SPACES_ACCESS_ID", "SEED_PACKS_SPACES_SECRET_KEY"]);
const snapshotCountKeys = Object.freeze([
  "envelopes",
  "observations",
  "catalogItems",
  "productAssetSets",
  "storedAssetUrls",
  "discoverySearchItems",
  "discoveryItemDetails",
]);

export class RepresentativeSnapshotError extends Error {
  constructor(code) {
    super(code);
    this.name = "RepresentativeSnapshotError";
    this.code = code;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runRepresentativeSnapshotCli(process.argv.slice(2), process.env, process.stdout);
}

export async function runRepresentativeSnapshotCli(argv, env, output, dependencies = {}) {
  try {
    const options = parseOptions(argv, env);
    const result =
      options.command === "publish"
        ? await (dependencies.publishSnapshot ?? publishSnapshot)(options, env, dependencies)
        : await (dependencies.restoreSnapshot ?? restoreSnapshot)(options, env, dependencies);
    writeSafeOutput(output, result);
    if (options.reportPath) {
      await mkdir(path.dirname(options.reportPath), { recursive: true });
      await writeFile(options.reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    }
    return 0;
  } catch (error) {
    const code = error instanceof RepresentativeSnapshotError ? error.code : "representative-snapshot-operation-failed";
    writeSafeOutput(output, {
      command: argv[0] === "publish" ? "publish" : "restore",
      status: "refused",
      lifecycle: { state: "refused", transitions: [] },
      diagnostics: [{ code }],
    });
    return 1;
  }
}

export function buildRepresentativeSnapshotCompatibility({
  acceptedPacks,
  providerProfiles,
  replayContractVersion,
  migrationsHash,
}) {
  const components = {
    acceptedPacks: acceptedPacks.map(({ packId, packVersion }) => ({ packId, packVersion })),
    providerProfiles: providerProfiles.map(({ providerKey, profileKey, profileVersion, ingestionUnit }) => ({
      providerKey,
      profileKey,
      profileVersion,
      ingestionUnit,
    })),
    replayContractVersion,
    migrationsHash,
  };
  return {
    key: sha256Text(stableStringify(components)),
    acceptedPacks: acceptedPacks.map((pack) => ({ ...pack })),
    providerProfiles: providerProfiles.map((profile) => ({ ...profile })),
    replayContractVersion,
    migrationsHash,
  };
}

export function representativeSnapshotCompatibilityRefusal(expected, actual) {
  const expectedPacks = expected.acceptedPacks.map(({ packId, packVersion }) => ({ packId, packVersion }));
  const actualPacks = actual.acceptedPacks.map(({ packId, packVersion }) => ({ packId, packVersion }));
  if (stableStringify(expectedPacks) !== stableStringify(actualPacks)) {
    return "representative-snapshot-pack-version-mismatch";
  }
  if (stableStringify(expected.providerProfiles) !== stableStringify(actual.providerProfiles)) {
    return "representative-snapshot-profile-version-mismatch";
  }
  if (expected.replayContractVersion !== actual.replayContractVersion) {
    return "representative-snapshot-replay-contract-version-mismatch";
  }
  if (expected.migrationsHash !== actual.migrationsHash) {
    return "representative-snapshot-migrations-hash-mismatch";
  }
  if (expected.key !== actual.key) {
    return "representative-snapshot-compatibility-key-mismatch";
  }
  return null;
}

export async function validateRepresentativeSnapshotFiles({
  manifest,
  readFileForObject,
  expectedCompatibility,
  expectedDatabaseKeys,
  validateAssetBundle = async () => undefined,
}) {
  const validated = validateRepresentativeSnapshotManifest(manifest, expectedDatabaseKeys);
  const refusal = representativeSnapshotCompatibilityRefusal(expectedCompatibility, validated.compatibility);
  if (refusal) {
    throw new RepresentativeSnapshotError(refusal);
  }

  const files = new Map();
  for (const database of validated.databases) {
    const filePath = await readFileForObject(database.objectKey);
    if (
      !filePath ||
      (await stat(filePath)).size !== database.byteCount ||
      (await sha256File(filePath)) !== database.sha256
    ) {
      throw new RepresentativeSnapshotError("representative-snapshot-dump-digest-mismatch");
    }
    files.set(database.objectKey, filePath);
  }
  const assetPath = await readFileForObject(validated.assets.objectKey);
  if (
    !assetPath ||
    (await stat(assetPath)).size !== validated.assets.byteCount ||
    (await sha256File(assetPath)) !== validated.assets.sha256
  ) {
    throw new RepresentativeSnapshotError("representative-snapshot-asset-digest-mismatch");
  }
  await validateAssetBundle(assetPath);
  files.set(validated.assets.objectKey, assetPath);
  return { manifest: validated, files };
}

export function validateRepresentativeSnapshotManifest(value, expectedDatabaseKeys) {
  requireClosedObject(value, [
    "schemaVersion",
    "snapshotId",
    "publishedAt",
    "lifecycle",
    "compatibility",
    "databases",
    "assets",
    "verifier",
  ]);
  requireEqual(value.schemaVersion, REPRESENTATIVE_SNAPSHOT_MANIFEST_VERSION);
  requireSha256(value.snapshotId);
  requireInstant(value.publishedAt);
  requireClosedObject(value.lifecycle, ["state", "publishStates", "restoreStates"]);
  requireEqual(value.lifecycle.state, "published");
  requireExactStringArray(value.lifecycle.publishStates, REPRESENTATIVE_SNAPSHOT_PUBLISH_STATES);
  requireExactStringArray(value.lifecycle.restoreStates, REPRESENTATIVE_SNAPSHOT_RESTORE_STATES);
  validateCompatibility(value.compatibility);
  if (!Array.isArray(value.databases) || value.databases.length !== expectedDatabaseKeys.length) {
    throw new RepresentativeSnapshotError("representative-snapshot-database-inventory-mismatch");
  }
  const databaseKeys = [];
  for (const database of value.databases) {
    requireClosedObject(database, ["key", "objectKey", "byteCount", "sha256"]);
    requireSafeKey(database.key);
    requireSafeObjectKey(database.objectKey);
    requirePositiveInteger(database.byteCount);
    requireSha256(database.sha256);
    databaseKeys.push(database.key);
  }
  if (stableStringify(databaseKeys) !== stableStringify(expectedDatabaseKeys)) {
    throw new RepresentativeSnapshotError("representative-snapshot-database-inventory-mismatch");
  }
  requireClosedObject(value.assets, ["objectKey", "byteCount", "sha256", "fileCount"]);
  requireSafeObjectKey(value.assets.objectKey);
  requirePositiveInteger(value.assets.byteCount);
  requireSha256(value.assets.sha256);
  requireNonNegativeInteger(value.assets.fileCount);
  validateVerifier(value.verifier);
  const expectedSnapshotId = sha256Text(
    stableStringify({
      publishedAt: value.publishedAt,
      compatibilityKey: value.compatibility.key,
      verifierDigest: value.verifier.digest,
      databases: value.databases.map(({ key, sha256 }) => ({ key, sha256 })),
      assets: value.assets.sha256,
    }),
  );
  if (value.snapshotId !== expectedSnapshotId) {
    throw new RepresentativeSnapshotError("representative-snapshot-identity-mismatch");
  }
  return value;
}

export async function publishSnapshot(options, env, dependencies) {
  if (options.confirm !== REPRESENTATIVE_SNAPSHOT_PUBLISH_CONFIRMATION) {
    throw new RepresentativeSnapshotError("representative-snapshot-publish-unconfirmed");
  }
  const storage = dependencies.storage ?? createSnapshotStorage(options, env);
  const sandbox = (dependencies.ensureSandbox ?? ensureWorktreeSandboxEnvironment)({ rootDir, env }).sandbox;
  const databases = listSandboxDatabases(sandbox);
  const workDir = path.join(rootDir, "artifacts", "representative-snapshot-work", randomUUID());
  await mkdir(workDir, { recursive: true });
  try {
    const packSet = await (dependencies.loadAcceptedPackSet ?? loadAcceptedPackSet)(options, storage, workDir);
    const packRoot = commonPackRoot(packSet);
    await (dependencies.runReplay ?? runProcess)(
      process.execPath,
      [fileURLToPath(new URL("./dev-system.mjs", import.meta.url)), "refresh", "--representative", "--replay"],
      {
        cwd: rootDir,
        env: {
          ...withoutSnapshotCredentials(env),
          PLATFORM_DATA_PROFILES: representativeProfiles,
          REPRESENTATIVE_CATALOG_PACK_SOURCE: packRoot,
        },
        label: "representative-snapshot-replay-failed",
      },
    );
    const assetRoot = resolveCatalogAssetRoot(options.assetRoot, env);
    const verifier = await computeVerifierEvidence(packSet, databases, assetRoot, dependencies);
    const migrations = await readMigrationsLedger(databases, dependencies);
    const compatibility = compatibilityFromPackSet(packSet, migrations.hash);
    const payloadDir = path.join(workDir, "payload");
    await mkdir(path.join(payloadDir, "databases"), { recursive: true });
    const databaseRecords = [];
    for (const database of databases) {
      const objectKey = `databases/${database.key}.dump`;
      const filePath = path.join(payloadDir, ...objectKey.split("/"));
      await (dependencies.dumpDatabase ?? dumpDatabase)(database, filePath);
      databaseRecords.push({
        key: database.key,
        objectKey,
        byteCount: (await stat(filePath)).size,
        sha256: await sha256File(filePath),
      });
    }
    const assetObjectKey = "assets/catalog-assets.tar.gz";
    const assetFilePath = path.join(payloadDir, ...assetObjectKey.split("/"));
    await mkdir(path.dirname(assetFilePath), { recursive: true });
    const assetFileCount = await (dependencies.createAssetBundle ?? createAssetBundle)(assetRoot, assetFilePath);
    const assets = {
      objectKey: assetObjectKey,
      byteCount: (await stat(assetFilePath)).size,
      sha256: await sha256File(assetFilePath),
      fileCount: assetFileCount,
    };
    const publishedAt = new Date().toISOString();
    const snapshotId = sha256Text(
      stableStringify({
        publishedAt,
        compatibilityKey: compatibility.key,
        verifierDigest: verifier.digest,
        databases: databaseRecords.map(({ key, sha256 }) => ({ key, sha256 })),
        assets: assets.sha256,
      }),
    );
    const manifest = {
      schemaVersion: REPRESENTATIVE_SNAPSHOT_MANIFEST_VERSION,
      snapshotId,
      publishedAt,
      lifecycle: {
        state: "published",
        publishStates: REPRESENTATIVE_SNAPSHOT_PUBLISH_STATES,
        restoreStates: REPRESENTATIVE_SNAPSHOT_RESTORE_STATES,
      },
      compatibility,
      databases: databaseRecords,
      assets,
      verifier,
    };
    validateRepresentativeSnapshotManifest(
      manifest,
      databases.map(({ key }) => key),
    );
    const prefix = snapshotPrefix(snapshotId);
    for (const record of [...databaseRecords, assets]) {
      await storage.putFile({
        key: `${prefix}/${record.objectKey}`,
        filePath: path.join(payloadDir, ...record.objectKey.split("/")),
        contentType: record.objectKey.endsWith(".dump") ? "application/octet-stream" : "application/gzip",
        visibility: "private",
      });
    }
    const manifestKey = `${prefix}/manifest.json`;
    await storage.putObject({
      key: manifestKey,
      body: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
      contentType: "application/json",
      visibility: "private",
    });
    const index = await readSnapshotIndex(storage);
    const nextIndex = {
      schemaVersion: REPRESENTATIVE_SNAPSHOT_INDEX_VERSION,
      updatedAt: publishedAt,
      entries: [
        ...(index?.entries ?? []).map((entry) =>
          entry.state === "published" ? { ...entry, state: "superseded" } : entry,
        ),
        {
          snapshotId,
          manifestKey,
          publishedAt,
          state: "published",
          compatibility,
        },
      ],
    };
    validateSnapshotIndex(nextIndex);
    await storage.putObject({
      key: indexObjectKey,
      body: new TextEncoder().encode(`${JSON.stringify(nextIndex, null, 2)}\n`),
      contentType: "application/json",
      visibility: "private",
    });
    return {
      command: "publish",
      status: "published",
      snapshotId,
      manifestKey,
      compatibilityKey: compatibility.key,
      verifierDigest: verifier.digest,
      databaseKeys: databaseRecords.map(({ key }) => key),
      lifecycle: { state: "published", transitions: ["replaying", "published"] },
      diagnostics: [],
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function restoreSnapshot(options, env, dependencies) {
  const storage = dependencies.storage ?? createSnapshotStorage(options, env);
  const sandbox = (dependencies.ensureSandbox ?? ensureWorktreeSandboxEnvironment)({ rootDir, env }).sandbox;
  const databases = listSandboxDatabases(sandbox);
  const workDir = path.join(rootDir, "artifacts", "representative-snapshot-work", randomUUID());
  await mkdir(workDir, { recursive: true });
  try {
    const packSet = await (dependencies.loadAcceptedPackSet ?? loadAcceptedPackSet)(options, storage, workDir);
    const migrations = await readMigrationsLedger(databases, dependencies);
    const expectedCompatibility = compatibilityFromPackSet(packSet, migrations.hash);
    const index = await readSnapshotIndex(storage);
    if (!index) {
      throw new RepresentativeSnapshotError("representative-snapshot-missing");
    }
    const publishedEntries = index.entries.filter((entry) => entry.state === "published");
    const selected = publishedEntries.find((entry) => entry.compatibility.key === expectedCompatibility.key);
    if (!selected) {
      const newest = publishedEntries.toSorted((left, right) => right.publishedAt.localeCompare(left.publishedAt))[0];
      if (!newest) {
        throw new RepresentativeSnapshotError("representative-snapshot-missing");
      }
      throw new RepresentativeSnapshotError(
        representativeSnapshotCompatibilityRefusal(expectedCompatibility, newest.compatibility) ??
          "representative-snapshot-compatibility-key-mismatch",
      );
    }
    const cacheRoot = path.resolve(options.cacheDir);
    const cacheSnapshotDir = path.join(cacheRoot, selected.snapshotId);
    await mkdir(cacheSnapshotDir, { recursive: true });
    const manifestPath = path.join(cacheSnapshotDir, "manifest.json");
    let cacheMisses = 0;
    if (!(await fileExists(manifestPath))) {
      const fetched = await storage.getFile(selected.manifestKey, manifestPath);
      if (!fetched) {
        throw new RepresentativeSnapshotError("representative-snapshot-missing");
      }
      cacheMisses += 1;
    }
    const manifest = parseJson(await readFile(manifestPath), "representative-snapshot-manifest-schema-invalid");
    if (manifest.snapshotId !== selected.snapshotId) {
      throw new RepresentativeSnapshotError("representative-snapshot-identity-mismatch");
    }
    const prefix = objectKeyDirectory(selected.manifestKey);
    const readFileForObject = async (objectKey) => {
      const target = path.join(cacheSnapshotDir, ...objectKey.split("/"));
      if (await fileExists(target)) {
        return target;
      }
      const fetched = await storage.getFile(`${prefix}/${objectKey}`, target);
      if (!fetched) {
        return null;
      }
      cacheMisses += 1;
      return target;
    };
    const validated = await validateRepresentativeSnapshotFiles({
      manifest,
      readFileForObject,
      expectedCompatibility,
      expectedDatabaseKeys: databases.map(({ key }) => key),
      validateAssetBundle: dependencies.validateAssetBundle ?? validateAssetBundle,
    });
    for (const database of databases) {
      const record = validated.manifest.databases.find(({ key }) => key === database.key);
      await (dependencies.restoreDatabase ?? restoreDatabase)(database, validated.files.get(record.objectKey));
    }
    const assetRoot = resolveCatalogAssetRoot(options.assetRoot, env);
    await (dependencies.restoreAssetBundle ?? restoreAssetBundle)(
      validated.files.get(validated.manifest.assets.objectKey),
      assetRoot,
    );
    const packRoot = commonPackRoot(packSet);
    await (dependencies.runBootstrap ?? runProcess)(
      process.execPath,
      [fileURLToPath(new URL("./dev-system.mjs", import.meta.url)), "bootstrap"],
      {
        cwd: rootDir,
        env: {
          ...withoutSnapshotCredentials(env),
          PLATFORM_DATA_PROFILES: representativeProfiles,
          REPRESENTATIVE_CATALOG_PACK_SOURCE: packRoot,
        },
        label: "representative-snapshot-post-restore-bootstrap-failed",
      },
    );
    const verifier = await computeVerifierEvidence(packSet, databases, assetRoot, dependencies);
    if (verifier.digest !== validated.manifest.verifier.digest) {
      throw new RepresentativeSnapshotError("representative-snapshot-verifier-digest-mismatch");
    }
    return {
      command: "restore",
      status: "restored",
      snapshotId: selected.snapshotId,
      compatibilityKey: expectedCompatibility.key,
      verifierDigest: verifier.digest,
      cache: cacheMisses === 0 ? "warm" : "cold",
      databaseKeys: databases.map(({ key }) => key),
      lifecycle: { state: "restored", transitions: ["compatible", "restoring", "restored"] },
      diagnostics: [],
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function loadAcceptedPackSet(options, snapshotStorage, workDir) {
  const packRoot = path.join(workDir, "accepted-packs");
  await mkdir(packRoot, { recursive: true });
  const sources = [];
  if (options.packSource) {
    const manifests = await findManifestFiles(path.resolve(options.packSource));
    for (const [index, manifestPath] of manifests.entries()) {
      const sourceRoot = path.dirname(manifestPath);
      sources.push({
        storage: createFilesystemObjectStorage({
          rootDir: sourceRoot,
          publicBaseUrl: "https://local.invalid/private",
        }),
        manifestKey: "manifest.json",
        packRoot: path.resolve(options.packSource),
        sourceManifestKey: `local:${index}`,
      });
    }
  } else {
    if (options.packManifestKeys.length === 0 || options.packManifestKeys.length > maxPackCount) {
      throw new RepresentativeSnapshotError("representative-snapshot-pack-set-invalid");
    }
    for (const [index, manifestKey] of options.packManifestKeys.entries()) {
      const manifestObject = await snapshotStorage.getObject(manifestKey);
      if (!manifestObject) {
        throw new RepresentativeSnapshotError("representative-snapshot-pack-set-invalid");
      }
      const manifest = parseObservationPackManifest(manifestObject.body);
      const sourceRoot = path.join(packRoot, String(index).padStart(2, "0"));
      await mkdir(sourceRoot, { recursive: true });
      await writeFile(path.join(sourceRoot, "manifest.json"), manifestObject.body);
      const prefix = objectKeyDirectory(manifestKey);
      for (const declared of [...manifest.entries, ...manifest.assets]) {
        const target = path.join(sourceRoot, ...declared.path.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        const fetched = await snapshotStorage.getFile(`${prefix}/${declared.path}`, target);
        if (!fetched) {
          throw new RepresentativeSnapshotError("representative-snapshot-pack-set-invalid");
        }
      }
      sources.push({
        storage: createFilesystemObjectStorage({
          rootDir: sourceRoot,
          publicBaseUrl: "https://local.invalid/private",
        }),
        manifestKey: "manifest.json",
        packRoot,
        sourceManifestKey: manifestKey,
      });
    }
  }
  if (sources.length === 0 || sources.length > maxPackCount) {
    throw new RepresentativeSnapshotError("representative-snapshot-pack-set-invalid");
  }
  const packSet = [];
  for (const source of sources) {
    const verification = await verifyObservationPack({
      storage: source.storage,
      manifestKey: source.manifestKey,
      requireAccepted: true,
    }).catch(() => null);
    if (!verification?.valid || !verification.replayEligible || !verification.manifest) {
      throw new RepresentativeSnapshotError("representative-snapshot-pack-set-invalid");
    }
    const manifest = verification.manifest;
    const provider = manifest.identity.provider;
    const activeProfile = getActiveCatalogProviderIntegrationProfileVersion(provider.key, {
      profileKey: provider.integrationProfileKey,
      ingestionUnitKey: provider.ingestionUnit,
    });
    if (!activeProfile || activeProfile.profileVersion !== provider.integrationProfileVersion) {
      throw new RepresentativeSnapshotError("representative-snapshot-profile-version-mismatch");
    }
    packSet.push({ ...source, manifest });
  }
  return packSet;
}

function compatibilityFromPackSet(packSet, migrationsHash) {
  return buildRepresentativeSnapshotCompatibility({
    acceptedPacks: packSet.map(({ manifest, sourceManifestKey }) => ({
      packId: manifest.packId,
      packVersion: manifest.packVersion,
      manifestKey: sourceManifestKey,
      captureContentHash: manifest.captureContentHash,
    })),
    providerProfiles: packSet.map(({ manifest }) => ({
      providerKey: manifest.identity.provider.key,
      profileKey: manifest.identity.provider.integrationProfileKey,
      profileVersion: manifest.identity.provider.integrationProfileVersion,
      ingestionUnit: manifest.identity.provider.ingestionUnit,
    })),
    replayContractVersion: OBSERVATION_PACK_REPLAY_CONTRACT_VERSION,
    migrationsHash,
  });
}

async function computeVerifierEvidence(packSet, databases, assetRoot, dependencies) {
  if (dependencies.computeVerifierEvidence) {
    return dependencies.computeVerifierEvidence(packSet, databases, assetRoot);
  }
  const catalogDatabaseUrl = requiredDatabase(databases, "catalog").databaseUrl;
  const discoveryDatabaseUrl = requiredDatabase(databases, "discovery").databaseUrl;
  const server = await startAssetServer(assetRoot);
  try {
    const packs = [];
    let perTableRowCounts = null;
    for (const { manifest, storage, manifestKey } of packSet) {
      const result = await verifyPostReplay({
        target: { storage, manifestKey },
        manifest,
        options: {
          catalogDatabaseUrl,
          discoveryDatabaseUrl,
          assetBaseUrl: server.baseUrl,
        },
        env: {},
        fetch: globalThis.fetch,
      });
      if (perTableRowCounts && stableStringify(perTableRowCounts) !== stableStringify(result.perTableRowCounts)) {
        throw new RepresentativeSnapshotError("representative-snapshot-verifier-digest-mismatch");
      }
      perTableRowCounts ??= result.perTableRowCounts;
      packs.push({
        packId: manifest.packId,
        packVersion: manifest.packVersion,
        verifierDigest: result.verifierDigest,
        externalReferenceDigest: result.externalReferenceDigest,
        counts: result.counts,
      });
    }
    const evidence = { packs, perTableRowCounts: perTableRowCounts ?? [] };
    return { digest: sha256Text(stableStringify(evidence)), ...evidence };
  } finally {
    await server.close();
  }
}

async function readMigrationsLedger(databases, dependencies) {
  if (dependencies.readMigrationsLedger) {
    return dependencies.readMigrationsLedger(databases);
  }
  const ledgers = [];
  for (const database of databases) {
    const pool = new pg.Pool({
      connectionString: database.databaseUrl,
      max: 1,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      query_timeout: 20_000,
    });
    try {
      let rows = [];
      try {
        const result = await pool.query(
          `SELECT migration_id, description
           FROM bounded_context_schema_migrations
           ORDER BY migration_id`,
        );
        rows = result.rows.map(({ migration_id, description }) => ({
          migrationId: migration_id,
          description,
        }));
      } catch (error) {
        if (error?.code !== "42P01") {
          throw error;
        }
      }
      ledgers.push({ databaseKey: database.key, migrations: rows });
    } finally {
      await pool.end();
    }
  }
  return { ledgers, hash: sha256Text(stableStringify(ledgers)) };
}

async function dumpDatabase(database, filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await runProcess(
    "pg_dump",
    [
      "--format=custom",
      "--no-owner",
      "--no-acl",
      "--file",
      filePath,
      "--dbname",
      localDatabaseUrl(database.databaseUrl),
    ],
    {
      env: withoutSnapshotCredentials(process.env),
      cwd: rootDir,
      label: `representative-snapshot-dump-failed:${database.key}`,
    },
  );
}

async function restoreDatabase(database, filePath) {
  await runProcess(
    "pg_restore",
    [
      "--clean",
      "--if-exists",
      "--no-owner",
      "--no-acl",
      "--exit-on-error",
      "--dbname",
      localDatabaseUrl(database.databaseUrl),
      filePath,
    ],
    {
      env: withoutSnapshotCredentials(process.env),
      cwd: rootDir,
      label: `representative-snapshot-restore-failed:${database.key}`,
    },
  );
}

async function createAssetBundle(assetRoot, archivePath) {
  const files = await listAssetFiles(assetRoot);
  await runProcess("tar", ["-czf", archivePath, "-C", assetRoot, "."], {
    cwd: rootDir,
    env: withoutSnapshotCredentials(process.env),
    label: "representative-snapshot-asset-bundle-failed",
  });
  return files.length;
}

async function validateAssetBundle(archivePath) {
  const entries = await captureProcess("tar", ["-tzf", archivePath], {
    cwd: rootDir,
    env: withoutSnapshotCredentials(process.env),
    label: "representative-snapshot-asset-bundle-invalid",
  });
  for (const entry of entries.split(/\r?\n/).filter(Boolean)) {
    const normalized = entry.replaceAll("\\", "/").replace(/^\.\/+/, "");
    if (
      path.posix.isAbsolute(normalized) ||
      normalized.split("/").some((segment) => segment === "..") ||
      /^[a-z]:/i.test(normalized)
    ) {
      throw new RepresentativeSnapshotError("representative-snapshot-asset-bundle-invalid");
    }
  }
}

async function restoreAssetBundle(archivePath, assetRoot) {
  requireArtifactPath(assetRoot);
  const stage = `${assetRoot}.restoring-${randomUUID()}`;
  const backup = `${assetRoot}.backup-${randomUUID()}`;
  await mkdir(stage, { recursive: true });
  try {
    await runProcess("tar", ["-xzf", archivePath, "-C", stage], {
      cwd: rootDir,
      env: withoutSnapshotCredentials(process.env),
      label: "representative-snapshot-asset-restore-failed",
    });
    const hadExisting = await fileExists(assetRoot);
    if (hadExisting) {
      await rename(assetRoot, backup);
    }
    try {
      await rename(stage, assetRoot);
      if (hadExisting) {
        await rm(backup, { recursive: true, force: true });
      }
    } catch (error) {
      if (hadExisting && !(await fileExists(assetRoot))) {
        await rename(backup, assetRoot);
      }
      throw error;
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function createSnapshotStorage(options, env) {
  if (options.target === "local") {
    return createFilesystemObjectFileStorage({
      rootDir: options.storageDir,
      publicBaseUrl: "https://local.invalid/private",
    });
  }
  const missing = snapshotCredentialNames.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new RepresentativeSnapshotError(`representative-snapshot-space-credentials-missing:${missing.join(",")}`);
  }
  return createS3ObjectFileStorage({
    bucket: env.SEED_PACKS_SPACES_BUCKET?.trim() || "cs-dev-seed-packs",
    region: env.SEED_PACKS_SPACES_REGION?.trim() || "nyc3",
    endpoint: env.SEED_PACKS_SPACES_ENDPOINT?.trim() || "https://nyc3.digitaloceanspaces.com",
    accessKeyId: env.SEED_PACKS_SPACES_ACCESS_ID.trim(),
    secretAccessKey: env.SEED_PACKS_SPACES_SECRET_KEY.trim(),
    publicBaseUrl: "https://private.invalid",
  });
}

async function readSnapshotIndex(storage) {
  const object = await storage.getObject(indexObjectKey);
  if (!object) {
    return null;
  }
  const index = parseJson(object.body, "representative-snapshot-index-invalid");
  validateSnapshotIndex(index);
  return index;
}

function validateSnapshotIndex(value) {
  requireClosedObject(value, ["schemaVersion", "updatedAt", "entries"]);
  requireEqual(value.schemaVersion, REPRESENTATIVE_SNAPSHOT_INDEX_VERSION);
  requireInstant(value.updatedAt);
  if (!Array.isArray(value.entries)) {
    throw new RepresentativeSnapshotError("representative-snapshot-index-invalid");
  }
  for (const entry of value.entries) {
    requireClosedObject(entry, ["snapshotId", "manifestKey", "publishedAt", "state", "compatibility"]);
    requireSha256(entry.snapshotId);
    requireSafeObjectKey(entry.manifestKey);
    if (entry.manifestKey !== `${snapshotPrefix(entry.snapshotId)}/manifest.json`) {
      throw new RepresentativeSnapshotError("representative-snapshot-index-invalid");
    }
    requireInstant(entry.publishedAt);
    if (!["published", "superseded", "deleted"].includes(entry.state)) {
      throw new RepresentativeSnapshotError("representative-snapshot-index-invalid");
    }
    validateCompatibility(entry.compatibility);
  }
  if (value.entries.filter(({ state }) => state === "published").length > 1) {
    throw new RepresentativeSnapshotError("representative-snapshot-index-invalid");
  }
}

function validateCompatibility(value) {
  requireClosedObject(value, ["key", "acceptedPacks", "providerProfiles", "replayContractVersion", "migrationsHash"]);
  requireSha256(value.key);
  requireSha256(value.migrationsHash);
  requireNonEmptyString(value.replayContractVersion);
  if (!Array.isArray(value.acceptedPacks) || value.acceptedPacks.length === 0) {
    throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
  }
  for (const pack of value.acceptedPacks) {
    requireClosedObject(pack, ["packId", "packVersion", "manifestKey", "captureContentHash"]);
    requireNonEmptyString(pack.packId);
    requireNonEmptyString(pack.packVersion);
    requireNonEmptyString(pack.manifestKey);
    requireContentDigest(pack.captureContentHash);
  }
  if (!Array.isArray(value.providerProfiles) || value.providerProfiles.length !== value.acceptedPacks.length) {
    throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
  }
  for (const profile of value.providerProfiles) {
    requireClosedObject(profile, ["providerKey", "profileKey", "profileVersion", "ingestionUnit"]);
    requireNonEmptyString(profile.providerKey);
    requireNonEmptyString(profile.profileKey);
    requireNonEmptyString(profile.profileVersion);
    requireNonEmptyString(profile.ingestionUnit);
  }
  const expectedKey = buildRepresentativeSnapshotCompatibility({
    acceptedPacks: value.acceptedPacks,
    providerProfiles: value.providerProfiles,
    replayContractVersion: value.replayContractVersion,
    migrationsHash: value.migrationsHash,
  }).key;
  if (value.key !== expectedKey) {
    throw new RepresentativeSnapshotError("representative-snapshot-compatibility-key-mismatch");
  }
}

function validateVerifier(value) {
  requireClosedObject(value, ["digest", "packs", "perTableRowCounts"]);
  requireSha256(value.digest);
  if (!Array.isArray(value.packs) || value.packs.length === 0) {
    throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
  }
  for (const pack of value.packs) {
    requireClosedObject(pack, ["packId", "packVersion", "verifierDigest", "externalReferenceDigest", "counts"]);
    requireNonEmptyString(pack.packId);
    requireNonEmptyString(pack.packVersion);
    requireContentDigest(pack.verifierDigest);
    requireContentDigest(pack.externalReferenceDigest);
    requireClosedObject(pack.counts, snapshotCountKeys);
    for (const key of snapshotCountKeys) {
      requireNonNegativeInteger(pack.counts[key]);
    }
  }
  if (!Array.isArray(value.perTableRowCounts)) {
    throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
  }
  for (const count of value.perTableRowCounts) {
    requireClosedObject(count, ["table", "rowCount"]);
    requireNonEmptyString(count.table);
    if (typeof count.rowCount !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(count.rowCount)) {
      throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
    }
  }
  if (
    value.digest !== sha256Text(stableStringify({ packs: value.packs, perTableRowCounts: value.perTableRowCounts }))
  ) {
    throw new RepresentativeSnapshotError("representative-snapshot-verifier-digest-mismatch");
  }
}

function parseOptions(argv, env) {
  const command = argv[0];
  if (!["publish", "restore"].includes(command)) {
    throw new RepresentativeSnapshotError("representative-snapshot-command-invalid");
  }
  const known = new Set([
    "--target",
    "--storage-dir",
    "--pack-source",
    "--pack-manifest-keys",
    "--cache-dir",
    "--report",
    "--confirm",
    "--asset-root",
  ]);
  for (let index = 1; index < argv.length; index += 1) {
    const name = argv[index].split("=", 1)[0];
    if (!known.has(name)) {
      throw new RepresentativeSnapshotError("representative-snapshot-option-invalid");
    }
    if (!argv[index].includes("=")) {
      index += 1;
      if (index >= argv.length || argv[index].startsWith("--")) {
        throw new RepresentativeSnapshotError("representative-snapshot-option-invalid");
      }
    }
  }
  const target = readOption(argv, "--target") ?? env.REPRESENTATIVE_SNAPSHOT_TARGET?.trim() ?? "space";
  if (!["local", "space"].includes(target)) {
    throw new RepresentativeSnapshotError("representative-snapshot-target-invalid");
  }
  const rawManifestKeys =
    readOption(argv, "--pack-manifest-keys") ?? env.REPRESENTATIVE_CATALOG_PACK_MANIFEST_KEYS ?? "";
  return {
    command,
    target,
    storageDir: path.resolve(
      readOption(argv, "--storage-dir") ??
        env.REPRESENTATIVE_SNAPSHOT_STORAGE_DIR ??
        path.join(rootDir, "artifacts", "representative-snapshot-space"),
    ),
    packSource: readOption(argv, "--pack-source") ?? env.REPRESENTATIVE_CATALOG_PACK_SOURCE?.trim() ?? null,
    packManifestKeys: rawManifestKeys
      .split(/[\r\n,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
    cacheDir: path.resolve(
      readOption(argv, "--cache-dir") ??
        env.REPRESENTATIVE_SNAPSHOT_CACHE_DIR ??
        path.join(rootDir, "artifacts", "representative-snapshot-cache"),
    ),
    reportPath: readOption(argv, "--report") ? path.resolve(readOption(argv, "--report")) : null,
    confirm: readOption(argv, "--confirm") ?? "",
    assetRoot: readOption(argv, "--asset-root") ?? null,
  };
}

function readOption(argv, name) {
  const inline = argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1).trim() || null;
  }
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1]?.trim() || null : null;
}

function resolveCatalogAssetRoot(explicit, env) {
  const deployableDir = path.join(rootDir, "deployables", "platform-api");
  const example = readEnvFile(path.join(deployableDir, ".env.example"));
  const local = readEnvFile(path.join(deployableDir, ".env.local"));
  const configured =
    explicit ??
    env.CATALOG_ASSET_LOCAL_ROOT?.trim() ??
    local.CATALOG_ASSET_LOCAL_ROOT ??
    example.CATALOG_ASSET_LOCAL_ROOT ??
    "../../artifacts/catalog-assets/platform-api";
  const resolved = path.resolve(deployableDir, configured);
  requireArtifactPath(resolved);
  return resolved;
}

function requireArtifactPath(value) {
  const artifactsRoot = path.resolve(rootDir, "artifacts");
  const relative = path.relative(artifactsRoot, path.resolve(value));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new RepresentativeSnapshotError("representative-snapshot-asset-root-unsafe");
  }
}

async function findManifestFiles(root) {
  const manifests = [];
  async function visit(current, depth) {
    if (depth > 8) {
      throw new RepresentativeSnapshotError("representative-snapshot-pack-set-invalid");
    }
    const currentStat = await lstat(current).catch(() => null);
    if (!currentStat?.isDirectory() || currentStat.isSymbolicLink()) {
      throw new RepresentativeSnapshotError("representative-snapshot-pack-set-invalid");
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new RepresentativeSnapshotError("representative-snapshot-pack-set-invalid");
      }
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(target, depth + 1);
      } else if (entry.isFile() && entry.name === "manifest.json") {
        manifests.push(target);
      }
      if (manifests.length > maxPackCount) {
        throw new RepresentativeSnapshotError("representative-snapshot-pack-set-invalid");
      }
    }
  }
  await visit(root, 0);
  return manifests.sort((left, right) => left.localeCompare(right, "en"));
}

async function listAssetFiles(root) {
  const files = [];
  async function visit(current) {
    const currentStat = await lstat(current).catch(() => null);
    if (!currentStat?.isDirectory() || currentStat.isSymbolicLink()) {
      throw new RepresentativeSnapshotError("representative-snapshot-asset-root-invalid");
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new RepresentativeSnapshotError("representative-snapshot-asset-root-invalid");
      }
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        files.push(target);
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function startAssetServer(assetRoot) {
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const prefix = "/catalog-assets/";
      if (!url.pathname.startsWith(prefix)) {
        response.writeHead(404).end();
        return;
      }
      const relative = decodeURIComponent(url.pathname.slice(prefix.length));
      const target = path.resolve(assetRoot, ...relative.split("/"));
      const rootRelative = path.relative(path.resolve(assetRoot), target);
      if (!relative || rootRelative.startsWith("..") || path.isAbsolute(rootRelative)) {
        response.writeHead(404).end();
        return;
      }
      const body = await readFile(target);
      response.writeHead(200, { "content-type": contentType(target) });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/catalog-assets`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".webp") return "image/webp";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function requiredDatabase(databases, key) {
  const database = databases.find((candidate) => candidate.key === key);
  if (!database) {
    throw new RepresentativeSnapshotError("representative-snapshot-database-inventory-mismatch");
  }
  return database;
}

function commonPackRoot(packSet) {
  const roots = packSet.map(({ packRoot }) => packRoot);
  const first = roots[0];
  if (roots.every((candidate) => candidate === first)) {
    return first;
  }
  throw new RepresentativeSnapshotError("representative-snapshot-pack-set-invalid");
}

function parseObservationPackManifest(body) {
  try {
    return observationPackManifestV1Schema.parse(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    throw new RepresentativeSnapshotError("representative-snapshot-pack-set-invalid");
  }
}

function parseJson(body, code) {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new RepresentativeSnapshotError(code);
  }
}

function snapshotPrefix(snapshotId) {
  return `representative-snapshots/sets/${snapshotId}`;
}

function objectKeyDirectory(key) {
  const normalized = String(key).replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

function localDatabaseUrl(databaseUrl) {
  const url = new URL(databaseUrl);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new RepresentativeSnapshotError("representative-snapshot-database-target-not-local");
  }
  return url.toString();
}

function withoutSnapshotCredentials(env) {
  const childEnv = { ...env };
  for (const name of snapshotCredentialNames) {
    delete childEnv[name];
  }
  return childEnv;
}

function runProcess(command, args, options) {
  return childProcess(command, args, { ...options, capture: false });
}

function captureProcess(command, args, options) {
  return childProcess(command, args, { ...options, capture: true });
}

function childProcess(command, args, { cwd, env, label, capture }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
    }
    child.once("error", () => reject(new RepresentativeSnapshotError(label)));
    child.once("close", (code) => {
      if (code === 0) {
        resolve(capture ? stdout : undefined);
      } else {
        reject(new RepresentativeSnapshotError(label));
      }
    });
  });
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function requireClosedObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
  }
}

function requireEqual(actual, expected) {
  if (actual !== expected) {
    throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
  }
}

function requireNonEmptyString(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
  }
}

function requireInstant(value) {
  requireNonEmptyString(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
  }
}

function requireSha256(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
  }
}

function requireContentDigest(value) {
  if (typeof value !== "string" || !/^(?:sha256:)?[a-f0-9]{64}$/.test(value)) {
    throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
  }
}

function requirePositiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
  }
}

function requireNonNegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
  }
}

function requireSafeKey(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
  }
}

function requireSafeObjectKey(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
  }
}

function requireExactStringArray(actual, expected) {
  if (!Array.isArray(actual) || stableStringify(actual) !== stableStringify(expected)) {
    throw new RepresentativeSnapshotError("representative-snapshot-manifest-schema-invalid");
  }
}

function writeSafeOutput(output, value) {
  output.write(`${JSON.stringify(value)}\n`);
}
