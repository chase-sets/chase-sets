import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { CatalogAuthoringEnv } from "../../../../support/authoring-support/api";
import {
  catalogProviderProfileVersionIngestionUnitKey,
  listCatalogProviderIntegrationProfileVersions,
  selectActiveCatalogProviderProfileVersion,
} from "../providers/registry";
import { createSourceObservationIntegrationJobRuntime } from "../source-observation-integration-job-runtime";
import { bulkReviewJobRoutes, type BulkReviewJobRouteServices } from "./bulk-review-job-routes";
import { integrationJobRoutes } from "./integration-job-routes";
import { parseCatalogPrimaryWorkbenchRouteContext } from "../../ui/primary-workbench-route-context";
import { integrationJobScopeForUnit, scopeContextFromFields } from "../../ui/primary-workbench-scope-context";
import { sourceScopeWorksetFor } from "../../ui/primary-workbench-source-scope-workset";
import { profileReview, sourceObservationScope } from "../../ui/primary-workbench-test-fixtures";

// The Catalog API's import and reapply routes over the real runtime, with only the
// provider adapter and persistence stubbed: what a client's body reaches, and what the API
// refuses before either boundary. All product IDs are synthetic.

const profiles = listCatalogProviderIntegrationProfileVersions();
const activeProfiles = (provider: string) =>
  profiles.filter((profile) => profile.providerKey === provider && profile.active && profile.lifecycle === "active");

class PersistenceReached extends Error {}

function harness() {
  const adapterScopes: unknown[] = [];
  const enqueued: { scope: unknown; profileSnapshot: unknown }[] = [];
  const queries: { text: string; values: readonly unknown[] }[] = [];
  const runtime = createSourceObservationIntegrationJobRuntime({
    deps: {
      db: {
        query: async (text: string, values: readonly unknown[] = []) => {
          queries.push({ text, values });
          return { rows: [] };
        },
      },
    },
    profileVersions: {
      async listProfileVersions(provider?: string) {
        return profiles.filter((profile) => !provider || profile.providerKey === provider);
      },
      async getActiveProfileVersion(provider: string, selector?: { profileKey?: string; ingestionUnitKey?: string }) {
        return selectActiveCatalogProviderProfileVersion(provider, activeProfiles(provider), selector);
      },
    },
    rolloutControlPolicy: { assertAllowed() {} },
    integrationJobStore: {
      async listActive() {
        return [];
      },
      async enqueue(input: { payload: { scope: unknown; profileSnapshot: unknown } }) {
        enqueued.push({ scope: input.payload.scope, profileSnapshot: input.payload.profileSnapshot });
        throw new PersistenceReached();
      },
    },
    integrationWorkUnitStore: {},
    promotionReapply: {},
    scopeSyncState: {},
    providerImport: {
      async previewProviderAdapterIntegrationImportTargets(scope: unknown) {
        adapterScopes.push(scope);
        return [];
      },
    },
  } as unknown as Parameters<typeof createSourceObservationIntegrationJobRuntime>[0]);

  const app = new Hono<CatalogAuthoringEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", { permissions: ["catalog.view", "catalog.manage"] } as never);
    c.set("context", { tenantId: "tnt_synthetic", audit: { performedByUserId: "usr_synthetic" } } as never);
    await next();
  });
  app.onError((error, c) =>
    c.json({ reached: error instanceof PersistenceReached ? "persistence" : error.message }, 500),
  );
  // The import routes under test use only the integration job services.
  app.route("/", integrationJobRoutes(runtime.services as unknown as Parameters<typeof integrationJobRoutes>[0]));
  app.route("/", bulkReviewJobRoutes(runtime.services as unknown as BulkReviewJobRouteServices));

  async function post(path: string, body: unknown) {
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  // The Source Observations a reapply selects to reapply: the query and its values.
  const observationSelections = () =>
    queries.filter((query) => query.text.includes("FROM catalog_source_observations"));

  return { post, adapterScopes, enqueued, observationSelections };
}

function unitOf(provider: string, fragment: string) {
  const profile = activeProfiles(provider).find((candidate) =>
    catalogProviderProfileVersionIngestionUnitKey(candidate).includes(fragment),
  );
  if (!profile) throw new Error(`no active ${provider} unit with ${fragment}`);
  return { profile, unitKey: catalogProviderProfileVersionIngestionUnitKey(profile) };
}

describe("Catalog import routes refuse a product coordinate before the adapter or the store", () => {
  const tcgdex = activeProfiles("tcgdex")[0]!;
  const tcgdexUnit = catalogProviderProfileVersionIngestionUnitKey(tcgdex);
  const refused = {
    "a unit with no standalone product import": {
      provider: "tcgdex",
      ingestionUnitKey: tcgdexUnit,
      language: "en",
      productId: "synthetic-product",
    },
    "a product mixed with a set": {
      provider: "ygojson",
      ingestionUnitKey: unitOf("ygojson", ":sealed-product:").unitKey,
      language: "en",
      setId: "synthetic-set",
      productId: "synthetic-sealed-product",
    },
    "a product under another unit": {
      provider: "ygojson",
      ingestionUnitKey: unitOf("ygojson", ":set:").unitKey,
      language: "en",
      productId: "synthetic-sealed-product",
    },
  };

  for (const [name, scope] of Object.entries(refused)) {
    it(`refuses ${name} at preview and at enqueue`, async () => {
      const { post, adapterScopes, enqueued } = harness();

      const preview = await post("/integration-jobs/preview", { action: "import", scope });
      const enqueue = await post("/integration-jobs", { action: "import", scope });

      expect(preview.status).toBe(400);
      expect(enqueue.status).toBe(400);
      expect((enqueue.body.error as { code: string }).code).toBe("invalid_scope");
      expect(adapterScopes).toEqual([]);
      expect(enqueued).toEqual([]);
    });
  }

  it("keeps an importable product coordinate through preview and enqueue", async () => {
    const { post, adapterScopes, enqueued } = harness();
    const { unitKey } = unitOf("ygojson", ":sealed-product:");
    const scope = integrationJobScopeForUnit(
      scopeContextFromFields({ providerKey: "ygojson", languageCode: "en", productId: "synthetic-sealed-product" }),
      unitKey,
    );

    expect((await post("/integration-jobs/preview", { action: "import", scope })).status).toBe(200);
    expect((await post("/integration-jobs", { action: "import", scope })).body).toEqual({ reached: "persistence" });
    expect(adapterScopes).toEqual([expect.objectContaining({ productId: "synthetic-sealed-product" })]);
    expect(enqueued).toEqual([
      expect.objectContaining({ scope: expect.objectContaining({ productId: "synthetic-sealed-product" }) }),
    ]);
  });
});

describe("A unit's reapply body selects the unit whose profile reapplies it", () => {
  const selected = unitOf("scrydex", ":one-piece:single-card:");

  function worksetReapplyBody() {
    const review = profileReview({
      providerKey: "scrydex",
      ingestionUnitKey: selected.unitKey,
      profileKey: selected.profile.profileKey,
      profileVersion: selected.profile.profileVersion,
      active: true,
      lifecycle: "active",
    });
    const workset = sourceScopeWorksetFor({
      canManage: true,
      controlPlaneOverview: null,
      generatedAt: "2026-11-06T00:00:00Z",
      importJobs: { jobs: [] },
      profiles: [review],
      readinessBlockers: [],
      routeContext: parseCatalogPrimaryWorkbenchRouteContext(
        `https://admin.example/catalog/integrations?providerKey=scrydex&unitKey=${selected.unitKey}&languageCode=en&expansionId=synthetic-expansion`,
      ),
      scopes: [
        sourceObservationScope({
          provider_key: "scrydex",
          language_code: "en",
          expansion_id: "synthetic-expansion",
          expansion_name: "Synthetic Expansion",
          product_line_id: "one-piece",
          product_line_name: "One Piece",
          promoted_observations: 1,
        }),
      ],
      sourceOptions: { pages: [], selectedProviderKey: "scrydex", status: "ready" },
    } as unknown as Parameters<typeof sourceScopeWorksetFor>[0]);
    const row = workset.units.find((unit) => unit.unitKey === selected.unitKey);
    expect(row?.actions.reapply.state).toBe("available");
    return row!.commandScopes!.reapply;
  }

  it("reapplies a multi-unit provider's row with that unit's active profile version", async () => {
    expect(activeProfiles("scrydex").length).toBeGreaterThan(1);
    const { post, enqueued } = harness();
    const scope = worksetReapplyBody();

    expect(scope).toMatchObject({ provider: "scrydex", ingestionUnitKey: selected.unitKey });
    expect((await post("/reapply", { scope })).body).toEqual({ reached: "persistence" });
    expect(enqueued).toEqual([
      {
        scope: expect.objectContaining({ ingestionUnitKey: selected.unitKey }),
        profileSnapshot: expect.objectContaining({
          profileKey: selected.profile.profileKey,
          ingestionUnitKey: selected.unitKey,
        }),
      },
    ]);
  });

  it("selects only the unit's own kind of observation on a coordinate a sibling unit shares", async () => {
    const sealed = unitOf("scrydex", ":one-piece:sealed-product:");
    const coordinate = {
      provider: "scrydex",
      language: "en",
      productLineId: "one-piece",
      setId: "synthetic-expansion",
    };
    const selections = [];
    for (const unit of [selected, sealed]) {
      const { post, observationSelections } = harness();
      expect((await post("/reapply", { scope: { ...coordinate, ingestionUnitKey: unit.unitKey } })).body).toEqual({
        reached: "persistence",
      });
      const [selection] = observationSelections();
      expect(kindParameter(selection)).toBe(unit.profile.profile.normalizedObservationMapping.kind);
      selections.push(selection);
    }

    expect(selected.profile.profile.normalizedObservationMapping.kind).toBe("one-piece-card-print");
    expect(sealed.profile.profile.normalizedObservationMapping.kind).toBe("one-piece-sealed-product");
    expect(selections[0]!.values).not.toEqual(selections[1]!.values);
  });

  it("keeps a queued unit reapply to the unit's kind when a worker refills it", async () => {
    const queries: { text: string; values: readonly unknown[] }[] = [];
    const jobContext = { tenantId: "tnt_synthetic", audit: { performedByUserId: "usr_synthetic" } };
    const job = {
      jobId: "job_synthetic_reapply",
      jobKind: "reapply",
      status: "running",
      claimOwnerId: "worker_synthetic",
      eventContext: jobContext,
      payload: {
        action: "reapply",
        scope: {
          provider: "scrydex",
          language: "en",
          setId: "synthetic-expansion",
          ingestionUnitKey: selected.unitKey,
        },
        syncRunId: null,
        profileSnapshot: {
          providerKey: "scrydex",
          profileKey: selected.profile.profileKey,
          profileVersion: selected.profile.profileVersion,
          ingestionUnitKey: selected.unitKey,
        },
        reapplyProfileMode: "current-active-profile",
      },
      progress: { completed: 0, total: 0, currentName: null, status: null, phase: "queued" },
      result: null,
      createdAt: "2026-11-06T00:00:00.000Z",
      updatedAt: "2026-11-06T00:00:00.000Z",
    };
    const runtime = createSourceObservationIntegrationJobRuntime({
      deps: {
        db: {
          query: async (text: string, values: readonly unknown[] = []) => {
            queries.push({ text, values });
            return { rows: [] };
          },
        },
      },
      profileVersions: {
        async listProfileVersions(provider?: string) {
          return profiles.filter((profile) => !provider || profile.providerKey === provider);
        },
      },
      rolloutControlPolicy: { assertAllowed() {}, decide: () => ({ allowed: true }) },
      integrationJobStore: {
        async claimNext(input: { jobKinds: readonly string[] }) {
          return input.jobKinds.includes("reapply") ? job : null;
        },
        async complete() {
          return job;
        },
      },
      integrationWorkUnitStore: {
        async claimNext() {
          return { claim: null };
        },
        async summarize() {
          return { queued: 0, running: 0 };
        },
      },
      promotionReapply: {},
      scopeSyncState: {},
      providerImport: {},
    } as unknown as Parameters<typeof createSourceObservationIntegrationJobRuntime>[0]);

    await runtime.services.processNextIntegrationJob({ claimOwnerId: "worker_synthetic", claimTtlMs: 60_000 });

    const [selection] = queries.filter((query) => query.text.includes("FROM catalog_source_observations"));
    expect(kindParameter(selection)).toBe("one-piece-card-print");
  });

  it("refuses a multi-unit provider's reapply without a unit, or with another provider's unit, as invalid", async () => {
    const { post, enqueued } = harness();
    const scope = worksetReapplyBody();
    const { ingestionUnitKey: _unit, ...withoutUnit } = scope;

    for (const body of [withoutUnit, { ...scope, ingestionUnitKey: unitOf("ygojson", ":set:").unitKey }]) {
      const response = await post("/reapply", { scope: body });
      expect(response.status).toBe(400);
      expect((response.body.error as { code: string }).code).toBe("invalid_scope");
    }
    expect(enqueued).toEqual([]);
  });

  it("still reapplies a single-unit provider's scope without a unit", async () => {
    const single = [...new Set(profiles.map((profile) => profile.providerKey))].find(
      (provider) => activeProfiles(provider).length === 1 && activeProfiles(provider)[0]!.executableMappingContract,
    );
    expect(single).toBeDefined();
    const harnessed = harness();
    const { post, enqueued } = harnessed;

    const { observationSelections } = harnessed;
    expect((await post("/reapply", { scope: { provider: single, language: "en" } })).body).toEqual({
      reached: "persistence",
    });
    expect(enqueued).toHaveLength(1);
    // Without a unit, every promoted observation on the coordinate is selected, as before.
    expect(observationSelections()[0]?.text).not.toContain("normalized->>'kind'");
  });
});

// The value the selection's kind condition is bound to, read from its placeholder, so a condition
// that compares the kind with anything but a bound parameter fails here as it would in Postgres.
function kindParameter(selection: { text: string; values: readonly unknown[] } | undefined): unknown {
  const match = selection?.text.match(/normalized->>'kind' = \$(\d+)/);
  return match ? selection?.values[Number(match[1]) - 1] : undefined;
}
