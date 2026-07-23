import { createHash } from "node:crypto";

import type { JsonValue } from "@chase-sets/primitives/json";
import { z } from "zod";

import {
  evaluateCatalogIntegrationFixtureCoverage,
  type CatalogIntegrationFixtureRepositoryRecord,
} from "./catalog-integration-fixture-lifecycle";
import { sanitizeCatalogIntegrationSampledProviderData } from "./catalog-integration-data-governance";
import type { CatalogIntegrationUnitKey } from "./integration-unit";
import type { ProviderPayloadEnvelope } from "./provider-adapters/provider-adapter";

export const OBSERVATION_PACK_MANIFEST_VERSION = "observation-pack-manifest-v1" as const;
export const OBSERVATION_PACK_CHUNK_VERSION = "observation-pack-envelope-chunk-v1" as const;
export const OBSERVATION_PACK_REPLAY_CONTRACT_VERSION = "source-observation-replay-v1" as const;
export const OBSERVATION_PACK_RETAINED_DATA_EXCEPTION_ISSUE = 5872 as const;
export const OBSERVATION_PACK_DECISION_LINK = "https://github.com/chase-sets/chase-sets/issues/5872" as const;
export const OBSERVATION_PACK_MANIFEST_PATH = "manifest.json" as const;

const MAX_PACK_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const MAX_ENVELOPES = 1_000_000;
const MAX_INDEX_ENTRIES = 10_000;
const MAX_ENVELOPES_PER_CHUNK = 1_000;
const hashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/i);
const relativePathSchema = z.string().min(1).max(512).refine(isSafeRelativePath, "must be a safe relative object path");
const timezoneInstantSchema = z
  .string()
  .max(64)
  .refine(isTimezoneBearingInstant, "must be a valid timezone-bearing instant");
const nonNegativeCountSchema = z.number().int().min(0).max(MAX_ENVELOPES);
const positiveByteCountSchema = z.number().int().min(1).max(MAX_PACK_BYTES);

const scopeCoordinateSchema = z
  .object({
    key: identifierSchema,
    value: z.string().min(1).max(512),
  })
  .strict();

const envelopeReferenceSchema = z
  .object({
    contentHash: hashSchema,
  })
  .strict();

const entryIndexSchema = z
  .object({
    path: relativePathSchema,
    contentHash: hashSchema,
    byteCount: positiveByteCountSchema,
    envelopeCount: z.number().int().min(1).max(MAX_ENVELOPES_PER_CHUNK),
    envelopes: z.array(envelopeReferenceSchema).min(1).max(MAX_ENVELOPES_PER_CHUNK),
  })
  .strict();

const assetIndexSchema = z
  .object({
    path: relativePathSchema,
    contentHash: hashSchema,
    byteCount: z.number().int().min(1).max(MAX_ASSET_BYTES),
    mediaType: z.string().regex(/^image\/[a-z0-9.+-]+$/i),
    sourceReferenceHash: hashSchema,
    envelopeContentHashes: z.array(hashSchema).min(1).max(MAX_ENVELOPES),
  })
  .strict();

const acceptanceSchema = z
  .object({
    acceptedBy: z.string().trim().min(1).max(128),
    acceptedAt: timezoneInstantSchema,
    decisionLink: z.string().url().max(512),
  })
  .strict();

const departureSchema = z
  .object({
    disposition: z.enum(["superseded", "revoked"]),
    recordedBy: z.string().trim().min(1).max(128),
    recordedAt: timezoneInstantSchema,
    decisionLink: z.string().url().max(512),
  })
  .strict();

const deletionSchema = z
  .object({
    deletedBy: z.string().trim().min(1).max(128),
    deletedAt: timezoneInstantSchema,
    decisionLink: z.string().url().max(512),
  })
  .strict();

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const fixtureRecordSchema = z
  .object({
    schemaVersion: z.literal("catalog-fixture-repository-record-v1"),
    fixtureId: z.string().min(1).max(300),
    providerKey: identifierSchema,
    unitKey: z.string().min(1).max(256),
    flow: z.literal("normal"),
    payload: z
      .object({
        kind: z.literal("repository-path"),
        value: relativePathSchema,
      })
      .strict(),
    payloadPolicy: z
      .object({
        dataClass: z.literal("sampled-provider-payload"),
        redactionState: z.literal("redacted"),
        retainsBody: z.literal(true),
        includesProviderImagery: z.literal(true),
      })
      .strict(),
    provenance: z
      .object({
        sourceKind: z.literal("sampled-provider"),
        sampledAt: timezoneInstantSchema,
        sampledByActorKind: z.literal("provider-adapter"),
        sourceUrl: z.null(),
        sourceHash: hashSchema,
        sourceJobId: z.null(),
        operatorUserId: z.null(),
        accountId: z.null(),
        policyLegalSignoff: z.literal(true),
        retainedDataExceptionIssue: z.literal(OBSERVATION_PACK_RETAINED_DATA_EXCEPTION_ISSUE),
      })
      .strict(),
    compatibility: z
      .object({
        providerKey: identifierSchema,
        profileKey: identifierSchema,
        profileVersion: z.string().min(1).max(128),
        fixtureSetVersion: identifierSchema,
        sourceMappingFingerprint: z.union([hashSchema, z.null()]),
      })
      .strict(),
    validationStatus: z.enum(["candidate", "valid", "invalid", "deprecated"]),
  })
  .strict();

export const observationPackManifestV1Schema = z
  .object({
    schemaVersion: z.literal(OBSERVATION_PACK_MANIFEST_VERSION),
    packId: identifierSchema,
    packVersion: identifierSchema,
    capturedAt: timezoneInstantSchema,
    captureContentHash: hashSchema,
    identity: z
      .object({
        productLine: z
          .object({
            key: identifierSchema,
            displayName: z.string().trim().min(1).max(200),
          })
          .strict(),
        set: z
          .object({
            kind: z.enum(["set", "expansion"]),
            externalId: z.string().trim().min(1).max(200),
            displayName: z.string().trim().min(1).max(200),
          })
          .strict(),
        provider: z
          .object({
            key: identifierSchema,
            integrationProfileKey: identifierSchema,
            integrationProfileVersion: z.string().trim().min(1).max(128),
            ingestionUnit: z.string().trim().min(1).max(256),
          })
          .strict(),
        language: z.string().trim().min(2).max(35),
        scope: z
          .object({
            scopeKey: identifierSchema,
            coordinates: z.array(scopeCoordinateSchema).min(1).max(32),
          })
          .strict(),
        replayContractVersion: z.literal(OBSERVATION_PACK_REPLAY_CONTRACT_VERSION),
      })
      .strict(),
    entries: z.array(entryIndexSchema).min(1).max(MAX_INDEX_ENTRIES),
    assets: z.array(assetIndexSchema).min(1).max(MAX_ENVELOPES),
    counts: z
      .object({
        entryChunks: z.number().int().min(1).max(MAX_INDEX_ENTRIES),
        envelopes: z.number().int().min(1).max(MAX_ENVELOPES),
        payloadBytes: positiveByteCountSchema,
        assets: z.number().int().min(1).max(MAX_ENVELOPES),
        assetBytes: positiveByteCountSchema,
      })
      .strict(),
    governance: z
      .object({
        retainedDataException: z
          .object({
            issueNumber: z.literal(OBSERVATION_PACK_RETAINED_DATA_EXCEPTION_ISSUE),
            decisionLink: z.literal(OBSERVATION_PACK_DECISION_LINK),
            owner: z.literal("Todd"),
          })
          .strict(),
        redactionState: z.literal("redacted"),
        pricingAndMarketFields: z.literal("stripped"),
        retention: z
          .object({
            acceptedPackRetention: z.literal("while-accepted"),
            deleteWithinDaysAfterAcceptedDeparture: z.literal(30),
            rotation: z.literal("supersession"),
          })
          .strict(),
        lifecycle: z
          .object({
            state: z.enum(["captured", "accepted", "superseded", "revoked", "deleted"]),
            acceptance: acceptanceSchema.optional(),
            departure: departureSchema.optional(),
            deletion: deletionSchema.optional(),
          })
          .strict(),
        fixtureRecord: fixtureRecordSchema,
      })
      .strict(),
  })
  .strict();

const providerEnvelopeSchema = z
  .object({
    unitKey: z.string().min(1).max(256),
    providerKey: identifierSchema,
    externalKey: z.string().min(1).max(512),
    payload: jsonValueSchema,
    provenance: z
      .object({
        sourceUrl: z.string().url().max(2_048).optional(),
        sourceUpdatedAt: z.string().min(1).max(128).optional(),
        fetchedAt: timezoneInstantSchema,
        contentHash: hashSchema.optional(),
      })
      .strict(),
  })
  .strict();

const observationPackChunkSchema = z
  .object({
    schemaVersion: z.literal(OBSERVATION_PACK_CHUNK_VERSION),
    envelopes: z.array(providerEnvelopeSchema).min(1).max(MAX_ENVELOPES_PER_CHUNK),
  })
  .strict();

export type ObservationPackManifestV1 = z.infer<typeof observationPackManifestV1Schema>;
export type ObservationPackLifecycleState = ObservationPackManifestV1["governance"]["lifecycle"]["state"];
export type ObservationPackEnvelope = z.infer<typeof providerEnvelopeSchema>;

export type ObservationPackAssetInput = Readonly<{
  bytes: Uint8Array;
  mediaType: string;
  sourceReference: string;
  envelopeContentHashes: readonly string[];
}>;

export type ObservationPackIdentityInput = Readonly<{
  productLineKey: string;
  productLineDisplayName: string;
  setKind: "set" | "expansion";
  setExternalId: string;
  setDisplayName: string;
  providerKey: string;
  integrationProfileKey: string;
  integrationProfileVersion: string;
  ingestionUnit: string;
  language: string;
  scopeKey: string;
  scopeCoordinates: Readonly<Record<string, string>>;
}>;

export type ObservationPackFile = Readonly<{
  path: string;
  body: Uint8Array;
  contentType: string;
}>;

export type ObservationPackBundle = Readonly<{
  manifest: ObservationPackManifestV1;
  files: readonly ObservationPackFile[];
}>;

export type ObservationPackObjectStorage = Readonly<{
  putObject(input: {
    key: string;
    body: Uint8Array;
    contentType: string;
    visibility?: "public" | "private";
  }): Promise<unknown>;
  getObject(key: string): Promise<Readonly<{ body: Uint8Array; contentType: string }> | null>;
}>;

export type ObservationPackVerificationDiagnosticCode =
  | "unsupported-schema-version"
  | "manifest-schema-invalid"
  | "manifest-reference-invalid"
  | "capture-content-hash-mismatch"
  | "duplicate-reference"
  | "missing-payload"
  | "missing-asset"
  | "payload-hash-mismatch"
  | "asset-hash-mismatch"
  | "envelope-schema-invalid"
  | "envelope-hash-mismatch"
  | "count-mismatch"
  | "pricing-field-present"
  | "privacy-redaction-invalid"
  | "fixture-lifecycle-invalid"
  | "lifecycle-invalid"
  | "retention-delete-overdue"
  | "captured-not-accepted"
  | "unreferenced-file";

export type ObservationPackVerificationDiagnostic = Readonly<{
  code: ObservationPackVerificationDiagnosticCode;
  severity: "error" | "warning";
  category: "schema" | "integrity" | "privacy" | "governance" | "posture";
}>;

export type ObservationPackVerificationResult = Readonly<{
  valid: boolean;
  posture: ObservationPackLifecycleState | "unknown";
  replayEligible: boolean;
  counts: Readonly<{
    entryChunks: number;
    envelopes: number;
    assets: number;
    payloadBytes: number;
    assetBytes: number;
  }>;
  diagnostics: readonly ObservationPackVerificationDiagnostic[];
  manifest: ObservationPackManifestV1 | null;
}>;

export function sanitizeObservationPackEnvelope(envelope: ProviderPayloadEnvelope): ObservationPackEnvelope {
  const jsonEnvelope = JSON.parse(JSON.stringify(envelope)) as JsonValue;
  const sanitized = sanitizeCatalogIntegrationSampledProviderData(jsonEnvelope);
  return providerEnvelopeSchema.parse(sanitized);
}

export function observationPackEnvelopeContentHash(envelope: ObservationPackEnvelope): string {
  return sha256(utf8(stableStringify(envelope)));
}

export function buildObservationPack(input: {
  packId: string;
  packVersion: string;
  capturedAt: string;
  identity: ObservationPackIdentityInput;
  envelopes: readonly ObservationPackEnvelope[];
  assets: readonly ObservationPackAssetInput[];
  envelopesPerChunk?: number;
}): ObservationPackBundle {
  if (!isTimezoneBearingInstant(input.capturedAt)) {
    throw new Error("Observation Pack capturedAt must be a timezone-bearing instant.");
  }
  if (input.envelopes.length === 0) {
    throw new Error("Observation Pack requires at least one provider envelope.");
  }
  if (input.assets.length === 0) {
    throw new Error("Observation Pack requires at least one source image asset.");
  }

  const envelopesPerChunk = input.envelopesPerChunk ?? 100;
  if (!Number.isInteger(envelopesPerChunk) || envelopesPerChunk < 1 || envelopesPerChunk > MAX_ENVELOPES_PER_CHUNK) {
    throw new Error("Observation Pack envelopesPerChunk is outside the supported bound.");
  }

  const files: ObservationPackFile[] = [];
  const entries: ObservationPackManifestV1["entries"][number][] = [];
  for (let start = 0; start < input.envelopes.length; start += envelopesPerChunk) {
    const envelopes = input.envelopes.slice(start, start + envelopesPerChunk);
    const chunk = { schemaVersion: OBSERVATION_PACK_CHUNK_VERSION, envelopes };
    const body = utf8(`${stableStringify(chunk)}\n`);
    const chunkNumber = entries.length + 1;
    const path = `payloads/chunk-${String(chunkNumber).padStart(5, "0")}.json`;
    files.push({ path, body, contentType: "application/json" });
    entries.push({
      path,
      contentHash: sha256(body),
      byteCount: body.byteLength,
      envelopeCount: envelopes.length,
      envelopes: envelopes.map((envelope) => ({ contentHash: observationPackEnvelopeContentHash(envelope) })),
    });
  }

  const assetsByHash = new Map<
    string,
    { bytes: Uint8Array; mediaType: string; sourceReferences: Set<string>; envelopeContentHashes: Set<string> }
  >();
  for (const asset of input.assets) {
    const contentHash = sha256(asset.bytes);
    const current = assetsByHash.get(contentHash);
    if (current) {
      current.sourceReferences.add(asset.sourceReference);
      asset.envelopeContentHashes.forEach((hash) => current.envelopeContentHashes.add(hash));
      continue;
    }
    assetsByHash.set(contentHash, {
      bytes: asset.bytes,
      mediaType: normalizedImageMediaType(asset.mediaType),
      sourceReferences: new Set([asset.sourceReference]),
      envelopeContentHashes: new Set(asset.envelopeContentHashes),
    });
  }

  const assets: ObservationPackManifestV1["assets"][number][] = [];
  for (const [contentHash, asset] of [...assetsByHash.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const extension = imageExtension(asset.mediaType);
    const path = `assets/${contentHash.slice("sha256:".length)}.${extension}`;
    files.push({ path, body: asset.bytes, contentType: asset.mediaType });
    assets.push({
      path,
      contentHash,
      byteCount: asset.bytes.byteLength,
      mediaType: asset.mediaType,
      sourceReferenceHash: sha256(utf8([...asset.sourceReferences].sort().join("\n"))),
      envelopeContentHashes: [...asset.envelopeContentHashes].sort(),
    });
  }

  const identity: ObservationPackManifestV1["identity"] = {
    productLine: {
      key: input.identity.productLineKey,
      displayName: input.identity.productLineDisplayName,
    },
    set: {
      kind: input.identity.setKind,
      externalId: input.identity.setExternalId,
      displayName: input.identity.setDisplayName,
    },
    provider: {
      key: input.identity.providerKey,
      integrationProfileKey: input.identity.integrationProfileKey,
      integrationProfileVersion: input.identity.integrationProfileVersion,
      ingestionUnit: input.identity.ingestionUnit,
    },
    language: input.identity.language,
    scope: {
      scopeKey: input.identity.scopeKey,
      coordinates: Object.entries(input.identity.scopeCoordinates)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value })),
    },
    replayContractVersion: OBSERVATION_PACK_REPLAY_CONTRACT_VERSION,
  };
  const counts = {
    entryChunks: entries.length,
    envelopes: input.envelopes.length,
    payloadBytes: entries.reduce((sum, entry) => sum + entry.byteCount, 0),
    assets: assets.length,
    assetBytes: assets.reduce((sum, asset) => sum + asset.byteCount, 0),
  };
  const manifestIdentityAndContent = {
    schemaVersion: OBSERVATION_PACK_MANIFEST_VERSION,
    packId: input.packId,
    packVersion: input.packVersion,
    capturedAt: input.capturedAt,
    identity,
    entries,
    assets,
    counts,
  } as const;
  const captureDescriptor = {
    ...manifestIdentityAndContent,
    retainedDataExceptionIssue: OBSERVATION_PACK_RETAINED_DATA_EXCEPTION_ISSUE,
    redactionState: "redacted",
    pricingAndMarketFields: "stripped",
  } as const;
  const captureContentHash = sha256(utf8(stableStringify(captureDescriptor)));
  const fixtureRecord = createObservationPackFixtureRecord({
    packId: input.packId,
    packVersion: input.packVersion,
    capturedAt: input.capturedAt,
    captureContentHash,
    providerKey: input.identity.providerKey,
    unitKey: input.identity.ingestionUnit,
    profileKey: input.identity.integrationProfileKey,
    profileVersion: input.identity.integrationProfileVersion,
  });
  const manifest = observationPackManifestV1Schema.parse({
    ...manifestIdentityAndContent,
    captureContentHash,
    governance: {
      retainedDataException: {
        issueNumber: OBSERVATION_PACK_RETAINED_DATA_EXCEPTION_ISSUE,
        decisionLink: OBSERVATION_PACK_DECISION_LINK,
        owner: "Todd",
      },
      redactionState: "redacted",
      pricingAndMarketFields: "stripped",
      retention: {
        acceptedPackRetention: "while-accepted",
        deleteWithinDaysAfterAcceptedDeparture: 30,
        rotation: "supersession",
      },
      lifecycle: { state: "captured" },
      fixtureRecord,
    },
  });
  const manifestBody = serializeObservationPackManifest(manifest);
  files.push({ path: OBSERVATION_PACK_MANIFEST_PATH, body: manifestBody, contentType: "application/json" });
  return { manifest, files };
}

export function serializeObservationPackManifest(manifest: ObservationPackManifestV1): Uint8Array {
  return utf8(`${stableStringify(observationPackManifestV1Schema.parse(manifest))}\n`);
}

export async function readObservationPackManifest(input: {
  storage: Pick<ObservationPackObjectStorage, "getObject">;
  manifestKey: string;
}): Promise<ObservationPackManifestV1> {
  const manifestObject = await input.storage.getObject(input.manifestKey);
  if (!manifestObject) {
    throw new Error("Observation Pack manifest is missing.");
  }
  const raw = JSON.parse(new TextDecoder().decode(manifestObject.body)) as unknown;
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    (raw as { schemaVersion?: unknown }).schemaVersion !== OBSERVATION_PACK_MANIFEST_VERSION
  ) {
    throw new Error("Observation Pack manifest version is unsupported.");
  }
  return observationPackManifestV1Schema.parse(raw);
}

export function recordObservationPackAcceptance(
  manifest: ObservationPackManifestV1,
  acceptance: z.input<typeof acceptanceSchema>,
): ObservationPackManifestV1 {
  const parsedAcceptance = acceptanceSchema.parse(acceptance);
  const current = observationPackManifestV1Schema.parse(manifest);
  if (new Date(parsedAcceptance.acceptedAt).getTime() < new Date(current.capturedAt).getTime()) {
    throw new Error("Observation Pack acceptance cannot precede capture.");
  }
  if (parsedAcceptance.decisionLink !== OBSERVATION_PACK_DECISION_LINK) {
    throw new Error("Observation Pack acceptance must link the approved #5872 decision.");
  }
  if (current.governance.lifecycle.state === "accepted") {
    if (stableStringify(current.governance.lifecycle.acceptance) === stableStringify(parsedAcceptance)) {
      return current;
    }
    throw new Error("Observation Pack acceptance is immutable once recorded.");
  }
  if (current.governance.lifecycle.state !== "captured") {
    throw new Error("Only a captured Observation Pack can be accepted.");
  }

  return observationPackManifestV1Schema.parse({
    ...current,
    governance: {
      ...current.governance,
      lifecycle: { state: "accepted", acceptance: parsedAcceptance },
      fixtureRecord: { ...current.governance.fixtureRecord, validationStatus: "valid" },
    },
  });
}

export async function writeObservationPack(input: {
  storage: ObservationPackObjectStorage;
  prefix: string;
  bundle: ObservationPackBundle;
}): Promise<Readonly<{ manifestKey: string; objectCount: number; manifestHash: string }>> {
  const prefix = normalizePrefix(input.prefix);
  const manifestFile = input.bundle.files.find((file) => file.path === OBSERVATION_PACK_MANIFEST_PATH);
  if (!manifestFile) {
    throw new Error("Observation Pack bundle is missing its canonical manifest.");
  }
  const contentFiles = input.bundle.files.filter((file) => file.path !== OBSERVATION_PACK_MANIFEST_PATH);
  for (const file of contentFiles) {
    await input.storage.putObject({
      key: joinObjectKey(prefix, file.path),
      body: file.body,
      contentType: file.contentType,
      visibility: "private",
    });
  }
  const manifestKey = joinObjectKey(prefix, OBSERVATION_PACK_MANIFEST_PATH);
  await input.storage.putObject({
    key: manifestKey,
    body: manifestFile.body,
    contentType: manifestFile.contentType,
    visibility: "private",
  });
  return { manifestKey, objectCount: input.bundle.files.length, manifestHash: sha256(manifestFile.body) };
}

export async function writeObservationPackAcceptance(input: {
  storage: ObservationPackObjectStorage;
  manifestKey: string;
  manifest: ObservationPackManifestV1;
}): Promise<Readonly<{ manifestHash: string }>> {
  const body = serializeObservationPackManifest(input.manifest);
  await input.storage.putObject({
    key: input.manifestKey,
    body,
    contentType: "application/json",
    visibility: "private",
  });
  return { manifestHash: sha256(body) };
}

export async function verifyObservationPack(input: {
  storage: Pick<ObservationPackObjectStorage, "getObject">;
  manifestKey: string;
  requireAccepted?: boolean;
  listedRelativePaths?: readonly string[];
  now?: Date;
}): Promise<ObservationPackVerificationResult> {
  const diagnostics: ObservationPackVerificationDiagnostic[] = [];
  const manifestObject = await input.storage.getObject(input.manifestKey);
  if (!manifestObject) {
    return failedResult("manifest-schema-invalid", "schema");
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(new TextDecoder().decode(manifestObject.body));
  } catch {
    return failedResult("manifest-schema-invalid", "schema");
  }
  if (!rawManifest || typeof rawManifest !== "object" || Array.isArray(rawManifest)) {
    return failedResult("manifest-schema-invalid", "schema");
  }
  if ((rawManifest as { schemaVersion?: unknown }).schemaVersion !== OBSERVATION_PACK_MANIFEST_VERSION) {
    return failedResult("unsupported-schema-version", "schema");
  }
  const parsed = observationPackManifestV1Schema.safeParse(rawManifest);
  if (!parsed.success) {
    return failedResult("manifest-schema-invalid", "schema");
  }
  const manifest = parsed.data;
  const prefix = objectKeyDirectory(input.manifestKey);

  const expectedCaptureHash = observationPackCaptureContentHash(manifest);
  if (expectedCaptureHash !== manifest.captureContentHash) {
    addDiagnostic(diagnostics, "capture-content-hash-mismatch", "integrity");
  }
  if (
    manifest.governance.fixtureRecord.payload.value !== objectKeyBasename(input.manifestKey) ||
    manifest.governance.fixtureRecord.provenance.sourceHash !== manifest.captureContentHash
  ) {
    addDiagnostic(diagnostics, "manifest-reference-invalid", "governance");
  }

  const referencedPaths = [
    ...manifest.entries.map((entry) => entry.path),
    ...manifest.assets.map((asset) => asset.path),
  ];
  if (new Set(referencedPaths).size !== referencedPaths.length) {
    addDiagnostic(diagnostics, "duplicate-reference", "integrity");
  }
  if (input.listedRelativePaths) {
    const expected = new Set([objectKeyBasename(input.manifestKey), ...referencedPaths]);
    if (input.listedRelativePaths.some((path) => !expected.has(path))) {
      addDiagnostic(diagnostics, "unreferenced-file", "integrity");
    }
  }

  const knownEnvelopeHashes = new Set<string>();
  let observedEnvelopeCount = 0;
  let observedPayloadBytes = 0;
  for (const entry of manifest.entries) {
    const object = await input.storage.getObject(joinObjectKey(prefix, entry.path));
    if (!object) {
      addDiagnostic(diagnostics, "missing-payload", "integrity");
      continue;
    }
    observedPayloadBytes += object.body.byteLength;
    if (sha256(object.body) !== entry.contentHash || object.body.byteLength !== entry.byteCount) {
      addDiagnostic(diagnostics, "payload-hash-mismatch", "integrity");
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(new TextDecoder().decode(object.body));
    } catch {
      addDiagnostic(diagnostics, "envelope-schema-invalid", "schema");
      continue;
    }
    const parsedChunk = observationPackChunkSchema.safeParse(chunk);
    if (!parsedChunk.success) {
      addDiagnostic(diagnostics, "envelope-schema-invalid", "schema");
      continue;
    }
    observedEnvelopeCount += parsedChunk.data.envelopes.length;
    const actualHashes = parsedChunk.data.envelopes.map((envelope) => observationPackEnvelopeContentHash(envelope));
    actualHashes.forEach((hash) => knownEnvelopeHashes.add(hash));
    if (
      entry.envelopeCount !== parsedChunk.data.envelopes.length ||
      stableStringify(entry.envelopes.map((item) => item.contentHash)) !== stableStringify(actualHashes)
    ) {
      addDiagnostic(diagnostics, "envelope-hash-mismatch", "integrity");
    }
    for (const envelope of parsedChunk.data.envelopes) {
      const scan = scanRetainedValue(envelope);
      if (scan.pricingFieldCount > 0) {
        addDiagnostic(diagnostics, "pricing-field-present", "privacy");
      }
      if (scan.unredactedSensitiveFieldCount > 0 || scan.credentialUrlCount > 0) {
        addDiagnostic(diagnostics, "privacy-redaction-invalid", "privacy");
      }
    }
  }

  let observedAssetBytes = 0;
  let observedAssetCount = 0;
  for (const asset of manifest.assets) {
    const object = await input.storage.getObject(joinObjectKey(prefix, asset.path));
    if (!object) {
      addDiagnostic(diagnostics, "missing-asset", "integrity");
      continue;
    }
    observedAssetCount += 1;
    observedAssetBytes += object.body.byteLength;
    if (sha256(object.body) !== asset.contentHash || object.body.byteLength !== asset.byteCount) {
      addDiagnostic(diagnostics, "asset-hash-mismatch", "integrity");
    }
    if (asset.envelopeContentHashes.some((hash) => !knownEnvelopeHashes.has(hash))) {
      addDiagnostic(diagnostics, "envelope-hash-mismatch", "integrity");
    }
  }

  if (
    manifest.counts.entryChunks !== manifest.entries.length ||
    manifest.counts.envelopes !== observedEnvelopeCount ||
    manifest.counts.payloadBytes !== observedPayloadBytes ||
    manifest.counts.assets !== observedAssetCount ||
    manifest.counts.assetBytes !== observedAssetBytes ||
    manifest.entries.some((entry) => entry.envelopeCount !== entry.envelopes.length)
  ) {
    addDiagnostic(diagnostics, "count-mismatch", "integrity");
  }

  evaluateLifecycle(manifest, diagnostics, input.now ?? new Date());
  const fixtureEvaluation = evaluateCatalogIntegrationFixtureCoverage({
    providerKey: manifest.identity.provider.key,
    profileKey: manifest.identity.provider.integrationProfileKey,
    profileVersion: manifest.identity.provider.integrationProfileVersion,
    unitKey: manifest.identity.provider.ingestionUnit as CatalogIntegrationUnitKey,
    fixtureContract: { fixtureRoot: ".", coveredFlows: ["normal"], liveProviderCallsAllowed: false },
    records: [manifest.governance.fixtureRecord as CatalogIntegrationFixtureRepositoryRecord],
    requiredFlows: ["normal"],
  });
  if (fixtureEvaluation.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    addDiagnostic(diagnostics, "fixture-lifecycle-invalid", "governance");
  }

  const replayEligible = manifest.governance.lifecycle.state === "accepted";
  if (input.requireAccepted && !replayEligible) {
    addDiagnostic(diagnostics, "captured-not-accepted", "posture");
  }
  return {
    valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    posture: manifest.governance.lifecycle.state,
    replayEligible,
    counts: {
      entryChunks: manifest.entries.length,
      envelopes: observedEnvelopeCount,
      assets: observedAssetCount,
      payloadBytes: observedPayloadBytes,
      assetBytes: observedAssetBytes,
    },
    diagnostics,
    manifest,
  };
}

export function observationPackCaptureContentHash(manifest: ObservationPackManifestV1): string {
  return sha256(
    utf8(
      stableStringify({
        schemaVersion: manifest.schemaVersion,
        packId: manifest.packId,
        packVersion: manifest.packVersion,
        capturedAt: manifest.capturedAt,
        identity: manifest.identity,
        entries: manifest.entries,
        assets: manifest.assets,
        counts: manifest.counts,
        retainedDataExceptionIssue: manifest.governance.retainedDataException.issueNumber,
        redactionState: manifest.governance.redactionState,
        pricingAndMarketFields: manifest.governance.pricingAndMarketFields,
      }),
    ),
  );
}

export function extractObservationPackImageReferences(
  envelope: ObservationPackEnvelope,
): readonly Readonly<{ sourceReference: string; envelopeContentHash: string }>[] {
  const urls = new Set<string>();
  collectImageReferences(envelope.payload, [], urls);
  const envelopeContentHash = observationPackEnvelopeContentHash(envelope);
  return [...urls].sort().map((sourceReference) => ({ sourceReference, envelopeContentHash }));
}

export function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function createObservationPackFixtureRecord(input: {
  packId: string;
  packVersion: string;
  capturedAt: string;
  captureContentHash: string;
  providerKey: string;
  unitKey: string;
  profileKey: string;
  profileVersion: string;
}): CatalogIntegrationFixtureRepositoryRecord {
  return {
    schemaVersion: "catalog-fixture-repository-record-v1",
    fixtureId: `${input.packId}:${input.packVersion}`,
    providerKey: input.providerKey,
    unitKey: input.unitKey as CatalogIntegrationUnitKey,
    flow: "normal",
    payload: { kind: "repository-path", value: OBSERVATION_PACK_MANIFEST_PATH },
    payloadPolicy: {
      dataClass: "sampled-provider-payload",
      redactionState: "redacted",
      retainsBody: true,
      includesProviderImagery: true,
    },
    provenance: {
      sourceKind: "sampled-provider",
      sampledAt: input.capturedAt,
      sampledByActorKind: "provider-adapter",
      sourceUrl: null,
      sourceHash: input.captureContentHash,
      sourceJobId: null,
      operatorUserId: null,
      accountId: null,
      policyLegalSignoff: true,
      retainedDataExceptionIssue: OBSERVATION_PACK_RETAINED_DATA_EXCEPTION_ISSUE,
    },
    compatibility: {
      providerKey: input.providerKey,
      profileKey: input.profileKey,
      profileVersion: input.profileVersion,
      fixtureSetVersion: input.packVersion,
      sourceMappingFingerprint: null,
    },
    validationStatus: "candidate",
  };
}

function evaluateLifecycle(
  manifest: ObservationPackManifestV1,
  diagnostics: ObservationPackVerificationDiagnostic[],
  now: Date,
): void {
  const lifecycle = manifest.governance.lifecycle;
  const acceptance = lifecycle.acceptance;
  const departure = lifecycle.departure;
  const deletion = lifecycle.deletion;
  const capturedAt = new Date(manifest.capturedAt).getTime();
  if (capturedAt > now.getTime() + 5 * 60_000) {
    addDiagnostic(diagnostics, "lifecycle-invalid", "governance");
  }
  const acceptedAt = acceptance ? new Date(acceptance.acceptedAt).getTime() : null;
  const departedAt = departure ? new Date(departure.recordedAt).getTime() : null;
  const deletedAt = deletion ? new Date(deletion.deletedAt).getTime() : null;
  if (
    (acceptedAt !== null && acceptedAt > now.getTime() + 5 * 60_000) ||
    (departedAt !== null && departedAt > now.getTime() + 5 * 60_000) ||
    (deletedAt !== null && deletedAt > now.getTime() + 5 * 60_000) ||
    (acceptance && acceptance.decisionLink !== OBSERVATION_PACK_DECISION_LINK)
  ) {
    addDiagnostic(diagnostics, "lifecycle-invalid", "governance");
  }
  if (acceptedAt !== null && acceptedAt < capturedAt) {
    addDiagnostic(diagnostics, "lifecycle-invalid", "governance");
  }
  if (departedAt !== null && (acceptedAt === null || departedAt < acceptedAt)) {
    addDiagnostic(diagnostics, "lifecycle-invalid", "governance");
  }
  if (
    deletedAt !== null &&
    (departedAt === null || deletedAt < departedAt || deletedAt > departedAt + 30 * 86_400_000)
  ) {
    addDiagnostic(diagnostics, "lifecycle-invalid", "governance");
  }
  if (departure && departure.disposition !== lifecycle.state && lifecycle.state !== "deleted") {
    addDiagnostic(diagnostics, "lifecycle-invalid", "governance");
  }
  const shapeIsValid =
    (lifecycle.state === "captured" && !acceptance && !departure && !deletion) ||
    (lifecycle.state === "accepted" && Boolean(acceptance) && !departure && !deletion) ||
    ((lifecycle.state === "superseded" || lifecycle.state === "revoked") &&
      Boolean(acceptance) &&
      Boolean(departure) &&
      !deletion) ||
    (lifecycle.state === "deleted" && Boolean(acceptance) && Boolean(departure) && Boolean(deletion));
  if (!shapeIsValid) {
    addDiagnostic(diagnostics, "lifecycle-invalid", "governance");
  }
  if (departure && !deletion && now.getTime() > new Date(departure.recordedAt).getTime() + 30 * 86_400_000) {
    addDiagnostic(diagnostics, "retention-delete-overdue", "governance");
  }
  const expectedFixtureStatus =
    lifecycle.state === "captured" ? "candidate" : lifecycle.state === "accepted" ? "valid" : null;
  if (expectedFixtureStatus && manifest.governance.fixtureRecord.validationStatus !== expectedFixtureStatus) {
    addDiagnostic(diagnostics, "lifecycle-invalid", "governance");
  }
}

function scanRetainedValue(value: unknown): Readonly<{
  pricingFieldCount: number;
  unredactedSensitiveFieldCount: number;
  credentialUrlCount: number;
}> {
  let pricingFieldCount = 0;
  let unredactedSensitiveFieldCount = 0;
  let credentialUrlCount = 0;
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== "object") {
      if (typeof current === "string" && urlContainsCredential(current)) {
        credentialUrlCount += 1;
      }
      return;
    }
    for (const [key, entry] of Object.entries(current)) {
      if (isPricingOrMarketKey(key)) {
        pricingFieldCount += 1;
      }
      if (isSensitiveKey(key) && entry !== "<redacted>") {
        unredactedSensitiveFieldCount += 1;
      }
      visit(entry);
    }
  };
  visit(value);
  return { pricingFieldCount, unredactedSensitiveFieldCount, credentialUrlCount };
}

function collectImageReferences(value: unknown, path: readonly string[], urls: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectImageReferences(entry, [...path, String(index)], urls));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, entry]) => collectImageReferences(entry, [...path, key], urls));
    return;
  }
  if (typeof value !== "string" || !path.some((segment) => /image/i.test(segment))) {
    return;
  }
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !urlContainsCredential(value)) {
      urls.add(value);
    }
  } catch {
    // Non-URL provider image labels are not asset references.
  }
}

function isPricingOrMarketKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return ["price", "marketprice", "inventory", "quantity", "listing"].some((pattern) => normalized.includes(pattern));
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return [
    "authorization",
    "cookie",
    "token",
    "secret",
    "password",
    "sellerid",
    "sellerkey",
    "sellername",
    "selleremail",
    "email",
    "phone",
  ].some((pattern) => normalized.includes(pattern));
}

function urlContainsCredential(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) {
    return false;
  }
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      return true;
    }
    return [...url.searchParams.keys()].some((key) => isSensitiveKey(key));
  } catch {
    return true;
  }
}

function addDiagnostic(
  diagnostics: ObservationPackVerificationDiagnostic[],
  code: ObservationPackVerificationDiagnosticCode,
  category: ObservationPackVerificationDiagnostic["category"],
): void {
  if (!diagnostics.some((diagnostic) => diagnostic.code === code)) {
    diagnostics.push({ code, severity: "error", category });
  }
}

function failedResult(
  code: ObservationPackVerificationDiagnosticCode,
  category: ObservationPackVerificationDiagnostic["category"],
): ObservationPackVerificationResult {
  return {
    valid: false,
    posture: "unknown",
    replayEligible: false,
    counts: { entryChunks: 0, envelopes: 0, assets: 0, payloadBytes: 0, assetBytes: 0 },
    diagnostics: [{ code, severity: "error", category }],
    manifest: null,
  };
}

function isTimezoneBearingInstant(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return Number.isFinite(new Date(value).getTime());
}

function isSafeRelativePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  return (
    normalized === value &&
    !normalized.startsWith("/") &&
    !/^[a-z]:/i.test(normalized) &&
    normalized.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function normalizePrefix(prefix: string): string {
  const normalized = prefix.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || !isSafeRelativePath(normalized)) {
    throw new Error("Observation Pack storage prefix must be a safe relative path.");
  }
  return normalized;
}

function joinObjectKey(prefix: string, relativePath: string): string {
  const normalizedPath = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!isSafeRelativePath(normalizedPath)) {
    throw new Error("Observation Pack object path must be a safe relative path.");
  }
  return prefix ? `${prefix.replace(/\/+$/, "")}/${normalizedPath}` : normalizedPath;
}

function objectKeyDirectory(key: string): string {
  const normalized = key.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

function objectKeyBasename(key: string): string {
  return key.replaceAll("\\", "/").split("/").at(-1) ?? key;
}

function normalizedImageMediaType(value: string): string {
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!/^image\/[a-z0-9.+-]+$/.test(mediaType)) {
    throw new Error("Observation Pack asset response must use an image media type.");
  }
  return mediaType;
}

function imageExtension(mediaType: string): string {
  switch (mediaType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/avif":
      return "avif";
    default:
      return "img";
  }
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJsonValue(entry)]),
    );
  }
  return value;
}
