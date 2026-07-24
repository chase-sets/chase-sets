#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { register } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const CLOSED_COHORT_CATALOG_ITEM_LIMIT = 50;

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runVerifyObservationPackCli(process.argv.slice(2), process.env, process.stdout);
}

export async function runVerifyObservationPackCli(argv, env, output, dependencies = {}) {
  try {
    const options = parseOptions(argv);
    if (options.commerceCohort) {
      const cohort = await (dependencies.verifyCommercePackCohort ?? verifyCommercePackCohort)({
        options,
        env,
        fetch: dependencies.fetch ?? globalThis.fetch,
      });
      writeSafeOutput(output, cohort);
      return cohort.status === "verified" ? 0 : 1;
    }
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
    const commerceCohortRequested = readOption(argv, "--commerce-cohort") === "true";
    if (commerceCohortRequested) {
      writeSafeOutput(output, {
        command: "verify-commerce-pack-cohort",
        status: "blocked",
        numerator: 0,
        denominator: 0,
        percentage: 0,
        minimumPercentage: 90,
        unmatchedSampleCatalogItemIds: [],
        diagnostics: [{ code: "commerce-pack-cohort-verification-failed", severity: "error", category: "replay" }],
      });
      return 1;
    }
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

export async function verifyCommercePackCohort({ options, env, fetch = globalThis.fetch }) {
  if (options.target !== "local" || !options.packDir) {
    throw new Error("Commerce pack-cohort verification requires a local pack source.");
  }
  const catalogDatabaseUrl =
    options.catalogDatabaseUrl ?? env.CATALOG_DATABASE_URL?.trim() ?? env.TEST_CATALOG_DATABASE_URL?.trim();
  const discoveryDatabaseUrl =
    options.discoveryDatabaseUrl ?? env.DISCOVERY_DATABASE_URL?.trim() ?? env.TEST_DISCOVERY_DATABASE_URL?.trim();
  const marketplaceDatabaseUrl =
    options.marketplaceDatabaseUrl ?? env.MARKETPLACE_DATABASE_URL?.trim() ?? env.TEST_MARKETPLACE_DATABASE_URL?.trim();
  if (
    !catalogDatabaseUrl ||
    !discoveryDatabaseUrl ||
    !marketplaceDatabaseUrl ||
    !options.assetBaseUrl ||
    !options.replayReceiptPath ||
    !options.commerceCompletionPath
  ) {
    throw new Error(
      "Commerce pack-cohort verification requires Catalog, Discovery, and Marketplace database URLs, an asset route, a replay receipt, and a commerce completion.",
    );
  }

  const [
    targets,
    { default: pg },
    { getActiveCatalogProviderIntegrationProfileVersion },
    { requireCatalogProviderSourceObservation },
    { resolveWorktreeSandbox },
    { buildRepresentativeAcceptedPackSetIdentity },
  ] = await Promise.all([
    localCohortTargets(options.packDir),
    import("pg"),
    import("../bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.ts"),
    import("../bounded-contexts/catalog/features/source-observations/api/provider-source-observation-normalizer.ts"),
    import("./lib/sandbox.mjs"),
    import("./lib/representative-pack-set-identity.mjs"),
  ]);
  const replayReceipt = parseRepresentativeCatalogReplayReceipt(
    JSON.parse(await readFile(path.resolve(options.replayReceiptPath), "utf8")),
  );
  const commerceCompletion = parseRepresentativeCommerceCompletion(
    JSON.parse(await readFile(path.resolve(options.commerceCompletionPath), "utf8")),
  );
  const acceptedPackReferences = [];
  const acceptedPacks = [];
  const postReplayPacks = [];
  let equalityRowCounts = null;
  for (const target of targets) {
    const verification = await verifyObservationPack({
      storage: target.storage,
      manifestKey: target.manifestKey,
      requireAccepted: true,
      listedRelativePaths: target.listedRelativePaths,
    });
    if (!verification.valid || !verification.replayEligible || !verification.manifest) {
      throw new Error("Commerce pack-cohort verification requires accepted Observation Packs.");
    }
    const manifest = verification.manifest;
    const profileVersion = getActiveCatalogProviderIntegrationProfileVersion(manifest.identity.provider.key, {
      profileKey: manifest.identity.provider.integrationProfileKey,
      ingestionUnitKey: manifest.identity.provider.ingestionUnit,
    });
    if (!profileVersion || profileVersion.profileVersion !== manifest.identity.provider.integrationProfileVersion) {
      throw new Error("Commerce pack-cohort verifier profile compatibility failed.");
    }
    const contract = requireVerifierSourceObservationMappingContract(profileVersion);
    const envelopes = await readVerifiedObservationPackEnvelopes({
      storage: target.storage,
      manifest,
      manifestKey: target.manifestKey,
    });
    const postReplay = await verifyPostReplay({
      target,
      manifest,
      options: {
        catalogDatabaseUrl,
        discoveryDatabaseUrl,
        assetBaseUrl: options.assetBaseUrl,
      },
      env: {},
      fetch,
    });
    if (equalityRowCounts && stableStringify(equalityRowCounts) !== stableStringify(postReplay.perTableRowCounts)) {
      throw new Error("Commerce pack-cohort verification found inconsistent Catalog/Discovery equality evidence.");
    }
    equalityRowCounts ??= postReplay.perTableRowCounts;
    acceptedPacks.push({
      packId: manifest.packId,
      packVersion: manifest.packVersion,
      manifestKey: target.sourceManifestKey,
      captureContentHash: manifest.captureContentHash,
    });
    postReplayPacks.push({
      packId: manifest.packId,
      packVersion: manifest.packVersion,
      manifestKey: target.sourceManifestKey,
      captureContentHash: manifest.captureContentHash,
      providerKey: manifest.identity.provider.key,
      verifierDigest: postReplay.verifierDigest,
      externalReferenceDigest: postReplay.externalReferenceDigest,
      counts: postReplay.counts,
    });
    for (const envelope of envelopes) {
      const prepared = prepareVerifierSourceObservationPayload({
        payload: envelope.payload,
        providerProfile: profileVersion.profile,
      });
      if (prepared.kind !== "payload") {
        throw new Error("Commerce pack-cohort verifier mapping input failed.");
      }
      const observation = requireCatalogProviderSourceObservation({
        contract,
        payload: prepared.payload,
        observedAt: envelope.provenance.fetchedAt,
      });
      if (Array.isArray(observation.normalized.externalCatalogItemReferences)) {
        acceptedPackReferences.push(...observation.normalized.externalCatalogItemReferences);
      }
    }
  }

  const poolOptions = {
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 15_000,
    query_timeout: 20_000,
  };
  const catalog = new pg.Pool({ connectionString: catalogDatabaseUrl, ...poolOptions });
  const discovery = new pg.Pool({ connectionString: discoveryDatabaseUrl, ...poolOptions });
  const marketplace = new pg.Pool({ connectionString: marketplaceDatabaseUrl, ...poolOptions });
  try {
    const databaseIdentity = await readCanonicalRepresentativeDatabaseIdentity({
      env,
      resolveWorktreeSandbox,
      urls: {
        catalog: catalogDatabaseUrl,
        discovery: discoveryDatabaseUrl,
        marketplace: marketplaceDatabaseUrl,
      },
      pools: { catalog, discovery, marketplace },
    });
    const selectedCatalogItemIds = commerceCompletion.selectedCatalogItemIds;
    const [catalogItems, discoverySearchItems, discoveryDetailItems, representativeListings, representativeOffers] =
      await Promise.all([
        catalog.query(
          `SELECT catalog_item_id
           FROM catalog_items
           WHERE catalog_item_id = ANY($1::text[])
           ORDER BY catalog_item_id`,
          [selectedCatalogItemIds],
        ),
        discovery.query(
          `SELECT catalog_item_id
           FROM discovery_search_catalog_items
           WHERE catalog_item_id = ANY($1::text[])
           ORDER BY catalog_item_id`,
          [selectedCatalogItemIds],
        ),
        discovery.query(
          `SELECT catalog_item_id
           FROM discovery_item_detail_catalog_items
           WHERE catalog_item_id = ANY($1::text[])
           ORDER BY catalog_item_id`,
          [selectedCatalogItemIds],
        ),
        marketplace.query(
          `SELECT catalog_catalog_item_id AS catalog_item_id, COUNT(*)::int AS row_count
           FROM marketplace_listing_pages
           WHERE listing_id LIKE 'lst$_repr$_%' ESCAPE '$'
           GROUP BY catalog_catalog_item_id
           ORDER BY catalog_catalog_item_id`,
        ),
        marketplace.query(
          `SELECT catalog_catalog_item_id AS catalog_item_id, COUNT(*)::int AS row_count
           FROM marketplace_offer_pages
           WHERE offer_id LIKE 'off$_repr$_%' ESCAPE '$'
           GROUP BY catalog_catalog_item_id
           ORDER BY catalog_catalog_item_id`,
        ),
      ]);
    const catalogItemIds = catalogItems.rows.map((row) => row.catalog_item_id);
    const discoverySearchCatalogItemIds = discoverySearchItems.rows.map((row) => row.catalog_item_id);
    const discoveryDetailCatalogItemIds = discoveryDetailItems.rows.map((row) => row.catalog_item_id);
    const listingCatalogItemIds = representativeListings.rows.map((row) => row.catalog_item_id);
    const offerCatalogItemIds = representativeOffers.rows.map((row) => row.catalog_item_id);
    assertRepresentativeCommerceProjectionClosure({
      selectedCatalogItemIds,
      catalogItemIds,
      discoverySearchCatalogItemIds,
      discoveryDetailCatalogItemIds,
      listingCatalogItemIds,
      offerCatalogItemIds,
      listingRowCount: representativeListings.rows.reduce((sum, row) => sum + Number(row.row_count), 0),
      offerRowCount: representativeOffers.rows.reduce((sum, row) => sum + Number(row.row_count), 0),
      expectedListingRowCount: commerceCompletion.representativeListingCount,
      expectedOfferRowCount: commerceCompletion.representativeOfferCount,
    });
    const catalogReferences =
      selectedCatalogItemIds.length === 0
        ? []
        : (
            await catalog.query(
              `SELECT catalog_item_id, provider_key, external_key
               FROM catalog_external_catalog_item_references
               WHERE catalog_item_id = ANY($1::text[])
               ORDER BY catalog_item_id, provider_key, external_key`,
              [selectedCatalogItemIds],
            )
          ).rows.map((row) => ({
            catalogItemId: row.catalog_item_id,
            providerKey: row.provider_key,
            externalKey: row.external_key,
          }));
    const result = buildClosedCommercePackCohortEvidence({
      acceptedPacks,
      canonicalPackSetIdentity: `sha256:${buildRepresentativeAcceptedPackSetIdentity(acceptedPacks)}`,
      replayReceipt,
      postReplayPacks,
      equalityRowCounts: equalityRowCounts ?? [],
      databaseIdentity,
      commerceCompletion,
      catalogReferences,
      acceptedPackReferences,
      minimumPercentage: options.minimumCohortPercentage,
    });
    if (options.priorEvidencePath) {
      const priorEvidence = JSON.parse(await readFile(path.resolve(options.priorEvidencePath), "utf8"));
      assertDayAfterCommerceClosure(priorEvidence, result, replayReceipt);
      return {
        ...result,
        dayAfterControl: {
          status: "verified",
          replayAppendedEventCount: replayReceipt.totals.appendedEventCount,
          replayAppendedAssetSetCount: replayReceipt.totals.appendedAssetSetCount,
          retainedClosedIdentity: result.closedIdentity,
        },
      };
    }
    return {
      ...result,
      ...buildCommercePackCohortEvidence({
        commerceCatalogItemIds: selectedCatalogItemIds,
        catalogReferences,
        acceptedPackReferences,
        minimumPercentage: options.minimumCohortPercentage,
      }),
      dayAfterControl: { status: "not-requested" },
    };
  } finally {
    await Promise.allSettled([catalog.end(), discovery.end(), marketplace.end()]);
  }
}

function requireVerifierSourceObservationMappingContract(profileVersion) {
  const contract = profileVersion.executableMappingContract;
  if (!contract?.sourceObservation) {
    throw new Error("Commerce pack-cohort verifier mapping contract is unavailable.");
  }
  return contract;
}

function prepareVerifierSourceObservationPayload({ payload, providerProfile }) {
  if (providerProfile.connector.kind === "tcgplayer-automation-client") {
    throw new Error("Representative Observation Packs cannot use the TCGplayer commerce connector.");
  }
  if (
    providerProfile.connector.kind === "tcgdex-json" &&
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload.payload &&
    typeof payload.payload === "object" &&
    !Array.isArray(payload.payload)
  ) {
    return { kind: "payload", payload: payload.payload };
  }
  return { kind: "payload", payload };
}

export function buildCommercePackCohortEvidence({
  commerceCatalogItemIds,
  catalogReferences,
  acceptedPackReferences,
  minimumPercentage = 90,
}) {
  const usedIds = [...new Set(commerceCatalogItemIds)].sort(compareCanonicalText);
  const packReferenceKeys = new Set(acceptedPackReferences.map(referenceKey));
  const matchedIds = new Set(
    catalogReferences
      .filter((reference) => packReferenceKeys.has(referenceKey(reference)))
      .map((reference) => reference.catalogItemId),
  );
  const numerator = usedIds.filter((catalogItemId) => matchedIds.has(catalogItemId)).length;
  const denominator = usedIds.length;
  const percentage = denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(2));
  return {
    command: "verify-commerce-pack-cohort",
    status: denominator > 0 && percentage >= minimumPercentage ? "verified" : "blocked",
    numerator,
    denominator,
    percentage,
    minimumPercentage,
    unmatchedSampleCatalogItemIds: usedIds.filter((catalogItemId) => !matchedIds.has(catalogItemId)).slice(0, 10),
  };
}

function referenceKey(reference) {
  return `${reference.providerKey}\u0000${reference.externalKey}`;
}

export function buildClosedCommercePackCohortEvidence({
  acceptedPacks,
  canonicalPackSetIdentity = contentIdentity(acceptedPacks.map(packIdentity)),
  replayReceipt,
  postReplayPacks,
  equalityRowCounts,
  databaseIdentity,
  commerceCompletion,
  catalogReferences,
  acceptedPackReferences,
  minimumPercentage = 90,
}) {
  parseRepresentativeCatalogReplayReceipt(replayReceipt);
  const orderedAcceptedPacks = acceptedPacks.map(packIdentity);
  const replayPacks = replayReceipt.packs.map(packIdentity);
  requireExactValue("ordered accepted replay pack set", replayPacks, orderedAcceptedPacks);
  const packSetIdentity = canonicalPackSetIdentity;
  if (replayReceipt.packSetIdentity !== packSetIdentity) {
    throw new Error("Representative replay receipt pack-set identity mismatch.");
  }

  const replayStateFromPostReplay = postReplayPacks.map((pack) => ({
    ...packIdentity(pack),
    providerKey: pack.providerKey,
    envelopeCount: pack.counts.envelopes,
    observationCount: pack.counts.observations,
    catalogItemCount: pack.counts.catalogItems,
    assetSetCount: pack.counts.productAssetSets,
    externalReferenceDigest: pack.externalReferenceDigest,
  }));
  const replayStateFromReceipt = replayReceipt.packs.map(replayStateIdentityMaterial);
  requireExactValue("replay and post-replay pack state", replayStateFromReceipt, replayStateFromPostReplay);
  if (replayReceipt.replayStateIdentity !== contentIdentity(replayStateFromPostReplay)) {
    throw new Error("Representative replay state identity mismatch.");
  }
  const catalogDatabase = databaseIdentity.databases.find((database) => database.contextName === "catalog");
  requireExactValue("replay receipt canonical sandbox", replayReceipt.sandbox, {
    sandboxId: databaseIdentity.sandboxId,
    postgresPort: databaseIdentity.postgresPort,
    catalogDatabaseName: catalogDatabase?.databaseName,
  });

  validateRepresentativeCommerceCompletion(commerceCompletion);
  requireExactValue("commerce replay receipt binding", commerceCompletion.representativeCatalogReplay, {
    replayRunIdentity: replayReceipt.replayRunIdentity,
    packSetIdentity: replayReceipt.packSetIdentity,
    replayStateIdentity: replayReceipt.replayStateIdentity,
  });
  for (const field of [
    "marketplaceReconciledCatalogItemCount",
    "inventoryReconciledCatalogItemCount",
    "representativeInventoryStockCount",
    "representativeListingCount",
    "representativeOfferCount",
  ]) {
    requireEqualCount(
      `Representative commerce ${field}`,
      commerceCompletion[field],
      commerceCompletion.selectedCatalogItemCount,
    );
  }

  const cohort = buildCommercePackCohortEvidence({
    commerceCatalogItemIds: commerceCompletion.selectedCatalogItemIds,
    catalogReferences,
    acceptedPackReferences,
    minimumPercentage,
  });
  const postReplayEqualityIdentity = contentIdentity({
    packs: postReplayPacks,
    perTableRowCounts: equalityRowCounts,
  });
  const replayReceiptIdentity = contentIdentity(replayReceipt);
  const commerceCompletionIdentity = contentIdentity(commerceCompletion);
  const closedIdentity = contentIdentity({
    packSetIdentity,
    replayStateIdentity: replayReceipt.replayStateIdentity,
    postReplayEqualityIdentity,
    databaseSetIdentity: databaseIdentity.databaseSetIdentity,
    commerceStateIdentity: commerceCompletion.commerceStateIdentity,
    selectedCatalogItemDigest: commerceCompletion.selectedCatalogItemDigest,
    selectedCatalogItemCount: commerceCompletion.selectedCatalogItemCount,
  });
  const closedRunIdentity = contentIdentity({
    closedIdentity,
    replayRunIdentity: replayReceipt.replayRunIdentity,
    commerceBindingIdentity: commerceCompletion.commerceBindingIdentity,
    commerceCompletionIdentity,
  });
  return {
    schemaVersion: "commerce-pack-cohort-closure.evidence/v1",
    ...cohort,
    closedIdentity,
    closedRunIdentity,
    packSetIdentity,
    orderedAcceptedPacks,
    replay: {
      receiptIdentity: replayReceiptIdentity,
      runIdentity: replayReceipt.replayRunIdentity,
      stateIdentity: replayReceipt.replayStateIdentity,
      appendedEventCount: replayReceipt.totals.appendedEventCount,
      appendedAssetSetCount: replayReceipt.totals.appendedAssetSetCount,
    },
    postReplay: {
      equalityIdentity: postReplayEqualityIdentity,
      packVerifierDigests: postReplayPacks.map((pack) => ({
        manifestKey: pack.manifestKey,
        verifierDigest: pack.verifierDigest,
        externalReferenceDigest: pack.externalReferenceDigest,
      })),
    },
    databases: databaseIdentity,
    commerce: {
      completionIdentity: commerceCompletionIdentity,
      stateIdentity: commerceCompletion.commerceStateIdentity,
      bindingIdentity: commerceCompletion.commerceBindingIdentity,
      replayRunIdentity: commerceCompletion.representativeCatalogReplay.replayRunIdentity,
      selectedCatalogItemIds: commerceCompletion.selectedCatalogItemIds,
      selectedCatalogItemDigest: commerceCompletion.selectedCatalogItemDigest,
      selectedCatalogItemCount: commerceCompletion.selectedCatalogItemCount,
    },
    acceptedPackCount: orderedAcceptedPacks.length,
    acceptedPackExternalReferenceCount: new Set(acceptedPackReferences.map(referenceKey)).size,
    diagnostics: [],
  };
}

function parseRepresentativeCatalogReplayReceipt(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== "representative-catalog-replay.receipt/v1" ||
    value.type !== "representative-catalog-replay.complete" ||
    !Array.isArray(value.packs) ||
    value.packs.length === 0 ||
    value.packs.length > 4 ||
    !value.sandbox ||
    typeof value.sandbox !== "object" ||
    Array.isArray(value.sandbox) ||
    !value.totals ||
    typeof value.totals !== "object"
  ) {
    throw new Error("Representative replay receipt is invalid.");
  }
  requireExactObjectKeys("Representative replay receipt", value, [
    "schemaVersion",
    "type",
    "checkedAt",
    "replayRunIdentity",
    "packSetIdentity",
    "replayStateIdentity",
    "sandbox",
    "packs",
    "totals",
  ]);
  requireExactObjectKeys("Representative replay sandbox", value.sandbox, [
    "sandboxId",
    "postgresPort",
    "catalogDatabaseName",
  ]);
  requireExactObjectKeys("Representative replay totals", value.totals, ["appendedEventCount", "appendedAssetSetCount"]);
  for (const pack of value.packs) {
    requireExactObjectKeys("Representative replay pack", pack, [
      "packId",
      "packVersion",
      "manifestKey",
      "captureContentHash",
      "providerKey",
      "envelopeCount",
      "observationCount",
      "catalogItemCount",
      "assetSetCount",
      "appendedEventCount",
      "appendedAssetSetCount",
      "externalReferenceDigest",
    ]);
    requirePackIdentity(pack);
    for (const field of [
      "envelopeCount",
      "observationCount",
      "catalogItemCount",
      "assetSetCount",
      "appendedEventCount",
      "appendedAssetSetCount",
    ]) {
      requireNonNegativeInteger(pack[field], `Representative replay ${field}`);
    }
    requireNonEmptyString(pack.providerKey, "Representative replay provider key");
    requireSha256Identity(pack.externalReferenceDigest, "Representative replay external reference digest");
  }
  requireNonNegativeInteger(value.totals.appendedEventCount, "Representative replay appended event total");
  requireNonNegativeInteger(value.totals.appendedAssetSetCount, "Representative replay appended asset total");
  requireNonEmptyString(value.sandbox.sandboxId, "Representative replay sandbox id");
  requireNonNegativeInteger(value.sandbox.postgresPort, "Representative replay Postgres port");
  if (value.sandbox.postgresPort === 0) {
    throw new Error("Representative replay Postgres port must be positive.");
  }
  requireNonEmptyString(value.sandbox.catalogDatabaseName, "Representative replay Catalog database name");
  requireEqualCount(
    "Representative replay appended event total",
    value.totals.appendedEventCount,
    value.packs.reduce((sum, pack) => sum + pack.appendedEventCount, 0),
  );
  requireEqualCount(
    "Representative replay appended asset total",
    value.totals.appendedAssetSetCount,
    value.packs.reduce((sum, pack) => sum + pack.appendedAssetSetCount, 0),
  );
  const packSetIdentity = contentIdentity(value.packs.map(packIdentity));
  const replayStateIdentity = contentIdentity(value.packs.map(replayStateIdentityMaterial));
  if (value.packSetIdentity !== packSetIdentity || value.replayStateIdentity !== replayStateIdentity) {
    throw new Error("Representative replay receipt identity is invalid.");
  }
  requireNonEmptyString(value.checkedAt, "Representative replay checked-at timestamp");
  const replayRunIdentity = contentIdentity({
    checkedAt: value.checkedAt,
    sandbox: value.sandbox,
    packSetIdentity,
    replayStateIdentity,
    appendDeltas: value.packs.map(({ manifestKey, appendedEventCount, appendedAssetSetCount }) => ({
      manifestKey,
      appendedEventCount,
      appendedAssetSetCount,
    })),
    totals: value.totals,
  });
  if (value.replayRunIdentity !== replayRunIdentity) {
    throw new Error("Representative replay run identity is invalid.");
  }
  return value;
}

function parseRepresentativeCommerceCompletion(value) {
  validateRepresentativeCommerceCompletion(value);
  return value;
}

function validateRepresentativeCommerceCompletion(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== "representative-commerce-state.evidence/v2" ||
    value.type !== "representative-commerce-state.complete" ||
    !Array.isArray(value.dataProfiles) ||
    !Array.isArray(value.selectedCatalogItemIds) ||
    !Array.isArray(value.contexts) ||
    !value.chromeUatSelector ||
    typeof value.chromeUatSelector !== "object" ||
    !value.pendingPaymentSaleSelector ||
    typeof value.pendingPaymentSaleSelector !== "object" ||
    !value.representativeCatalogReplay ||
    typeof value.representativeCatalogReplay !== "object" ||
    Array.isArray(value.representativeCatalogReplay)
  ) {
    throw new Error("Representative commerce completion is invalid.");
  }
  const selectedCatalogItemIds = [...new Set(value.selectedCatalogItemIds)].sort((left, right) =>
    compareCanonicalText(String(left), String(right)),
  );
  if (
    selectedCatalogItemIds.length === 0 ||
    selectedCatalogItemIds.some((catalogItemId) => typeof catalogItemId !== "string" || !catalogItemId) ||
    stableStringify(selectedCatalogItemIds) !== stableStringify(value.selectedCatalogItemIds)
  ) {
    throw new Error("Representative commerce selected Catalog Item set is invalid.");
  }
  requireEqualCount(
    "Representative commerce selected Catalog Item count",
    value.selectedCatalogItemCount,
    selectedCatalogItemIds.length,
  );
  if (value.selectedCatalogItemDigest !== commerceContentIdentity(selectedCatalogItemIds)) {
    throw new Error("Representative commerce selected Catalog Item digest mismatch.");
  }
  for (const field of [
    "catalogItemLimit",
    "sourceCatalogCandidateCount",
    "plannedCatalogCandidateCount",
    "priorityCatalogCandidateCount",
    "marketplaceReconciledCatalogItemCount",
    "inventoryReconciledCatalogItemCount",
    "representativeInventoryStockCount",
    "representativeInventoryStockAccountCount",
    "representativeListingCount",
    "representativeListingAccountCount",
    "representativeOfferCount",
    "representativeOfferBuyerAccountCount",
    "representativeAcceptedOfferCount",
    "representativeAcceptedOfferSkippedCount",
  ]) {
    requireNonNegativeInteger(value[field], `Representative commerce ${field}`);
  }
  requireEqualCount(
    "Representative commerce closed-cohort Catalog Item limit",
    value.catalogItemLimit,
    CLOSED_COHORT_CATALOG_ITEM_LIMIT,
  );
  if (value.plannedCatalogCandidateCount < value.priorityCatalogCandidateCount) {
    throw new Error("Representative commerce planned Catalog candidate count is invalid.");
  }
  requireEqualCount(
    "Representative commerce selected Catalog Item denominator",
    value.selectedCatalogItemCount,
    value.priorityCatalogCandidateCount +
      Math.min(value.catalogItemLimit, value.plannedCatalogCandidateCount - value.priorityCatalogCandidateCount),
  );
  const commerceStateMaterial = {
    environmentName: value.environmentName,
    dataProfiles: value.dataProfiles,
    catalogItemLimit: value.catalogItemLimit,
    sourceCatalogCandidateCount: value.sourceCatalogCandidateCount,
    plannedCatalogCandidateCount: value.plannedCatalogCandidateCount,
    priorityCatalogCandidateCount: value.priorityCatalogCandidateCount,
    selectedCatalogItemIds: value.selectedCatalogItemIds,
    selectedCatalogItemCount: value.selectedCatalogItemCount,
    selectedCatalogItemDigest: value.selectedCatalogItemDigest,
    marketplaceReconciledCatalogItemCount: value.marketplaceReconciledCatalogItemCount,
    inventoryReconciledCatalogItemCount: value.inventoryReconciledCatalogItemCount,
    representativeInventoryStockCount: value.representativeInventoryStockCount,
    representativeInventoryStockAccountCount: value.representativeInventoryStockAccountCount,
    representativeListingCount: value.representativeListingCount,
    representativeListingAccountCount: value.representativeListingAccountCount,
    representativeOfferCount: value.representativeOfferCount,
    representativeOfferBuyerAccountCount: value.representativeOfferBuyerAccountCount,
    representativeAcceptedOfferCount: value.representativeAcceptedOfferCount,
    representativeAcceptedOfferSkippedCount: value.representativeAcceptedOfferSkippedCount,
    representativeOrderingSupplyState: value.representativeOrderingSupplyState,
    representativeDiscoveryMarketState: value.representativeDiscoveryMarketState,
    chromeUatSelector: value.chromeUatSelector,
    pendingPaymentSaleSelector: value.pendingPaymentSaleSelector,
    contexts: value.contexts,
  };
  const expectedStateIdentity = commerceContentIdentity(commerceStateMaterial);
  if (value.commerceStateIdentity !== expectedStateIdentity) {
    throw new Error("Representative commerce state identity mismatch.");
  }
  for (const field of ["replayRunIdentity", "packSetIdentity", "replayStateIdentity"]) {
    requireSha256Identity(value.representativeCatalogReplay[field], `Representative commerce replay ${field}`);
  }
  const expectedBindingIdentity = commerceContentIdentity({
    commerceStateIdentity: expectedStateIdentity,
    representativeCatalogReplay: value.representativeCatalogReplay,
  });
  if (value.commerceBindingIdentity !== expectedBindingIdentity) {
    throw new Error("Representative commerce binding identity mismatch.");
  }
}

async function readCanonicalRepresentativeDatabaseIdentity({ env, resolveWorktreeSandbox, urls, pools }) {
  const observedDatabaseNames = {};
  for (const contextName of ["catalog", "discovery", "marketplace"]) {
    const result = await pools[contextName].query("SELECT current_database() AS database_name");
    observedDatabaseNames[contextName] = result.rows[0]?.database_name;
  }
  return buildCanonicalRepresentativeDatabaseIdentity({
    sandbox: resolveWorktreeSandbox({ rootDir: repositoryRoot, env }),
    urls,
    observedDatabaseNames,
  });
}

export function buildCanonicalRepresentativeDatabaseIdentity({ sandbox, urls, observedDatabaseNames }) {
  const databases = [];
  for (const contextName of ["catalog", "discovery", "marketplace"]) {
    const actual = requireLocalPostgresUrl(urls[contextName]);
    const expected = new URL(sandbox.contextDatabaseUrls[contextName]);
    const expectedDatabaseName = decodeURIComponent(expected.pathname.replace(/^\//u, ""));
    const actualDatabaseName = decodeURIComponent(actual.pathname.replace(/^\//u, ""));
    if (
      actual.port !== expected.port ||
      actualDatabaseName !== expectedDatabaseName ||
      observedDatabaseNames[contextName] !== expectedDatabaseName
    ) {
      throw new Error("Commerce pack-cohort database targets are not the canonical current sandbox set.");
    }
    databases.push({ contextName, databaseName: expectedDatabaseName });
  }
  const identityMaterial = {
    sandboxId: sandbox.id,
    postgresPort: sandbox.ports.postgres,
    databases,
  };
  return {
    ...identityMaterial,
    databaseSetIdentity: contentIdentity(identityMaterial),
  };
}

export function assertDayAfterCommerceClosure(prior, current, replayReceipt) {
  if (!prior || prior.schemaVersion !== "commerce-pack-cohort-closure.evidence/v1" || prior.status !== "verified") {
    throw new Error("Day-after control requires a prior verified closure evidence artifact.");
  }
  const expectedPriorClosedIdentity = contentIdentity({
    packSetIdentity: prior.packSetIdentity,
    replayStateIdentity: prior.replay?.stateIdentity,
    postReplayEqualityIdentity: prior.postReplay?.equalityIdentity,
    databaseSetIdentity: prior.databases?.databaseSetIdentity,
    commerceStateIdentity: prior.commerce?.stateIdentity,
    selectedCatalogItemDigest: prior.commerce?.selectedCatalogItemDigest,
    selectedCatalogItemCount: prior.commerce?.selectedCatalogItemCount,
  });
  const expectedPriorClosedRunIdentity = contentIdentity({
    closedIdentity: expectedPriorClosedIdentity,
    replayRunIdentity: prior.replay?.runIdentity,
    commerceBindingIdentity: prior.commerce?.bindingIdentity,
    commerceCompletionIdentity: prior.commerce?.completionIdentity,
  });
  if (
    prior.closedIdentity !== expectedPriorClosedIdentity ||
    prior.closedRunIdentity !== expectedPriorClosedRunIdentity
  ) {
    throw new Error("Day-after control requires internally consistent prior closure evidence.");
  }
  if (replayReceipt.totals.appendedEventCount !== 0 || replayReceipt.totals.appendedAssetSetCount !== 0) {
    throw new Error("Day-after replay appended Catalog events or Product Asset Sets.");
  }
  for (const field of ["closedIdentity", "packSetIdentity"]) {
    if (prior[field] !== current[field]) {
      throw new Error(`Day-after ${field} changed.`);
    }
  }
  if (
    prior.databases?.databaseSetIdentity !== current.databases.databaseSetIdentity ||
    prior.postReplay?.equalityIdentity !== current.postReplay.equalityIdentity ||
    prior.commerce?.stateIdentity !== current.commerce.stateIdentity ||
    prior.commerce?.selectedCatalogItemDigest !== current.commerce.selectedCatalogItemDigest ||
    prior.commerce?.selectedCatalogItemCount !== current.commerce.selectedCatalogItemCount
  ) {
    throw new Error("Day-after closure discriminators changed.");
  }
}

export function assertRepresentativeCommerceProjectionClosure({
  selectedCatalogItemIds,
  catalogItemIds,
  discoverySearchCatalogItemIds,
  discoveryDetailCatalogItemIds,
  listingCatalogItemIds,
  offerCatalogItemIds,
  listingRowCount,
  offerRowCount,
  expectedListingRowCount,
  expectedOfferRowCount,
}) {
  requireExactCatalogItemSet("Catalog", catalogItemIds, selectedCatalogItemIds);
  requireExactCatalogItemSet("Discovery search", discoverySearchCatalogItemIds, selectedCatalogItemIds);
  requireExactCatalogItemSet("Discovery detail", discoveryDetailCatalogItemIds, selectedCatalogItemIds);
  requireExactCatalogItemSet("Marketplace listing", listingCatalogItemIds, selectedCatalogItemIds);
  requireExactCatalogItemSet("Marketplace offer", offerCatalogItemIds, selectedCatalogItemIds);
  requireEqualCount("Marketplace representative listing", listingRowCount, expectedListingRowCount);
  requireEqualCount("Marketplace representative offer", offerRowCount, expectedOfferRowCount);
}

function packIdentity(pack) {
  return {
    packId: pack.packId,
    packVersion: pack.packVersion,
    manifestKey: pack.manifestKey,
    captureContentHash: pack.captureContentHash,
  };
}

function replayStateIdentityMaterial(pack) {
  return {
    ...packIdentity(pack),
    providerKey: pack.providerKey,
    envelopeCount: pack.envelopeCount,
    observationCount: pack.observationCount,
    catalogItemCount: pack.catalogItemCount,
    assetSetCount: pack.assetSetCount,
    externalReferenceDigest: pack.externalReferenceDigest,
  };
}

function requirePackIdentity(pack) {
  requireNonEmptyString(pack.packId, "Observation Pack id");
  requireNonEmptyString(pack.packVersion, "Observation Pack version");
  requireNonEmptyString(pack.manifestKey, "Observation Pack manifest key");
  requireSha256Identity(pack.captureContentHash, "Observation Pack capture content hash");
}

function requireExactCatalogItemSet(label, actual, expected) {
  const normalized = [...new Set(actual)].sort(compareCanonicalText);
  requireExactValue(`${label} Catalog Item set`, normalized, expected);
}

function requireExactValue(label, actual, expected) {
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error(`${label} mismatch.`);
  }
}

function requireExactObjectKeys(label, value, keys) {
  const actualKeys = Object.keys(value).sort(compareCanonicalText);
  const expectedKeys = [...keys].sort(compareCanonicalText);
  requireExactValue(`${label} fields`, actualKeys, expectedKeys);
}

function requireEqualCount(label, actual, expected) {
  if (!Number.isSafeInteger(Number(actual)) || Number(actual) !== Number(expected)) {
    throw new Error(`${label} mismatch.`);
  }
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
}

function requireSha256Identity(value, label) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a SHA-256 identity.`);
  }
}

function contentIdentity(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function commerceContentIdentity(value) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(sortCanonicalIdentityValue(value)))
    .digest("hex")}`;
}

function sortCanonicalIdentityValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortCanonicalIdentityValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareCanonicalText(left, right))
        .map(([key, entry]) => [key, sortCanonicalIdentityValue(entry)]),
    );
  }
  return value;
}

function compareCanonicalText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
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
    sourceManifestKey: candidates[0],
    listedRelativePaths,
  };
}

async function localCohortTargets(packDir) {
  const root = path.resolve(packDir);
  if (!(await stat(root)).isDirectory()) {
    throw new Error("Local commerce pack source must be a directory.");
  }
  const listedRelativePaths = await listFiles(root);
  const manifestPaths = [];
  for (const relativePath of listedRelativePaths) {
    if (path.posix.basename(relativePath).toLowerCase() !== "manifest.json") {
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
        manifestPaths.push(relativePath);
      }
    } catch {
      // Pack verification owns schema diagnostics after structural discovery.
    }
  }
  if (manifestPaths.length === 0 || manifestPaths.length > 4) {
    throw new Error("Local commerce pack source requires one to four Observation Pack manifests.");
  }
  const orderedManifestPaths = manifestPaths.sort(compareCanonicalText);
  const packRoots = [
    ...new Set(orderedManifestPaths.map((manifestPath) => path.dirname(path.join(root, manifestPath)))),
  ];
  if (packRoots.length !== manifestPaths.length) {
    throw new Error("Local commerce pack manifests must have distinct pack roots.");
  }
  return Promise.all(
    orderedManifestPaths.map(async (manifestPath) => ({
      ...(await localTarget(path.dirname(path.join(root, manifestPath)))),
      sourceManifestKey: manifestPath,
    })),
  );
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
    "--marketplace-database-url",
    "--asset-base-url",
    "--commerce-cohort",
    "--minimum-cohort-percentage",
    "--replay-receipt",
    "--commerce-completion",
    "--prior-evidence",
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
  const commerceCohort = readOption(argv, "--commerce-cohort") ?? "false";
  if (commerceCohort !== "true" && commerceCohort !== "false") {
    throw new Error("--commerce-cohort must be true or false.");
  }
  const rawMinimumCohortPercentage = readOption(argv, "--minimum-cohort-percentage") ?? "90";
  const minimumCohortPercentage = Number(rawMinimumCohortPercentage);
  if (!Number.isFinite(minimumCohortPercentage) || minimumCohortPercentage < 0 || minimumCohortPercentage > 100) {
    throw new Error("--minimum-cohort-percentage must be between 0 and 100.");
  }
  return {
    target,
    packDir: readOption(argv, "--pack-dir"),
    manifestKey: readOption(argv, "--manifest-key"),
    requireAccepted: requireAccepted === "true",
    postReplay: postReplay === "true",
    commerceCohort: commerceCohort === "true",
    minimumCohortPercentage,
    catalogDatabaseUrl: readOption(argv, "--catalog-database-url"),
    discoveryDatabaseUrl: readOption(argv, "--discovery-database-url"),
    marketplaceDatabaseUrl: readOption(argv, "--marketplace-database-url"),
    assetBaseUrl: readOption(argv, "--asset-base-url"),
    replayReceiptPath: readOption(argv, "--replay-receipt"),
    commerceCompletionPath: readOption(argv, "--commerce-completion"),
    priorEvidencePath: readOption(argv, "--prior-evidence"),
  };
}

function requireLocalPostgresUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "postgresql:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Commerce pack-cohort database targets must be local PostgreSQL URLs.");
  }
  return url;
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
  for (const entry of entries.sort((left, right) => compareCanonicalText(left.name, right.name))) {
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
