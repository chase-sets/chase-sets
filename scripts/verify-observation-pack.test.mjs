import { spawnSync } from "node:child_process";
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
} from "../bounded-contexts/catalog/features/source-observations/api/observation-pack.ts";
import { buildPostReplayVerifierEvidence, runVerifyObservationPackCli } from "./verify-observation-pack.mjs";

const temporaryRoots = [];
let stripTypesRuntimeProbe;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeAll(() => {
  const source = `
      import { register } from "node:module";
      register("./scripts/typescript-extension-loader.mjs", import.meta.url);
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
  stripTypesRuntimeProbe = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", source],
    { cwd: path.resolve("."), encoding: "utf8" },
  );
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
