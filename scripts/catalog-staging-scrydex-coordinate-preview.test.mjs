import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  classifyScrydexCoordinatePreviewRouteRequest,
  coordinatePreviewRunnerIdentity,
  createCoordinatePreviewRouteHandler,
  buildProducer,
  validateCoordinatePreviewArtifact,
  writeCoordinatePreviewArtifact,
} from "./catalog-staging-scrydex-coordinate-preview.mjs";
import { runScrydexCoordinatePreview } from "../bounded-contexts/catalog/features/scope-sync-batches/api/scrydex-coordinate-preview-runner.ts";

const origin = "https://admin.staging.chasesets.com";

describe("Scrydex coordinate preview hosted wrapper", () => {
  it("requires the exact admitted runner identity", () => {
    expect(() =>
      coordinatePreviewRunnerIdentity({
        GITHUB_ACTIONS: "true",
        ADMIN_WEB_URL: origin,
        GITHUB_SHA: "a".repeat(40),
        EXPECTED_SHA: "a".repeat(40),
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        CATALOG_STAGING_PROVIDER_UAT_SCOPE: "scrydex-coordinate-preview",
        RUNNER_TEMP: "C:/runner-temp",
      }),
    ).not.toThrow();
    expect(() => coordinatePreviewRunnerIdentity({})).toThrow(/runner-identity/);
  });

  it("refuses confirmation and provider traffic at the route fence", () => {
    expect(
      classifyScrydexCoordinatePreviewRouteRequest(
        { method: "POST", url: `${origin}/api/catalog/scope-sync-batches/confirm`, isNavigationRequest: () => false },
        "pre-confirm",
      ).allowed,
    ).toBe(false);
    expect(
      classifyScrydexCoordinatePreviewRouteRequest(
        { method: "GET", url: "https://api.scrydex.com/onepiece/v1/sets", isNavigationRequest: () => false },
        "capture",
      ),
    ).toMatchObject({ allowed: false, reason: "cross-origin" });
  });

  it("admits exactly one daily usage read", () => {
    expect(
      classifyScrydexCoordinatePreviewRouteRequest(
        {
          method: "GET",
          url: `${origin}/api/catalog/source-observations/integration-control-plane/overview?audience=daily`,
          isNavigationRequest: () => false,
        },
        "capture",
      ),
    ).toMatchObject({ allowed: true, requestClass: "usage-read" });
    expect(
      classifyScrydexCoordinatePreviewRouteRequest(
        {
          method: "GET",
          url: `${origin}/api/catalog/source-observations/integration-control-plane/overview?audience=all`,
          isNavigationRequest: () => false,
        },
        "capture",
      ).allowed,
    ).toBe(false);
  });

  it("observes duplicate preview and usage requests and bounds refusals", async () => {
    const observed = { signIn: 0, profileReads: 0, scopeInventoryReads: 0, coverageReads: 0, cacheOptionReads: 0, usageReads: 0, previewPosts: 0, forbidden: 0 };
    const refusals = [];
    let phase = "pre-confirm";
    const handler = createCoordinatePreviewRouteHandler({ observed, refusals, getPhase: () => phase });
    const route = (url, method = "POST") => ({
      request: () => ({ method: () => method, url: () => url, isNavigationRequest: () => false }),
      abort: vi.fn(async () => undefined),
      continue: vi.fn(async () => undefined),
    });
    const previewUrl = `${origin}/api/catalog/scope-sync-batches/preview`;
    await handler(route(previewUrl));
    await handler(route(previewUrl));
    phase = "capture";
    const usageUrl = `${origin}/api/catalog/source-observations/integration-control-plane/overview?audience=daily`;
    await handler(route(usageUrl, "GET"));
    await handler(route(usageUrl, "GET"));
    expect(observed.previewPosts).toBe(1);
    expect(observed.usageReads).toBe(1);
    expect(observed.forbidden).toBe(2);
    expect(refusals).toEqual(["duplicate-preview", "duplicate-usage-read"]);
  });

  it("writes and validates a named governed-unknown diagnostic", async () => {
    const generation = {
      runId: "900", runAttempt: 1, jobId: "901", jobCompletedAt: "2026-10-20T15:00:00Z",
      deployedHead: "a".repeat(40), imageDigest: `sha256:${"c".repeat(64)}`,
    };
    const receipt = await runScrydexCoordinatePreview({
      runner: { sha: "a".repeat(40), runId: "123", runAttempt: "1", journeyScope: "scrydex-coordinate-preview", origin: "admin.staging.chasesets.com" },
      credentialsPresent: true,
      selectDeployment: async () => ({ generation }),
      signIn: async () => undefined,
      produce: async () => { throw new Error("scrydex-coordinate-preview-refused:bracket-changed"); },
      now: () => "2026-10-20T16:00:00Z",
    });
    const workspace = await mkdtemp(join(tmpdir(), "scrydex-coordinate-preview-"));
    const path = await writeCoordinatePreviewArtifact(receipt, {}, workspace);
    expect(await validateCoordinatePreviewArtifact(workspace)).toBe("governed-unknown");
    expect(JSON.parse(await readFile(path, "utf8")).reasons).toContain("producer-failed:bracket-changed");
  });

  it("refuses a continuation page whose cache snapshot changed", async () => {
    const units = [
      "scrydex:one-piece:set:reference-data",
      "scrydex:one-piece:single-card:source-observation-import",
      "scrydex:one-piece:sealed-product:source-observation-import",
      "scrydex:lorcana:set:reference-data",
      "scrydex:lorcana:single-card:source-observation-import",
    ];
    const profiles = units.map((unit, index) => ({
      providerKey: "scrydex", profileKey: `profile-${index}`, profileVersion: "v1", ingestionUnitKey: unit,
      sourceOptionKinds: [{ queryKind: "sets", queryKeySynonyms: [], displayName: "Sets", scope: "set-name", parentScope: null, parentRequired: false, parentValueKind: null, parentDiagnosticText: null }],
      languageOptions: ["en"],
      active: true,
    }));
    let firstPage = true;
    const page = {
      evaluate: async (_fn, arg) => {
        const path = arg?.path;
        if (!path) return { status: 200, body: { planFingerprint: "b".repeat(64), resolvedAt: "2026-10-20T16:00:30Z", previewVersion: "v1", status: "ready", confirmAllowed: true, blockers: [], samples: [] } };
        if (path.includes("provider-profiles")) return { status: 200, body: { items: profiles, total: profiles.length, count: profiles.length } };
        if (path.includes("integration-control-plane")) return { status: 200, body: { providerReadiness: { providers: [{ providerKey: "scrydex" }] } } };
        if (path.includes("scope-records")) {
          const productDomain = new URL(`https://admin.staging.chasesets.com${path}`).searchParams.get("productDomain");
          return { status: 200, body: { items: [{ scopeRecordId: productDomain === "one-piece" ? "scope-one" : "scope-two", productDomain, scopeKind: "set", lifecycleStatus: "active" }], total: 1, count: 1 } };
        }
        if (path.includes("provider-scope-mappings")) {
          const scopeRecordId = path.split("/").at(-1);
          const domain = scopeRecordId === "scope-one" ? "one-piece" : "lorcana";
          return { status: 200, body: { schemaVersion: "catalog-scope-coverage-v1", scopeRecordId, productDomain: domain, providers: [{ providerKey: "scrydex", acceptedMappings: units.filter((unit) => unit.includes(domain)).map((unit, index) => ({ mappingId: `${domain}-${index}`, scopeRecordId, providerKey: "scrydex", unitKey: unit, reviewStatus: "accepted", updatedAt: "2026-10-19T00:00:00Z", coordinates: { setId: `S-${index}`, setName: `Set ${index}` } })) }] } };
        }
        const unit = new URL(`https://admin.staging.chasesets.com${path}`).searchParams.get("ingestionUnitKey");
        const continuation = path.includes("cursor=offset%3A1") || path.includes("cursor=offset:1");
        const cache = { status: "fresh", source: "cache", cacheKey: "sha256:" + "1".repeat(64), fetchedAt: continuation ? "2026-10-20T14:59:00Z" : "2026-10-20T15:00:00Z", expiresAt: "2026-10-20T15:30:00Z", staleUntil: "2099-10-20T17:00:00Z", cacheOnly: true, forceRefresh: false };
        if (continuation) {
          firstPage = false;
          return { status: 200, body: { items: [{ providerKey: "scrydex", queryKind: "sets", value: "S-0" }], total: 2, count: 1, page: { cursor: "offset:1", nextCursor: null, limit: 200, hasMore: false }, cache } };
        }
        return { status: 200, body: { items: [{ providerKey: "scrydex", queryKind: "sets", value: "OTHER" }], total: 2, count: 1, page: { cursor: null, nextCursor: "offset:1", limit: 200, hasMore: true }, cache } };
      },
    };
    await expect(buildProducer(page, {})).rejects.toThrow("cache-identity-changed");
  });
});
