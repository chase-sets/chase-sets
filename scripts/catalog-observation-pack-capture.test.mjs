import { describe, expect, it } from "vitest";

import { captureObservationPack, observationPackCapturePresets } from "./catalog-observation-pack-capture.ts";
import { getActiveCatalogProviderIntegrationProfileVersion } from "../bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.ts";
import { sha256 } from "../bounded-contexts/catalog/features/source-observations/api/observation-pack.ts";
import {
  createPackBackedProviderAdapter,
  integrationScopeFromManifest,
} from "../bounded-contexts/catalog/features/source-observations/api/seeding/representative-catalog-replay.ts";
import { createSourceObservationProviderImportRuntime } from "../bounded-contexts/catalog/features/source-observations/api/source-observation-provider-import-runtime.ts";

it.each(Object.values(observationPackCapturePresets))(
  "replays the profile-derived target for capture preset $key",
  async (preset) => {
    const profileVersion = getActiveCatalogProviderIntegrationProfileVersion(preset.providerKey, {
      profileKey: preset.profileKey,
    });
    const manifest = {
      captureContentHash: "sha256:synthetic-preset-control",
      identity: {
        provider: {
          key: preset.providerKey,
          ingestionUnit: preset.unitKey,
          integrationProfileVersion: profileVersion.version,
        },
        productLine: { key: preset.identity.productLineKey },
        set: { displayName: preset.identity.setDisplayName },
        language: preset.identity.language,
        scope: {
          scopeKey: preset.identity.scopeKey,
          coordinates: Object.entries(preset.identity.scopeCoordinates).map(([key, value]) => ({ key, value })),
        },
      },
    };
    const runtime = createSourceObservationProviderImportRuntime({ mergeCandidates: {} });
    const targets = await runtime.resolveProviderAdapterImportTargets(
      integrationScopeFromManifest(manifest),
      profileVersion,
    );
    expect(targets).toHaveLength(1);
    const adapter = createPackBackedProviderAdapter(manifest, []);
    await expect(
      adapter.planImport({ unitKey: preset.unitKey, scopeKey: targets[0].scopeKey, values: targets[0].values }),
    ).resolves.toMatchObject({ scope: { scopeKey: preset.identity.scopeKey } });
  },
);

describe("Observation Pack provider image requests", () => {
  it("uses the provider's Romance Dawn identifier throughout capture identity and scope", () => {
    const preset = observationPackCapturePresets["one-piece-romance-dawn"];
    expect(preset.scope.values.expansionId).toBe("OP01");
    expect(preset.identity.setExternalId).toBe("OP01");
    expect(preset.identity.scopeCoordinates.expansionId).toBe("OP01");
  });
  it.each([
    ["pokemon-prismatic-evolutions", "https://assets.example.invalid/synthetic/card", "/high.webp", null],
    ["pokemon-prismatic-evolutions", "https://assets.example.invalid/synthetic/card/high.webp", "", null],
    ["pokemon-prismatic-evolutions", "https://assets.example.invalid/synthetic/variant", "/low.webp", "low.webp"],
    ["mtg-time-spiral", "https://images.example.invalid/synthetic/card.png", "", null],
    ["one-piece-romance-dawn", "https://images.example.invalid/synthetic/negotiated-card", "", null],
  ])("captures %s source %s without changing its retained identity", async (key, source, suffix, syntheticVariant) => {
    const preset = observationPackCapturePresets[key];
    const profileVersion = getActiveCatalogProviderIntegrationProfileVersion(preset.providerKey, {
      profileKey: preset.profileKey,
    });
    const selectedProfile = structuredClone(profileVersion);
    if (syntheticVariant) {
      selectedProfile.profile.connector.highQualityAssetVariant = syntheticVariant;
    }
    const requests = [];
    const bundle = await captureObservationPack({
      preset,
      profileVersion: selectedProfile,
      adapter: {
        async listIntegrationUnits() {
          return [{ unitKey: preset.unitKey }];
        },
        async getCredentialReadiness() {
          return [{ unitKey: preset.unitKey, state: "not-required" }];
        },
        async getTransportDiagnostics() {
          return [];
        },
        async planImport() {
          return { unitKey: preset.unitKey };
        },
        async *fetchPayloads() {
          yield {
            providerKey: preset.providerKey,
            unitKey: preset.unitKey,
            externalKey: "synthetic:image-request-control",
            payload: { image: source },
            provenance: { fetchedAt: "2026-09-06T00:00:00Z" },
          };
        },
      },
      packVersion: "v1-synthetic-image-request-control",
      capturedAt: "2026-09-06T00:00:00Z",
      fetch: async (resource, options) => {
        requests.push(resource);
        expect(options).toMatchObject({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) });
        expect(new Headers(options.headers).get("User-Agent")).toMatch(/^ChaseSets\//);
        expect(new Headers(options.headers).get("Accept")).toContain("image/webp");
        const accept = new Headers(options.headers).get("Accept");
        if (preset.providerKey === "scrydex") {
          // This provider's AVIF response cannot pass the downstream full decoder.
          if (accept.includes("image/avif")) return new Response(null, { status: 406 });
          expect(accept).toBe("image/webp,image/jpeg,image/png");
        } else {
          expect(accept).toBe("image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8");
        }
        return resource === source + suffix
          ? new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
              status: 200,
              headers: { "content-type": "image/png" },
            })
          : new Response(null, { status: 404 });
      },
    });
    expect(requests).toEqual([source + suffix]);
    expect(bundle.manifest.assets).toHaveLength(1);
    expect(bundle.manifest.assets[0].sourceReferenceHash).toBe(sha256(new TextEncoder().encode(source)));
  });
});
