#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

register("./typescript-extension-loader.mjs", import.meta.url);

const [
  { createFilesystemObjectStorage, createS3ObjectStorage },
  { readVerifiedObservationPackEnvelopes, sha256, stableStringify, verifyObservationPack },
  { readBoundedHttpObject },
] = await Promise.all([
  import("../infrastructure/object-storage/index.ts"),
  import("../bounded-contexts/catalog/features/source-observations/api/observation-pack.ts"),
  import("../bounded-contexts/catalog/features/source-observations/api/bounded-http-object.ts"),
]);

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runVerifyObservationPackCli(process.argv.slice(2), process.env, process.stdout);
}

export async function runVerifyObservationPackCli(argv, env, output, dependencies = {}) {
  try {
    const options = parseOptions(argv);
    const target =
      options.target === "local" ? await localTarget(options.packDir) : spaceTarget(options.manifestKey, env);
    const result = await verifyObservationPack({
      storage: target.storage,
      manifestKey: target.manifestKey,
      requireAccepted: options.requireAccepted,
      ...(target.listedRelativePaths ? { listedRelativePaths: target.listedRelativePaths } : {}),
    });
    if (result.valid && options.postReplay) {
      if (!result.manifest) {
        throw new Error("Verified Observation Pack manifest is unavailable.");
      }
      const postReplay = await (dependencies.verifyPostReplay ?? verifyPostReplay)({
        target,
        manifest: result.manifest,
        options,
        env,
        fetch: dependencies.fetch ?? globalThis.fetch,
      });
      writeSafeOutput(output, {
        command: "verify",
        status: "verified",
        posture: result.posture,
        replayEligible: result.replayEligible,
        counts: result.counts,
        diagnostics: [],
        postReplay,
      });
      return 0;
    }
    writeSafeOutput(output, {
      command: "verify",
      status: result.valid ? "verified" : "blocked",
      posture: result.posture,
      replayEligible: result.replayEligible,
      counts: result.counts,
      diagnostics: result.diagnostics.map(({ code, severity, category }) => ({ code, severity, category })),
    });
    return result.valid ? 0 : 1;
  } catch {
    const postReplayRequested = readOption(argv, "--post-replay") === "true";
    writeSafeOutput(output, {
      command: "verify",
      status: "blocked",
      posture: "unknown",
      replayEligible: false,
      counts: { entryChunks: 0, envelopes: 0, assets: 0, payloadBytes: 0, assetBytes: 0 },
      diagnostics: [
        postReplayRequested
          ? { code: "post-replay-verification-failed", severity: "error", category: "replay" }
          : { code: "manifest-schema-invalid", severity: "error", category: "schema" },
      ],
    });
    return 1;
  }
}

export async function verifyPostReplay({ target, manifest, options, env, fetch }) {
  const catalogDatabaseUrl =
    options.catalogDatabaseUrl ?? env.CATALOG_DATABASE_URL?.trim() ?? env.TEST_CATALOG_DATABASE_URL?.trim();
  const discoveryDatabaseUrl =
    options.discoveryDatabaseUrl ?? env.DISCOVERY_DATABASE_URL?.trim() ?? env.TEST_DISCOVERY_DATABASE_URL?.trim();
  if (!catalogDatabaseUrl || !discoveryDatabaseUrl || !options.assetBaseUrl) {
    throw new Error("Post-replay verification requires bounded database and asset route targets.");
  }
  const assetBaseUrl = requireLocalCatalogAssetBaseUrl(options.assetBaseUrl);
  const [
    { default: pg },
    { getActiveCatalogProviderIntegrationProfileVersion },
    { prepareProviderAdapterSourceObservationPayload, requireSourceObservationMappingContract },
    { requireCatalogProviderSourceObservation },
    { representativeCatalogExternalReferenceDigest },
  ] = await Promise.all([
    import("pg"),
    import("../bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.ts"),
    import("../bounded-contexts/catalog/features/source-observations/api/runtime.ts"),
    import("../bounded-contexts/catalog/features/source-observations/api/provider-source-observation-normalizer.ts"),
    import("../bounded-contexts/catalog/features/source-observations/api/representative-catalog-replay.ts"),
  ]);
  const profileVersion = getActiveCatalogProviderIntegrationProfileVersion(manifest.identity.provider.key, {
    profileKey: manifest.identity.provider.integrationProfileKey,
    ingestionUnitKey: manifest.identity.provider.ingestionUnit,
  });
  if (!profileVersion || profileVersion.profileVersion !== manifest.identity.provider.integrationProfileVersion) {
    throw new Error("Post-replay verifier profile compatibility failed.");
  }
  const envelopes = await readVerifiedObservationPackEnvelopes({
    storage: target.storage,
    manifest,
    manifestKey: target.manifestKey,
  });
  const contract = requireSourceObservationMappingContract(profileVersion);
  const observationIds = envelopes.map((envelope) => {
    const prepared = prepareProviderAdapterSourceObservationPayload({
      payload: envelope.payload,
      providerProfile: profileVersion.profile,
    });
    if (prepared.kind !== "payload") {
      throw new Error("Post-replay verifier mapping input failed.");
    }
    return requireCatalogProviderSourceObservation({
      contract,
      payload: prepared.payload,
      observedAt: envelope.provenance.fetchedAt,
    }).observationId;
  });
  const catalog = new pg.Pool({
    connectionString: catalogDatabaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
  });
  const discovery = new pg.Pool({
    connectionString: discoveryDatabaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
  });
  try {
    const observations = await catalog.query(
      `SELECT observation_id, promoted_catalog_item_id
       FROM catalog_source_observations
       WHERE observation_id = ANY($1::text[])
         AND status = 'promoted'
       ORDER BY observation_id`,
      [observationIds],
    );
    if (observations.rows.length !== new Set(observationIds).size) {
      throw new Error("Post-replay Source Observation projection count mismatch.");
    }
    const catalogItemIds = [
      ...new Set(observations.rows.map((row) => row.promoted_catalog_item_id).filter(Boolean)),
    ].sort();
    const items = await catalog.query(
      `SELECT
         item.catalog_item_id,
         item.status,
         item.product_asset_sets,
         COALESCE(
           (
             SELECT jsonb_agg(
               jsonb_build_object(
                 'providerKey', reference.provider_key,
                 'externalKey', reference.external_key
               )
               ORDER BY reference.provider_key, reference.external_key
             )
             FROM catalog_external_catalog_item_references AS reference
             WHERE reference.catalog_item_id = item.catalog_item_id
           ),
           '[]'::jsonb
         ) AS external_references
       FROM catalog_items AS item
       WHERE item.catalog_item_id = ANY($1::text[])
       ORDER BY item.catalog_item_id`,
      [catalogItemIds],
    );
    const evidence = items.rows.map((row) => ({
      catalogItemId: row.catalog_item_id,
      status: row.status,
      externalReferences: Array.isArray(row.external_references) ? row.external_references : [],
      productAssetSets: Array.isArray(row.product_asset_sets) ? row.product_asset_sets : [],
    }));
    if (
      evidence.length !== catalogItemIds.length ||
      evidence.some((item) => item.status !== "active" || item.productAssetSets.length !== 1)
    ) {
      throw new Error("Post-replay Catalog Item or Product Asset Set count mismatch.");
    }
    const [searchProjection, detailProjection] = await Promise.all([
      discovery.query(
        "SELECT COUNT(*)::int AS count FROM discovery_search_catalog_items WHERE catalog_item_id = ANY($1::text[])",
        [catalogItemIds],
      ),
      discovery.query(
        "SELECT COUNT(*)::int AS count FROM discovery_item_detail_catalog_items WHERE catalog_item_id = ANY($1::text[])",
        [catalogItemIds],
      ),
    ]);
    if (
      Number(searchProjection.rows[0]?.count ?? 0) !== catalogItemIds.length ||
      Number(detailProjection.rows[0]?.count ?? 0) !== catalogItemIds.length
    ) {
      throw new Error("Post-replay downstream projection count mismatch.");
    }
    const storedAssetUrls = [
      ...new Set(
        evidence.flatMap((item) =>
          item.productAssetSets.flatMap((assetSet) => [
            assetSet.source?.publicUrl,
            ...(Array.isArray(assetSet.variants) ? assetSet.variants.map((variant) => variant.publicUrl) : []),
          ]),
        ),
      ),
    ].filter((value) => typeof value === "string");
    for (const storedUrl of storedAssetUrls) {
      await verifyCatalogAssetUrl(fetch, assetBaseUrl, storedUrl);
    }
    const counts = {
      envelopes: envelopes.length,
      observations: observationIds.length,
      catalogItems: catalogItemIds.length,
      productAssetSets: evidence.reduce((sum, item) => sum + item.productAssetSets.length, 0),
      storedAssetUrls: storedAssetUrls.length,
      discoverySearchItems: Number(searchProjection.rows[0]?.count ?? 0),
      discoveryItemDetails: Number(detailProjection.rows[0]?.count ?? 0),
    };
    const perTableRowCounts = [
      ...(await readModelTableRowCounts(catalog, "catalog", "catalog_")),
      ...(await readModelTableRowCounts(discovery, "discovery", "discovery_")),
    ].sort((left, right) => left.table.localeCompare(right.table, "en"));
    const externalReferenceDigest = representativeCatalogExternalReferenceDigest(evidence);
    return {
      ...buildPostReplayVerifierEvidence({ externalReferenceDigest, counts, perTableRowCounts }),
      assetRoute: { checked: storedAssetUrls.length, http200: storedAssetUrls.length },
    };
  } finally {
    await Promise.allSettled([catalog.end(), discovery.end()]);
  }
}

export function buildPostReplayVerifierEvidence({ externalReferenceDigest, counts, perTableRowCounts }) {
  return {
    verifierDigest: sha256(
      new TextEncoder().encode(
        stableStringify({
          externalReferenceDigest,
          counts,
          perTableRowCounts,
        }),
      ),
    ),
    externalReferenceDigest,
    counts,
    perTableRowCounts,
  };
}

async function readModelTableRowCounts(pool, databaseKey, tablePrefix) {
  const tables = await pool.query(
    `SELECT schemaname, tablename
     FROM pg_catalog.pg_tables
     WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
       AND tablename LIKE $1
     ORDER BY schemaname, tablename`,
    [`${tablePrefix}%`],
  );
  const counts = [];
  for (const row of tables.rows) {
    const schema = requireSqlIdentifier(row.schemaname);
    const table = requireSqlIdentifier(row.tablename);
    const result = await pool.query(`SELECT COUNT(*)::text AS count FROM "${schema}"."${table}"`);
    counts.push({
      table: `${databaseKey}.${schema}.${table}`,
      rowCount: requireNonNegativeIntegerString(result.rows[0]?.count),
    });
  }
  return counts;
}

function requireSqlIdentifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error("Post-replay verifier encountered an invalid read-model table identifier.");
  }
  return value;
}

function requireNonNegativeIntegerString(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Post-replay verifier encountered an invalid read-model row count.");
  }
  return value;
}

function requireLocalCatalogAssetBaseUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !url.pathname.replace(/\/+$/, "").endsWith("/catalog-assets")
  ) {
    throw new Error("Post-replay asset checks must target the local /catalog-assets route.");
  }
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  url.search = "";
  url.hash = "";
  return url;
}

async function verifyCatalogAssetUrl(fetcher, assetBaseUrl, storedUrl) {
  const parsed = new URL(storedUrl);
  const marker = "/catalog-assets/";
  const markerIndex = parsed.pathname.indexOf(marker);
  if (markerIndex < 0 || parsed.username || parsed.password) {
    throw new Error("Stored Catalog asset URL is not routed through /catalog-assets.");
  }
  const relativePath = parsed.pathname.slice(markerIndex + marker.length);
  const url = new URL(relativePath, assetBaseUrl);
  const object = await readBoundedHttpObject({
    fetch: fetcher,
    url,
    maxBytes: 50 * 1024 * 1024,
    deadlineMs: 15_000,
    accept: "image/*",
  });
  if (object.body.byteLength === 0) {
    throw new Error("Stored Catalog asset route returned an empty body.");
  }
}

async function localTarget(packDir) {
  if (!packDir) {
    throw new Error("Local verification requires --pack-dir.");
  }
  const root = path.resolve(packDir);
  if (!(await stat(root)).isDirectory()) {
    throw new Error("Local verification target must be a directory.");
  }
  const listedRelativePaths = await listFiles(root);
  const candidates = [];
  for (const relativePath of listedRelativePaths) {
    if (!relativePath.toLowerCase().endsWith(".json")) {
      continue;
    }
    const bytes = await readFile(path.join(root, ...relativePath.split("/")));
    if (bytes.byteLength > 10 * 1024 * 1024) {
      continue;
    }
    try {
      const value = JSON.parse(bytes.toString("utf8"));
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof value.schemaVersion === "string" &&
        value.schemaVersion.startsWith("observation-pack-manifest-")
      ) {
        candidates.push(relativePath);
      }
    } catch {
      // Non-manifest JSON is validated only when referenced by the manifest.
    }
  }
  if (candidates.length !== 1) {
    throw new Error("Local verification requires exactly one structurally identified manifest.");
  }
  return {
    storage: createFilesystemObjectStorage({ rootDir: root, publicBaseUrl: "https://local.invalid/private" }),
    manifestKey: candidates[0],
    listedRelativePaths,
  };
}

function spaceTarget(manifestKey, env) {
  if (!manifestKey) {
    throw new Error("Space verification requires --manifest-key.");
  }
  const accessKeyId = requiredEnv(env, "SEED_PACKS_SPACES_ACCESS_ID");
  const secretAccessKey = requiredEnv(env, "SEED_PACKS_SPACES_SECRET_KEY");
  const endpoint = env.SEED_PACKS_SPACES_ENDPOINT?.trim() || "https://nyc3.digitaloceanspaces.com";
  const bucket = env.SEED_PACKS_SPACES_BUCKET?.trim() || "cs-dev-seed-packs";
  const region = env.SEED_PACKS_SPACES_REGION?.trim() || "nyc3";
  return {
    storage: createS3ObjectStorage({
      bucket,
      region,
      endpoint,
      accessKeyId,
      secretAccessKey,
      publicBaseUrl: `${endpoint.replace(/\/$/, "")}/${bucket}`,
    }),
    manifestKey,
  };
}

function parseOptions(argv) {
  const known = [
    "--target",
    "--pack-dir",
    "--manifest-key",
    "--require-accepted",
    "--post-replay",
    "--catalog-database-url",
    "--discovery-database-url",
    "--asset-base-url",
  ];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    const name = argument.split("=", 1)[0] ?? argument;
    if (!known.includes(name)) {
      throw new Error("Verifier received an unsupported option.");
    }
    if (!argument.includes("=")) {
      index += 1;
      if (index >= argv.length || argv[index]?.startsWith("--")) {
        throw new Error("Verifier option is missing its value.");
      }
    }
  }
  const target = readOption(argv, "--target") ?? "local";
  if (target !== "local" && target !== "space") {
    throw new Error("Verifier target must be local or space.");
  }
  const requireAccepted = readOption(argv, "--require-accepted") ?? "false";
  if (requireAccepted !== "true" && requireAccepted !== "false") {
    throw new Error("--require-accepted must be true or false.");
  }
  const postReplay = readOption(argv, "--post-replay") ?? "false";
  if (postReplay !== "true" && postReplay !== "false") {
    throw new Error("--post-replay must be true or false.");
  }
  return {
    target,
    packDir: readOption(argv, "--pack-dir"),
    manifestKey: readOption(argv, "--manifest-key"),
    requireAccepted: requireAccepted === "true",
    postReplay: postReplay === "true",
    catalogDatabaseUrl: readOption(argv, "--catalog-database-url"),
    discoveryDatabaseUrl: readOption(argv, "--discovery-database-url"),
    assetBaseUrl: readOption(argv, "--asset-base-url"),
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

async function listFiles(root, current = "") {
  const directory = path.join(root, ...current.split("/").filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink()) {
      throw new Error("Verifier does not follow symbolic links.");
    }
    const relativePath = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function requiredEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error("Space verification credentials are not configured.");
  }
  return value;
}

function writeSafeOutput(output, value) {
  output.write(`${JSON.stringify(value)}\n`);
}
