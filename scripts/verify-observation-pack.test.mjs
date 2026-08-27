import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  OBSERVATION_PACK_DECISION_LINK,
  buildObservationPack,
  observationPackEnvelopeContentHash,
  recordObservationPackAcceptance,
  sanitizeObservationPackEnvelope,
  serializeObservationPackManifest,
  stableStringify,
} from "../bounded-contexts/catalog/features/source-observations/api/observation-pack.ts";
import {
  assertDayAfterCommerceClosure,
  assertRepresentativeCommerceProjectionClosure,
  buildCanonicalRepresentativeDatabaseIdentity,
  buildClosedCommercePackCohortEvidence,
  buildCommercePackCohortEvidence,
  buildPostReplayVerifierEvidence,
  runVerifyObservationPackCli,
} from "./verify-observation-pack.mjs";
import { buildRepresentativeCatalogReplayReceipt } from "../bounded-contexts/catalog/features/source-observations/api/representative-catalog-replay.ts";

const temporaryRoots = [];
let stripTypesRuntimeProbe;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeAll(() => {
  const source = `
      import { register } from "node:module";
      register("./infrastructure/platform-runtime/typescript-resolver.mjs", import.meta.url);
      const { SourceObservationIntegrationJobLifecycleCommandError } =
        await import("./bounded-contexts/catalog/features/source-observations/api/runtime.ts");
      const error = new SourceObservationIntegrationJobLifecycleCommandError("unsupported_state", "message");
      await import("./scripts/verify-observation-pack.mjs");
      await import(
        "./bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.ts"
      );
      await import(
        "./bounded-contexts/catalog/features/source-observations/api/provider-source-observation-normalizer.ts"
      );
      await import(
        "./bounded-contexts/catalog/features/source-observations/api/representative-catalog-replay.ts"
      );
      console.log(JSON.stringify({
        name: error.name,
        message: error.message,
        code: error.code,
        ownEnumerableFields: Object.keys(error).sort(),
      }));
    `;
  stripTypesRuntimeProbe = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: path.resolve("."),
    encoding: "utf8",
  });
});

describe("verify-observation-pack real entrypoint", () => {
  it("loads the post-replay runtime graph in a real Node strip-types subprocess", () => {
    const { error, status, stdout, stderr } = stripTypesRuntimeProbe;
    expect(error).toBeUndefined();
    expect(stderr, stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(status, stderr).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({
      name: "SourceObservationIntegrationJobLifecycleCommandError",
      message: "message",
      code: "unsupported_state",
      ownEnumerableFields: ["code", "name"],
    });
  });

  it("joins commerce-used items to accepted-pack external references and reports the exact cohort", () => {
    expect(
      buildCommercePackCohortEvidence({
        commerceCatalogItemIds: ["cat_pack_02", "cat_local", "cat_pack_01", "cat_pack_01"],
        catalogReferences: [
          { catalogItemId: "cat_pack_01", providerKey: "tcgplayer", externalKey: "product:101" },
          { catalogItemId: "cat_pack_02", providerKey: "scryfall", externalKey: "card:202" },
          { catalogItemId: "cat_local", providerKey: "fixture", externalKey: "item:303" },
        ],
        acceptedPackReferences: [
          { providerKey: "tcgplayer", externalKey: "product:101" },
          { providerKey: "scryfall", externalKey: "card:202" },
        ],
        minimumPercentage: 90,
      }),
    ).toEqual({
      command: "verify-commerce-pack-cohort",
      status: "blocked",
      numerator: 2,
      denominator: 3,
      percentage: 66.67,
      minimumPercentage: 90,
      unmatchedSampleCatalogItemIds: ["cat_local"],
    });
  });

  it("closes ordered packs, replay/equality, canonical databases, completion, and selected cohort", () => {
    const fixture = commerceClosureFixture();
    const result = buildClosedCommercePackCohortEvidence(fixture);

    expect(result).toMatchObject({
      status: "verified",
      numerator: 1,
      denominator: 2,
      percentage: 50,
      orderedAcceptedPacks: fixture.acceptedPacks,
      commerce: {
        selectedCatalogItemCount: 2,
        selectedCatalogItemDigest: fixture.commerceCompletion.selectedCatalogItemDigest,
      },
    });
    expect(result.closedIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.replay.receiptIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.postReplay.equalityIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it.each([
    ["reordered", (packs) => packs.reverse()],
    ["omitted", (packs) => packs.slice(0, 1)],
    ["extra", (packs) => [...packs, { ...packs[1], packId: "pack-extra" }]],
    ["narrowed subroot", (packs) => [{ ...packs[0], manifestKey: "manifest.json" }, packs[1]]],
    [
      "same-version content substitution",
      (packs) => [{ ...packs[0], captureContentHash: digest("substituted") }, packs[1]],
    ],
  ])("rejects a %s replay pack set even when the replay receipt identities are recomputed", (_label, mutate) => {
    const fixture = commerceClosureFixture();
    fixture.replayReceipt = buildRepresentativeCatalogReplayReceipt(
      mutate(structuredClone(fixture.replayReceipt.packs)),
      fixture.replayReceipt.checkedAt,
      fixture.replayReceipt.sandbox,
    );

    expect(() => buildClosedCommercePackCohortEvidence(fixture)).toThrow(/pack|replay/i);
  });

  it("rejects a stale or substituted replay receipt that the commerce completion did not consume", () => {
    const fixture = commerceClosureFixture();
    const substitutedReceipt = buildRepresentativeCatalogReplayReceipt(
      fixture.replayReceipt.packs,
      "2026-07-23T12:00:01.000Z",
      fixture.replayReceipt.sandbox,
    );

    expect(() => buildClosedCommercePackCohortEvidence({ ...fixture, replayReceipt: substitutedReceipt })).toThrow(
      /commerce replay receipt binding/i,
    );
  });

  it("rejects unexpected credential or mutable-state fields in a replay receipt", () => {
    const fixture = commerceClosureFixture();
    expect(() =>
      buildClosedCommercePackCohortEvidence({
        ...fixture,
        replayReceipt: { ...fixture.replayReceipt, secretAccessKey: "must-not-be-retained" },
      }),
    ).toThrow(/receipt fields/i);
  });

  it("rejects denominator narrowing even when the narrowed completion identities are recomputed", () => {
    const fixture = commerceClosureFixture();
    const narrowedCompletion = updateCommerceCompletionState(fixture.commerceCompletion, fixture.replayReceipt, {
      catalogItemLimit: 20,
    });

    expect(() => buildClosedCommercePackCohortEvidence({ ...fixture, commerceCompletion: narrowedCompletion })).toThrow(
      /Catalog Item limit|denominator/i,
    );
  });

  it.each([
    ["omitted current-run item", { listingCatalogItemIds: ["cat_pack"] }],
    ["extra current-run item", { offerCatalogItemIds: ["cat_fixture", "cat_pack", "cat_extra"] }],
    ["stale prior representative row", { listingCatalogItemIds: ["cat_fixture", "cat_old", "cat_pack"] }],
    ["duplicate stale representative row", { listingRowCount: 3 }],
  ])("rejects %s before cohort acceptance", (_label, override) => {
    expect(() =>
      assertRepresentativeCommerceProjectionClosure({
        selectedCatalogItemIds: ["cat_fixture", "cat_pack"],
        catalogItemIds: ["cat_fixture", "cat_pack"],
        discoverySearchCatalogItemIds: ["cat_fixture", "cat_pack"],
        discoveryDetailCatalogItemIds: ["cat_fixture", "cat_pack"],
        listingCatalogItemIds: ["cat_fixture", "cat_pack"],
        offerCatalogItemIds: ["cat_fixture", "cat_pack"],
        listingRowCount: 2,
        offerRowCount: 2,
        expectedListingRowCount: 2,
        expectedOfferRowCount: 2,
        ...override,
      }),
    ).toThrow(/mismatch/);
  });

  it("rejects mixed sandbox URLs against the canonical worktree database set", () => {
    const sandbox = canonicalSandboxFixture();
    expect(() =>
      buildCanonicalRepresentativeDatabaseIdentity({
        sandbox,
        urls: {
          catalog: sandbox.contextDatabaseUrls.catalog,
          discovery: sandbox.contextDatabaseUrls.discovery,
          marketplace: "postgresql://postgres:postgres@localhost:6570/cs_lane_02_marketplace",
        },
        observedDatabaseNames: {
          catalog: "cs_lane_01_catalog",
          discovery: "cs_lane_01_discovery",
          marketplace: "cs_lane_02_marketplace",
        },
      }),
    ).toThrow(/canonical current sandbox/);
  });

  it("rejects a replay receipt produced by another sandbox even when commerce consumed it", () => {
    const fixture = commerceClosureFixture();
    const foreignReceipt = buildRepresentativeCatalogReplayReceipt(
      fixture.replayReceipt.packs,
      fixture.replayReceipt.checkedAt,
      {
        sandboxId: "lane-02",
        postgresPort: 6570,
        catalogDatabaseName: "cs_lane_02_catalog",
      },
    );

    expect(() =>
      buildClosedCommercePackCohortEvidence({
        ...fixture,
        replayReceipt: foreignReceipt,
        commerceCompletion: bindCommerceCompletionToReplayReceipt(fixture.commerceCompletion, foreignReceipt),
      }),
    ).toThrow(/canonical sandbox/i);
  });

  it("accepts only a zero-append retained-state replay with the same closed commerce identity", () => {
    const fixture = commerceClosureFixture();
    const prior = buildClosedCommercePackCohortEvidence(fixture);
    const dayAfterReceipt = buildRepresentativeCatalogReplayReceipt(
      fixture.replayReceipt.packs.map((pack) => ({
        ...pack,
        appendedEventCount: 0,
        appendedAssetSetCount: 0,
      })),
      "2026-07-24T12:00:00.000Z",
      fixture.replayReceipt.sandbox,
    );
    const current = buildClosedCommercePackCohortEvidence({
      ...fixture,
      replayReceipt: dayAfterReceipt,
      commerceCompletion: bindCommerceCompletionToReplayReceipt(fixture.commerceCompletion, dayAfterReceipt),
    });

    expect(() => assertDayAfterCommerceClosure(prior, current, dayAfterReceipt)).not.toThrow();
    expect(() =>
      assertDayAfterCommerceClosure(prior, current, {
        ...dayAfterReceipt,
        totals: { appendedEventCount: 1, appendedAssetSetCount: 0 },
      }),
    ).toThrow(/appended/);
    expect(() =>
      assertDayAfterCommerceClosure(prior, { ...current, closedIdentity: digest("changed") }, dayAfterReceipt),
    ).toThrow(/closedIdentity/);
    const nonconvergentCurrent = buildClosedCommercePackCohortEvidence({
      ...fixture,
      replayReceipt: dayAfterReceipt,
      commerceCompletion: updateCommerceCompletionState(fixture.commerceCompletion, dayAfterReceipt, {
        representativeAcceptedOfferSkippedCount: 1,
      }),
    });
    expect(() => assertDayAfterCommerceClosure(prior, nonconvergentCurrent, dayAfterReceipt)).toThrow(
      /closedIdentity|discriminators/,
    );
  });

  it("runs the commerce cohort mode through the existing verifier command", async () => {
    let stdout = "";
    const exitCode = await runVerifyObservationPackCli(
      [
        "--target",
        "local",
        "--pack-dir",
        "ignored-by-injected-check",
        "--commerce-cohort",
        "true",
        "--catalog-database-url",
        "postgresql://localhost/catalog",
        "--marketplace-database-url",
        "postgresql://localhost/marketplace",
      ],
      process.env,
      { write: (value) => void (stdout += value) },
      {
        verifyCommercePackCohort: async () => ({
          command: "verify-commerce-pack-cohort",
          status: "verified",
          numerator: 18,
          denominator: 20,
          percentage: 90,
          minimumPercentage: 90,
          unmatchedSampleCatalogItemIds: ["cat_fixture_01", "cat_fixture_02"],
          acceptedPackCount: 4,
          acceptedPackExternalReferenceCount: 18,
          diagnostics: [],
        }),
      },
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      status: "verified",
      numerator: 18,
      denominator: 20,
      percentage: 90,
      unmatchedSampleCatalogItemIds: ["cat_fixture_01", "cat_fixture_02"],
    });
  });

  it("binds Catalog and Discovery per-table row counts into the equality digest", () => {
    const input = {
      externalReferenceDigest: "a".repeat(64),
      counts: { catalogItems: 1, storedAssetUrls: 7 },
      perTableRowCounts: [
        { table: "catalog.public.catalog_items", rowCount: "1" },
        { table: "discovery.public.discovery_search_catalog_items", rowCount: "1" },
      ],
    };
    const original = buildPostReplayVerifierEvidence(input);
    const changed = buildPostReplayVerifierEvidence({
      ...input,
      perTableRowCounts: input.perTableRowCounts.map((row) =>
        row.table.includes("discovery") ? { ...row, rowCount: "2" } : row,
      ),
    });

    expect(original.verifierDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(changed.verifierDigest).not.toBe(original.verifierDigest);
  });

  it("keeps command failures on a bounded support-safe classification", async () => {
    const source = await readFile(path.resolve("scripts/catalog-observation-pack-capture.ts"), "utf8");
    expect(source).toContain('classification: "observation-pack-command-failed"');
    expect(source).not.toMatch(/error\.message|String\(error\)|response\.text\(/);
  });

  it("passes a valid captured pack and blocks it only when accepted posture is required", async () => {
    const packDir = await writeBundle(validBundle());

    expect(await runVerifier(packDir, false)).toMatchObject({
      exitCode: 0,
      output: { status: "verified", posture: "captured", replayEligible: false, diagnostics: [] },
    });
    expect(await runVerifier(packDir, true)).toMatchObject({
      exitCode: 1,
      output: {
        status: "blocked",
        posture: "captured",
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: "captured-not-accepted" })]),
      },
    });
  });

  it("passes an accepted pack through the same entrypoint", async () => {
    const bundle = validBundle();
    const packDir = await writeBundle(bundle);
    const accepted = recordObservationPackAcceptance(bundle.manifest, {
      acceptedBy: "Todd",
      acceptedAt: "2026-07-22T18:30:00-05:00",
      decisionLink: OBSERVATION_PACK_DECISION_LINK,
    });
    await writeFile(path.join(packDir, "manifest.json"), serializeObservationPackManifest(accepted));

    expect(await runVerifier(packDir, true)).toMatchObject({
      exitCode: 0,
      output: { status: "verified", posture: "accepted", replayEligible: true, diagnostics: [] },
    });
  });

  it("runs bounded post-replay verification only after contract verification succeeds", async () => {
    const bundle = validBundle();
    const packDir = await writeBundle(bundle);
    const accepted = recordObservationPackAcceptance(bundle.manifest, {
      acceptedBy: "Todd",
      acceptedAt: "2026-07-22T18:30:00-05:00",
      decisionLink: OBSERVATION_PACK_DECISION_LINK,
    });
    await writeFile(path.join(packDir, "manifest.json"), serializeObservationPackManifest(accepted));
    const verifyPostReplay = vi.fn(async () => ({
      externalReferenceDigest: `sha256:${"a".repeat(64)}`,
      counts: {
        envelopes: 1,
        observations: 1,
        catalogItems: 1,
        productAssetSets: 1,
        storedAssetUrls: 7,
        discoverySearchItems: 1,
        discoveryItemDetails: 1,
      },
      assetRoute: { checked: 7, http200: 7 },
    }));

    const result = await runVerifier(packDir, true, {
      args: [
        "--post-replay",
        "true",
        "--catalog-database-url",
        "postgresql://catalog.invalid/catalog",
        "--discovery-database-url",
        "postgresql://discovery.invalid/discovery",
        "--asset-base-url",
        "http://127.0.0.1:4173/catalog-assets",
      ],
      dependencies: { verifyPostReplay },
    });

    expect(result).toMatchObject({
      exitCode: 0,
      output: {
        status: "verified",
        postReplay: {
          externalReferenceDigest: `sha256:${"a".repeat(64)}`,
          counts: { catalogItems: 1, storedAssetUrls: 7 },
          assetRoute: { checked: 7, http200: 7 },
        },
      },
    });
    expect(verifyPostReplay).toHaveBeenCalledOnce();
  });

  it("keeps post-replay failures support-safe even when the provider error contains a secret", async () => {
    const secret = "provider-secret-value";
    const packDir = await writeBundle(validBundle());
    const result = await runVerifier(packDir, false, {
      args: ["--post-replay", "true"],
      dependencies: {
        verifyPostReplay: async () => {
          throw new Error(`credential=${secret}`);
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.output.diagnostics).toEqual([
      { code: "post-replay-verification-failed", severity: "error", category: "replay" },
    ]);
    expect(JSON.stringify(result.output)).not.toContain(secret);
  });

  it("fails closed on a tampered payload chunk", async () => {
    const bundle = validBundle();
    const packDir = await writeBundle(bundle);
    const payloadPath = bundle.manifest.entries[0].path;
    const payload = await readFile(path.join(packDir, ...payloadPath.split("/")));
    await writeFile(path.join(packDir, ...payloadPath.split("/")), Buffer.concat([payload, Buffer.from(" ")]));

    expect((await runVerifier(packDir)).output.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "payload-hash-mismatch" })]),
    );
  });

  it("fails closed on a structurally planted pricing field at an arbitrary path", async () => {
    const packDir = await writeBundle(validBundle({ includePricingField: true }));
    const result = await runVerifier(packDir);

    expect(result.exitCode).toBe(1);
    expect(result.output.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "pricing-field-present" })]),
    );
  });

  it("fails closed when a manifest-referenced asset is missing", async () => {
    const bundle = validBundle();
    const packDir = await writeBundle(bundle);
    await unlink(path.join(packDir, ...bundle.manifest.assets[0].path.split("/")));

    expect((await runVerifier(packDir)).output.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "missing-asset" })]),
    );
  });

  it("does not accept a nonempty directory or an unreferenced substitution for a missing canonical payload", async () => {
    const bundle = validBundle();
    const packDir = await writeBundle(bundle);
    const payloadPath = bundle.manifest.entries[0].path;
    const canonicalPath = path.join(packDir, ...payloadPath.split("/"));
    const substitutionPath = path.join(packDir, "unrelated", "replacement.json");
    await mkdir(path.dirname(substitutionPath), { recursive: true });
    await writeFile(substitutionPath, await readFile(canonicalPath));
    await unlink(canonicalPath);

    expect((await runVerifier(packDir)).output.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-payload" }),
        expect.objectContaining({ code: "unreferenced-file" }),
      ]),
    );
  });

  it.each([
    ["nested unknown key", (manifest) => void (manifest.identity.provider.unexpected = true)],
    ["nested wrong type", (manifest) => void (manifest.counts.assets = "1")],
    ["date-only instant", (manifest) => void (manifest.capturedAt = "2026-07-22")],
    ["out-of-range count", (manifest) => void (manifest.counts.envelopes = 1_000_001)],
  ])("rejects malformed manifest schema: %s", async (_label, mutate) => {
    const bundle = validBundle();
    const packDir = await writeBundle(bundle);
    const manifest = structuredClone(bundle.manifest);
    mutate(manifest);
    await writeFile(path.join(packDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);

    expect((await runVerifier(packDir)).output.diagnostics).toEqual([
      expect.objectContaining({ code: "manifest-schema-invalid" }),
    ]);
  });

  it("rejects unsupported retained manifest versions deterministically", async () => {
    const bundle = validBundle();
    const packDir = await writeBundle(bundle);
    const manifest = { ...bundle.manifest, schemaVersion: "observation-pack-manifest-v2" };
    await writeFile(path.join(packDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);

    expect((await runVerifier(packDir)).output.diagnostics).toEqual([
      expect.objectContaining({ code: "unsupported-schema-version" }),
    ]);
  });

  it("rejects hash and count mismatches", async () => {
    const bundle = validBundle();
    const packDir = await writeBundle(bundle);
    const manifest = structuredClone(bundle.manifest);
    manifest.counts.envelopes += 1;
    await writeFile(path.join(packDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);

    expect((await runVerifier(packDir)).output.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "capture-content-hash-mismatch" }),
        expect.objectContaining({ code: "count-mismatch" }),
      ]),
    );
  });

  it.each([
    ["date-only", "2026-07-22", "manifest-schema-invalid"],
    ["before capture", "2026-07-21T23:59:59Z", "lifecycle-invalid"],
    ["future", "2099-01-01T00:00:00Z", "lifecycle-invalid"],
  ])("rejects invalid acceptance timestamp: %s", async (_label, acceptedAt, diagnosticCode) => {
    const bundle = validBundle();
    const packDir = await writeBundle(bundle);
    const manifest = structuredClone(bundle.manifest);
    manifest.governance.lifecycle = {
      state: "accepted",
      acceptance: { acceptedBy: "Todd", acceptedAt, decisionLink: OBSERVATION_PACK_DECISION_LINK },
    };
    manifest.governance.fixtureRecord.validationStatus = "valid";
    await writeFile(path.join(packDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);

    expect((await runVerifier(packDir, true)).output.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: diagnosticCode })]),
    );
  });

  it("rejects duplicate references and extra files", async () => {
    const bundle = validBundle();
    const packDir = await writeBundle(bundle);
    const manifest = structuredClone(bundle.manifest);
    manifest.assets[0].path = manifest.entries[0].path;
    await writeFile(path.join(packDir, "manifest.json"), `${JSON.stringify(manifest)}\n`);
    await writeFile(path.join(packDir, "extra-provider-shaped.json"), "{}\n");

    expect((await runVerifier(packDir)).output.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "duplicate-reference" }),
        expect.objectContaining({ code: "unreferenced-file" }),
      ]),
    );
  });
});

function commerceClosureFixture() {
  const acceptedPacks = [
    {
      packId: "pack-a",
      packVersion: "2026-07-23.1",
      manifestKey: "pokemon/manifest.json",
      captureContentHash: digest("capture-a"),
    },
    {
      packId: "pack-b",
      packVersion: "2026-07-23.1",
      manifestKey: "magic/manifest.json",
      captureContentHash: digest("capture-b"),
    },
  ];
  const replayPacks = acceptedPacks.map((pack, index) => ({
    ...pack,
    providerKey: index === 0 ? "tcgdex" : "scryfall",
    envelopeCount: 1,
    observationCount: 1,
    catalogItemCount: 1,
    assetSetCount: 1,
    appendedEventCount: 10,
    appendedAssetSetCount: 1,
    externalReferenceDigest: digest(`references-${index}`),
  }));
  const replayReceipt = buildRepresentativeCatalogReplayReceipt(replayPacks, "2026-07-23T12:00:00.000Z", {
    sandboxId: "lane-01",
    postgresPort: 6520,
    catalogDatabaseName: "cs_lane_01_catalog",
  });
  const selectedCatalogItemIds = ["cat_fixture", "cat_pack"];
  const selectedCatalogItemDigest = identity(selectedCatalogItemIds);
  const commerceStateMaterial = {
    environmentName: "dev",
    dataProfiles: ["critical-bootstrap", "representative-commerce-state"],
    catalogItemLimit: 50,
    sourceCatalogCandidateCount: 1,
    plannedCatalogCandidateCount: 2,
    priorityCatalogCandidateCount: 0,
    selectedCatalogItemIds,
    selectedCatalogItemCount: 2,
    selectedCatalogItemDigest,
    marketplaceReconciledCatalogItemCount: 2,
    inventoryReconciledCatalogItemCount: 2,
    representativeInventoryStockCount: 2,
    representativeInventoryStockAccountCount: 2,
    representativeListingCount: 2,
    representativeListingAccountCount: 2,
    representativeOfferCount: 2,
    representativeOfferBuyerAccountCount: 2,
    representativeAcceptedOfferCount: 2,
    representativeAcceptedOfferSkippedCount: 0,
    representativeOrderingSupplyState: { listingCount: 2, inventoryItemCount: 2 },
    representativeDiscoveryMarketState: { listingCount: 2, offerCount: 2 },
    chromeUatSelector: {
      schemaVersion: "representative-commerce-state.chrome-uat-selector/v1",
      status: "ready",
    },
    pendingPaymentSaleSelector: {
      schemaVersion: "representative-commerce-state.pending-payment-sale-selector/v1",
      status: "ready",
    },
    contexts: ["catalog", "discovery", "marketplace"],
  };
  const commerceStateIdentity = identity(commerceStateMaterial);
  const representativeCatalogReplay = replayBinding(replayReceipt);
  const commerceBindingIdentity = identity({ commerceStateIdentity, representativeCatalogReplay });
  const databaseMaterial = {
    sandboxId: "lane-01",
    postgresPort: 6520,
    databases: [
      { contextName: "catalog", databaseName: "cs_lane_01_catalog" },
      { contextName: "discovery", databaseName: "cs_lane_01_discovery" },
      { contextName: "marketplace", databaseName: "cs_lane_01_marketplace" },
    ],
  };
  return {
    acceptedPacks,
    replayReceipt,
    postReplayPacks: replayPacks.map((pack) => ({
      ...acceptedPacks.find((accepted) => accepted.packId === pack.packId),
      providerKey: pack.providerKey,
      verifierDigest: digest(`verifier-${pack.packId}`),
      externalReferenceDigest: pack.externalReferenceDigest,
      counts: {
        envelopes: 1,
        observations: 1,
        catalogItems: 1,
        productAssetSets: 1,
        storedAssetUrls: 7,
        discoverySearchItems: 1,
        discoveryItemDetails: 1,
      },
    })),
    equalityRowCounts: [
      { table: "catalog.public.catalog_items", rowCount: "2" },
      { table: "discovery.public.discovery_search_catalog_items", rowCount: "2" },
    ],
    databaseIdentity: {
      ...databaseMaterial,
      databaseSetIdentity: identity(databaseMaterial),
    },
    commerceCompletion: {
      schemaVersion: "representative-commerce-state.evidence/v2",
      type: "representative-commerce-state.complete",
      checkedAt: "2026-07-23T12:01:00.000Z",
      ...commerceStateMaterial,
      commerceStateIdentity,
      commerceBindingIdentity,
      representativeCatalogReplay,
    },
    catalogReferences: [
      { catalogItemId: "cat_pack", providerKey: "tcgdex", externalKey: "card:1" },
      { catalogItemId: "cat_fixture", providerKey: "fixture", externalKey: "item:1" },
    ],
    acceptedPackReferences: [{ providerKey: "tcgdex", externalKey: "card:1" }],
    minimumPercentage: 50,
  };
}

function bindCommerceCompletionToReplayReceipt(completion, replayReceipt) {
  const representativeCatalogReplay = replayBinding(replayReceipt);
  return {
    ...completion,
    representativeCatalogReplay,
    commerceBindingIdentity: identity({
      commerceStateIdentity: completion.commerceStateIdentity,
      representativeCatalogReplay,
    }),
  };
}

function updateCommerceCompletionState(completion, replayReceipt, changes) {
  const {
    schemaVersion,
    type,
    checkedAt,
    commerceStateIdentity: _commerceStateIdentity,
    commerceBindingIdentity: _commerceBindingIdentity,
    representativeCatalogReplay: _representativeCatalogReplay,
    ...currentState
  } = completion;
  const state = { ...currentState, ...changes };
  const commerceStateIdentity = identity(state);
  const representativeCatalogReplay = replayBinding(replayReceipt);
  return {
    schemaVersion,
    type,
    checkedAt,
    ...state,
    commerceStateIdentity,
    commerceBindingIdentity: identity({ commerceStateIdentity, representativeCatalogReplay }),
    representativeCatalogReplay,
  };
}

function replayBinding(replayReceipt) {
  return {
    replayRunIdentity: replayReceipt.replayRunIdentity,
    packSetIdentity: replayReceipt.packSetIdentity,
    replayStateIdentity: replayReceipt.replayStateIdentity,
  };
}

function canonicalSandboxFixture() {
  return {
    id: "lane-01",
    ports: { postgres: 6520 },
    contextDatabaseUrls: {
      catalog: "postgresql://postgres:postgres@localhost:6520/cs_lane_01_catalog",
      discovery: "postgresql://postgres:postgres@localhost:6520/cs_lane_01_discovery",
      marketplace: "postgresql://postgres:postgres@localhost:6520/cs_lane_01_marketplace",
    },
  };
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function identity(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function validBundle(options = {}) {
  const rawEnvelope = {
    unitKey: "provider:product-line:single-card:source-observation-import",
    providerKey: "provider",
    externalKey: "card:1",
    payload: {
      kind: "provider-card",
      name: "Card One",
      imageUrls: ["https://images.example.invalid/card.png"],
      ...(options.includePricingField ? { market_price: "9.99" } : {}),
    },
    provenance: {
      sourceUrl: "https://provider.example.invalid/cards/1",
      fetchedAt: "2026-07-22T18:00:00-05:00",
    },
  };
  const envelope = options.includePricingField ? rawEnvelope : sanitizeObservationPackEnvelope(rawEnvelope);
  const envelopeHash = observationPackEnvelopeContentHash(envelope);
  return buildObservationPack({
    packId: "provider-product-line-set-en",
    packVersion: "v1-20260722T180000Z",
    capturedAt: "2026-07-22T18:00:00-05:00",
    identity: {
      productLineKey: "product-line",
      productLineDisplayName: "Product Line",
      setKind: "set",
      setExternalId: "set-1",
      setDisplayName: "Set One",
      providerKey: "provider",
      integrationProfileKey: "provider-profile",
      integrationProfileVersion: "2026.07.22",
      ingestionUnit: "provider:product-line:single-card:source-observation-import",
      language: "en",
      scopeKey: "set",
      scopeCoordinates: { languageCode: "en", setId: "set-1" },
    },
    envelopes: [envelope],
    assets: [
      {
        bytes: new TextEncoder().encode("image-bytes"),
        mediaType: "image/png",
        sourceReference: "https://images.example.invalid/card.png",
        envelopeContentHashes: [envelopeHash],
      },
    ],
  });
}

async function writeBundle(bundle) {
  const root = await mkdtemp(path.join(tmpdir(), "arbitrary-observation-path-"));
  temporaryRoots.push(root);
  for (const file of bundle.files) {
    const target = path.join(root, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.body);
  }
  return root;
}

async function runVerifier(packDir, requireAccepted = false, options = {}) {
  let stdout = "";
  const exitCode = await runVerifyObservationPackCli(
    [
      "--target",
      "local",
      "--pack-dir",
      packDir,
      "--require-accepted",
      String(requireAccepted),
      ...(options.args ?? []),
    ],
    process.env,
    { write: (value) => void (stdout += value) },
    options.dependencies,
  );
  return { exitCode, output: JSON.parse(stdout.trim()) };
}
