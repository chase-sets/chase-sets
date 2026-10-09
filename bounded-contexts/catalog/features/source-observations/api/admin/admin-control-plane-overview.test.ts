import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderAdapterRegistry } from "../provider-adapters/registry";
import type { ProviderAdapter } from "../provider-adapters/provider-adapter";
import { buildCatalogIntegrationControlPlaneReadiness } from "../governance/catalog-integration-control-plane-readiness";
import { createCatalogIntegrationDryRunProofRegistry } from "../governance/catalog-integration-dry-run-proofs";
import { createCatalogIntegrationRolloutControlPolicy } from "../governance/catalog-integration-rollout-controls";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import { createScrydexOnePieceProviderAdapter, type ScrydexOnePieceCredentials } from "../providers/scrydex/adapter";
import { readProviderSendWindow } from "../providers/provider-send-runtime";
import { createPostgresProviderSendLedger } from "../providers/provider-send-ledger";
import { createProviderSendAdmission } from "../providers/provider-send-admission";
import { buildCatalogIntegrationControlPlaneOverview } from "./admin-control-plane-overview";
import { SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY } from "../provider-adapters/scrydex-one-piece";
import type {
  CatalogIntegrationControlPlaneReadiness,
  SourceObservationIntegrationJob,
  SourceObservationIntegrationProfileSnapshot,
} from "../runtime";

const generatedAt = "2026-06-25T12:00:00.000Z";

describe("Catalog integration control-plane overview", () => {
  it("lost ledger authority is unavailable, never zero or raw driver detail", async () => {
    const connect = vi.fn(async () => {
      throw new Error("synthetic-private-driver-detail");
    });
    const ledger = createPostgresProviderSendLedger({ query: vi.fn(), connect });
    const admission = createProviderSendAdmission({ enabled: true, ledger });
    const readout = await readProviderSendWindow({ ledger, admission });
    expect(readout).toEqual({ state: "unavailable", refusal: "authority-unavailable" });
    expect(JSON.stringify(readout)).not.toContain("synthetic-private-driver-detail");
    expect(connect).toHaveBeenCalledTimes(1);
    expect(await readProviderSendWindow(null)).toEqual({ state: "disabled" });
  });
  it("summarizes failed import outcome reasons with redacted provider evidence", () => {
    const overview = buildCatalogIntegrationControlPlaneOverview({
      generatedAt,
      readiness: readinessFixture(),
      profiles: [],
      activeJobs: [
        integrationJobFixture({
          result: {
            requested: 1,
            imported: 0,
            observed: 0,
            reapplied: 0,
            skipped: 0,
            failed: 1,
            outcomes: [
              {
                providerKey: "scrydex",
                languageCode: "en",
                expansionId: "OP16",
                status: "failed",
                observed: 0,
                reapplied: 0,
                reason:
                  "Scrydex request failed at https://api.scrydex.com/onepiece/v1/expansions/OP16/sealed?page=1&api_key=secret with X-Api-Key=secret-token; provider response body is redacted.",
                providerUsageEvidence: {
                  unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
                  requestStrategy: "bulk-first",
                  estimateState: "estimated",
                  estimatedRequestCount: 1,
                  estimateReason: null,
                  actualRequestCount: 2,
                  pageCount: 2,
                  cacheHitCount: null,
                  cacheMissCount: null,
                  usageCheckState: "checked",
                  creditDiagnostic: "credit status is available",
                  degradedDiagnostic: null,
                  bulkFirstConfirmed: true,
                  perRecordFallbackReason: null,
                  selectedFields: [],
                  pageSize: 100,
                },
              },
            ],
          },
        }),
      ],
    });

    const result = overview.unitActivity.units[0]?.recentJobs[0]?.result;

    expect(result?.redactedFailureReasons).toEqual([
      "Scrydex request failed at https://api.scrydex.com/onepiece/v1/expansions/OP16/sealed with X-Api-Key=[redacted]; provider response body is redacted.",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-token");
    expect(JSON.stringify(result)).not.toContain("api_key=secret");
    expect(result?.usage).toEqual({ actualRequestCount: 2, pageCount: 2, cacheHitCount: null, cacheMissCount: null });
    expect(JSON.stringify(result)).not.toContain("credit status is available");
  });

  it("does not report partial usage totals when an outcome has no evidence", () => {
    const overview = buildCatalogIntegrationControlPlaneOverview({
      generatedAt,
      readiness: readinessFixture(),
      profiles: [],
      activeJobs: [
        integrationJobFixture({
          result: {
            requested: 2,
            imported: 1,
            observed: 1,
            reapplied: 0,
            skipped: 0,
            failed: 1,
            outcomes: [
              {
                providerKey: "scrydex",
                languageCode: "en",
                expansionId: "OP16",
                status: "imported",
                observed: 1,
                reapplied: 0,
                reason: null,
                providerUsageEvidence: {
                  unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
                  requestStrategy: "bulk-first",
                  estimateState: "estimated",
                  estimatedRequestCount: 1,
                  estimateReason: null,
                  actualRequestCount: 2,
                  pageCount: 2,
                  cacheHitCount: null,
                  cacheMissCount: null,
                  usageCheckState: "checked",
                  creditDiagnostic: null,
                  degradedDiagnostic: null,
                  bulkFirstConfirmed: true,
                  perRecordFallbackReason: null,
                  selectedFields: [],
                  pageSize: 100,
                },
              },
              {
                providerKey: "scrydex",
                languageCode: "en",
                expansionId: "OP17",
                status: "failed",
                observed: 0,
                reapplied: 0,
                reason: "Provider usage evidence was unavailable.",
              },
            ],
          },
        }),
      ],
    });

    expect(overview.unitActivity.units[0]?.recentJobs[0]?.result?.usage).toEqual({
      actualRequestCount: null,
      pageCount: null,
      cacheHitCount: null,
      cacheMissCount: null,
    });
  });
});

// Synthetic credentials and usage values only; no provider is contacted. The usage
// body follows the real Scrydex `data` envelope captured by the host on 2026-10-09.
const syntheticCredentials = {
  apiKey: "synthetic-scrydex-api-key-8427",
  teamId: "synthetic-scrydex-team-8427",
} as const satisfies ScrydexOnePieceCredentials;
const syntheticUsageData = {
  total_credits_consumed: 8_766,
  overage_credits_consumed: 0,
  credits_remaining: 41_234,
  period_start: "2026-09-22T19:39:46.000Z",
  period_end: "2026-10-22T19:39:46.000Z",
  daily_usage: [{ date: "2026-10-01", credits_consumed: 8_766 }],
};
const syntheticUsage = { data: syntheticUsageData };
const t0 = Date.parse("2026-10-09T12:00:00.000Z");
const minutes = (count: number) => count * 60_000;

describe("Catalog provider usage budget read model", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("serves health loads inside the TTL from one usage request and ages the snapshot by observed time", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const provider = scrydexUsageProvider();

    vi.setSystemTime(t0);
    expect(await scrydexBudget(provider.registry)).toEqual({
      creditBalance: 41_234,
      creditAllowance: 50_000,
      creditUnit: "credits",
      readiness: "ready",
      freshness: "fresh",
      observedAt: new Date(t0).toISOString(),
      lagCategory: "documented-window",
      diagnosticCode: null,
      diagnostic: "Scrydex account usage check completed with redacted credit evidence.",
      estimatedCalls: null,
      estimatedScope: null,
    });
    vi.setSystemTime(t0 + minutes(14));
    expect(await scrydexBudget(provider.registry)).toMatchObject({ freshness: "fresh", creditBalance: 41_234 });
    expect(provider.fetch).toHaveBeenCalledTimes(1);

    provider.fail(503);
    vi.setSystemTime(t0 + minutes(16));
    expect(await scrydexBudget(provider.registry)).toMatchObject({
      freshness: "stale",
      readiness: "degraded",
      creditBalance: 41_234,
      creditAllowance: 50_000,
      observedAt: new Date(t0).toISOString(),
      diagnosticCode: "provider-degraded",
    });
    expect(provider.fetch).toHaveBeenCalledTimes(2);

    vi.setSystemTime(t0 + minutes(30));
    expect(await scrydexBudget(provider.registry)).toMatchObject({ freshness: "stale" });
    expect(provider.fetch).toHaveBeenCalledTimes(2);

    vi.setSystemTime(t0 + minutes(61));
    const expired = await scrydexBudget(provider.registry);
    expect(provider.fetch).toHaveBeenCalledTimes(3);
    expect(expired).toMatchObject({
      freshness: "unavailable",
      readiness: "unknown",
      creditBalance: null,
      creditAllowance: null,
      observedAt: new Date(t0).toISOString(),
    });
    expect(expired?.creditBalance).not.toBe(0);

    provider.recover();
    vi.setSystemTime(t0 + minutes(77));
    expect(await scrydexBudget(provider.registry)).toMatchObject({
      freshness: "fresh",
      creditBalance: 41_234,
      observedAt: new Date(t0 + minutes(77)).toISOString(),
    });
    expect(provider.fetch).toHaveBeenCalledTimes(4);
  });

  it("projects partial, never-observed, failed, exhausted, and unsupported usage explicitly", async () => {
    const partial = scrydexUsageProvider({ body: { data: { ...syntheticUsageData, credits_remaining: undefined } } });
    expect(await scrydexBudget(partial.registry)).toMatchObject({
      freshness: "fresh",
      readiness: "unknown",
      creditBalance: null,
      creditAllowance: null,
    });

    const unconfigured = scrydexUsageProvider({ credentials: {} });
    expect(await scrydexBudget(unconfigured.registry)).toMatchObject({
      freshness: "never-observed",
      readiness: "unknown",
      creditBalance: null,
      observedAt: null,
      diagnosticCode: "credential-missing",
    });
    expect(unconfigured.fetch).not.toHaveBeenCalled();

    const failed = scrydexUsageProvider();
    failed.fail(503);
    expect(await scrydexBudget(failed.registry)).toMatchObject({
      freshness: "unavailable",
      readiness: "unknown",
      creditBalance: null,
      observedAt: null,
      lagCategory: "unobserved",
    });

    const exhausted = scrydexUsageProvider();
    exhausted.fail(402);
    expect(await scrydexBudget(exhausted.registry)).toMatchObject({ readiness: "blocked", creditBalance: null });

    const overview = await healthOverview(new ProviderAdapterRegistry([unsupportedUsageAdapter()]));
    expect(overview.providerReadiness.providers).toEqual([
      expect.objectContaining({ providerKey: "synthetic-unsupported", usageBudget: null }),
    ]);
    expect(overview.readiness.providerUsage).toEqual([]);
  });

  it("keeps credentials, account fields, and provider URLs out of the composed read model", async () => {
    const provider = scrydexUsageProvider({
      body: {
        data: { ...syntheticUsageData, account_id: "synthetic-account-8427" },
        invoice_url: "https://synthetic-billing.invalid/invoices/synthetic",
      },
    });

    const serialized = JSON.stringify(await healthOverview(provider.registry));

    for (const forbidden of [
      syntheticCredentials.apiKey,
      syntheticCredentials.teamId,
      "synthetic-account-8427",
      "synthetic-billing.invalid",
      "synthetic-scrydex.invalid",
      "daily_usage",
      "period_start",
      "2026-09-22",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

function scrydexUsageProvider(input: { body?: unknown; credentials?: ScrydexOnePieceCredentials } = {}) {
  let failureStatus: number | null = null;
  const fetch = vi.fn(async (request: Parameters<typeof globalThis.fetch>[0]) => {
    expect(new URL(String(request)).pathname).toBe("/account/v1/usage");
    return failureStatus === null
      ? Response.json(input.body ?? syntheticUsage)
      : Response.json({ error: "synthetic-failure" }, { status: failureStatus });
  });
  const adapter = createScrydexOnePieceProviderAdapter({
    credentials: input.credentials ?? syntheticCredentials,
    baseUrl: "https://synthetic-scrydex.invalid/onepiece/v1",
    fetch,
  });
  return {
    fetch,
    registry: new ProviderAdapterRegistry([adapter]),
    fail(status: number) {
      failureStatus = status;
    },
    recover() {
      failureStatus = null;
    },
  };
}

async function healthOverview(registry: ProviderAdapterRegistry) {
  const readiness = await buildCatalogIntegrationControlPlaneReadiness(
    registry,
    createCatalogIntegrationDryRunProofRegistry([]),
    createCatalogIntegrationRolloutControlPolicy(),
  );
  return buildCatalogIntegrationControlPlaneOverview({ readiness, profiles: [], activeJobs: [] });
}

async function scrydexBudget(registry: ProviderAdapterRegistry) {
  const overview = await healthOverview(registry);
  return overview.providerReadiness.providers.find((provider) => provider.providerKey === "scrydex")?.usageBudget;
}

function unsupportedUsageAdapter(): ProviderAdapter {
  const unitKey = "synthetic-unsupported:cards:single-card:reference-data" as CatalogIntegrationUnitKey;
  return {
    providerKey: "synthetic-unsupported",
    capabilities: { supportsOptionQueries: false, supportsImportPlanning: false, supportsPayloadFetch: false },
    listIntegrationUnits: async () => [
      {
        unitKey,
        providerKey: "synthetic-unsupported",
        productDomain: "cards",
        productForm: "single-card",
        ingestionPurpose: "reference-data",
        displayName: "Synthetic unsupported provider",
        profileVersion: "v1",
      },
    ],
    listOptions: async () => ({ items: [] }),
    planImport: async () => {
      throw new Error("Synthetic unsupported provider does not plan imports.");
    },
    fetchPayloads: async function* () {
      return;
    },
    getCredentialReadiness: async () => [],
    getTransportDiagnostics: async () => [],
  };
}

function readinessFixture(): CatalogIntegrationControlPlaneReadiness {
  return {
    generatedAt,
    rolloutControls: {
      generatedAt,
      controls: [],
    },
    providerUsage: [],
    units: [
      {
        unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        providerKey: "scrydex",
        displayName: "Scrydex One Piece sealed products",
        productDomain: "one-piece",
        productForm: "sealed-product",
        ingestionPurpose: "source-observation-import",
        profileVersion: "2026.06.22",
        semanticReadiness: "ready",
        credentialReadiness: "ready",
        credentialReadinessState: "configured",
        credentialRequirement: "required",
        credentialDiagnosticCode: null,
        transportReadiness: "ready",
        fixtureValidationStatus: "ready",
        dryRunStatus: "completed",
        observationFacts: 1,
        diagnosticCounts: { info: 0, warning: 0, error: 0 },
        diagnostics: [],
        latestDiagnosticText: null,
        dryRunEvidence: [],
      },
    ],
  };
}

function integrationJobFixture(
  overrides: Partial<SourceObservationIntegrationJob> = {},
): SourceObservationIntegrationJob {
  const profileSnapshot = scrydexSealedProfileSnapshot();
  return {
    jobId: "job_failed",
    syncRunId: null,
    action: "import",
    scope: {
      provider: "scrydex",
      ingestionUnitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      language: "en",
      setId: "OP16",
    },
    profileSnapshot,
    reapplyProfileMode: null,
    status: "completed",
    operatorStatus: "partial",
    consistency: {
      duplicateSubmissionPolicy: "reuse-active-job",
      profileSnapshotPolicy: "snapshotted-at-enqueue",
      retryResumePolicy: "skip-completed-outcomes",
      partialFailurePolicy: "mixed-outcomes",
      workUnitClaimPolicy: "leased-job-turns",
    },
    progress: {
      phase: "completed",
      completed: 1,
      total: 1,
      currentName: null,
      status: "failed",
    },
    result: null,
    errorMessage: null,
    createdAt: generatedAt,
    startedAt: generatedAt,
    completedAt: generatedAt,
    updatedAt: generatedAt,
    ...overrides,
  };
}

function scrydexSealedProfileSnapshot(): SourceObservationIntegrationProfileSnapshot {
  return {
    providerKey: "scrydex",
    profileKey: "one-piece-sealed-product-source-observation",
    profileVersion: "2026.06.22",
    ingestionUnitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
    lifecycle: "active",
    connectorKind: "scrydex",
    connectorSourceVersion: null,
    sourceMappingFingerprint: "fingerprint:scrydex:one-piece-sealed:2026.06.22",
  };
}
