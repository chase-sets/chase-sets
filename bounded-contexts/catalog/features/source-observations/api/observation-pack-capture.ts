import {
  buildObservationPack,
  extractObservationPackImageReferences,
  sanitizeObservationPackEnvelope,
  type ObservationPackAssetInput,
  type ObservationPackBundle,
  type ObservationPackIdentityInput,
} from "./observation-pack";
import type { ProviderAdapter, ProviderImportScope } from "./provider-adapters/provider-adapter";
import { BoundedHttpObjectError, readBoundedHttpObject } from "./bounded-http-object";

const MAX_CAPTURE_ASSET_BYTES = 50 * 1024 * 1024;
const CAPTURE_ASSET_DEADLINE_MS = 30_000;

export type ObservationPackCaptureDefinition = Readonly<{
  packId: string;
  providerKey: string;
  unitKey: string;
  scope: ProviderImportScope;
  identity: Omit<ObservationPackIdentityInput, "integrationProfileKey" | "integrationProfileVersion" | "ingestionUnit">;
}>;

export async function captureObservationPack(input: {
  definition: ObservationPackCaptureDefinition;
  profile: Readonly<{ profileKey: string; profileVersion: string }>;
  adapter: ProviderAdapter;
  packVersion: string;
  capturedAt: string;
  fetch?: typeof globalThis.fetch;
  credentialValues?: readonly string[];
}): Promise<ObservationPackBundle> {
  const units = await input.adapter.listIntegrationUnits();
  if (!units.some((unit) => unit.unitKey === input.definition.unitKey)) {
    throw new Error("Configured provider adapter does not expose the selected ingestion unit.");
  }
  const readiness = await input.adapter.getCredentialReadiness();
  const selectedReadiness = readiness.filter((entry) => entry.unitKey === input.definition.unitKey);
  if (
    selectedReadiness.length === 0 ||
    selectedReadiness.some((entry) => entry.state !== "configured" && entry.state !== "not-required")
  ) {
    throw new Error("Selected provider credential readiness is not executable.");
  }
  const transportDiagnostics = await input.adapter.getTransportDiagnostics();
  if (
    transportDiagnostics.some(
      (diagnostic) =>
        diagnostic.severity === "error" && (!diagnostic.unitKey || diagnostic.unitKey === input.definition.unitKey),
    )
  ) {
    throw new Error("Selected provider transport reports a blocking diagnostic.");
  }

  const plan = await input.adapter.planImport(input.definition.scope);
  if (plan.unitKey !== input.definition.unitKey) {
    throw new Error("Provider import plan changed the selected ingestion unit.");
  }
  const envelopes = [];
  for await (const envelope of input.adapter.fetchPayloads(plan)) {
    if (envelope.providerKey !== input.definition.providerKey || envelope.unitKey !== input.definition.unitKey) {
      throw new Error("Provider transport returned an envelope outside the bounded capture identity.");
    }
    envelopes.push(sanitizeObservationPackEnvelope(envelope));
  }
  if (envelopes.length === 0) {
    throw new Error("Provider transport returned no envelopes for the bounded capture.");
  }

  const imageReferencesByUrl = new Map<string, Set<string>>();
  for (const envelope of envelopes) {
    for (const reference of extractObservationPackImageReferences(envelope)) {
      const hashes = imageReferencesByUrl.get(reference.sourceReference) ?? new Set<string>();
      hashes.add(reference.envelopeContentHash);
      imageReferencesByUrl.set(reference.sourceReference, hashes);
    }
  }
  if (imageReferencesByUrl.size === 0) {
    throw new Error("Provider transport returned no source image references for the bounded capture.");
  }

  const assets: ObservationPackAssetInput[] = [];
  for (const [sourceReference, envelopeContentHashes] of [...imageReferencesByUrl.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const object = await readBoundedHttpObject({
      fetch: input.fetch ?? globalThis.fetch,
      url: sourceReference,
      maxBytes: MAX_CAPTURE_ASSET_BYTES,
      deadlineMs: CAPTURE_ASSET_DEADLINE_MS,
      accept: "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8",
    }).catch((error) => {
      if (error instanceof BoundedHttpObjectError && error.code === "response-too-large") {
        throw new Error("A provider source image exceeded the per-asset capture bound.");
      }
      throw new Error("A provider source image request failed.");
    });
    if (object.body.byteLength === 0) {
      throw new Error("A provider source image was empty or exceeded the per-asset capture bound.");
    }
    assets.push({
      bytes: object.body,
      mediaType: object.contentType,
      sourceReference,
      envelopeContentHashes: [...envelopeContentHashes],
    });
  }

  const bundle = buildObservationPack({
    packId: input.definition.packId,
    packVersion: input.packVersion,
    capturedAt: input.capturedAt,
    identity: {
      ...input.definition.identity,
      integrationProfileKey: input.profile.profileKey,
      integrationProfileVersion: input.profile.profileVersion,
      ingestionUnit: input.definition.unitKey,
    },
    envelopes,
    assets,
  });
  assertCredentialValuesAbsent(bundle, input.credentialValues ?? []);
  return bundle;
}

function assertCredentialValuesAbsent(bundle: ObservationPackBundle, values: readonly string[]): void {
  const meaningfulValues = values.filter((value) => value.length >= 6);
  for (const file of bundle.files) {
    const body = Buffer.from(file.body);
    if (meaningfulValues.some((value) => body.includes(Buffer.from(value)))) {
      throw new Error("Observation Pack retained a configured credential value.");
    }
  }
}
