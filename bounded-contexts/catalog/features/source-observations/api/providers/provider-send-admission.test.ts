import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogRuntimeDeps } from "../../../../support/authoring-support/runtime-support";
import { createCatalogItemRuntime } from "../../../catalog-items/api/runtime";
import { createReferenceDataRuntime } from "../../../reference-data/api/runtime";
import { createSourceObservationRuntime } from "../runtime";
import { createCatalogIntegrationDryRunProofRegistry } from "../governance/catalog-integration-dry-run-proofs";
import { catalogFixtureTransports } from "./catalog-fixture-transports";
import { createTcgdexProviderAdapter } from "./tcgdex/adapter";
import { getActiveCatalogProviderIntegrationProfileVersion } from "./registry";
import { fetchTcgdexEnglishMirrorEntity, normalizeTcgdexImageAsset } from "./tcgdex-client";
import { normalizeLorcanaImageAsset } from "../seeding/product-asset-normalization";
import { createPostgresProviderSendLedger } from "./provider-send-ledger";
import { queryProviderIntegrationOptions } from "./provider-option-queries";
import {
  bindCatalogProviderServices,
  createCatalogProviderSendRuntime,
  readProviderSendWindow,
  runProviderSendJob,
} from "./provider-send-runtime";
import {
  createInMemoryTcgplayerAutomationHttpConfigStore,
  TcgplayerAutomationDomainHttpClient,
} from "./tcgplayer-automation-client";
import {
  createScrydexOnePieceProviderAdapter,
  SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "./scrydex/adapter";
import { ProviderAdapterRegistry } from "../provider-adapters/registry";
import { createScryfallProviderAdapter } from "./scryfall/adapter";
import { createYgoprodeckProviderAdapter } from "./ygoprodeck/adapter";
import { createYgojsonProviderAdapter } from "./ygojson/adapter";
import { createMtgjsonProviderAdapter } from "./mtgjson/adapter";
import { createLorcanajsonProviderAdapter } from "./lorcanajson/adapter";
import { createLorcastProviderAdapter } from "./lorcast/adapter";
import { readBoundedHttpObject } from "./bounded-http-object";
import {
  createCatalogProviderOptionQueryCacheRecord,
  queryCatalogProviderIntegrationOptionsWithCache,
} from "./provider-option-query-cache";
import {
  createProviderSendAdmission,
  ProviderSendStoppedError,
  providerSendPolicy,
  type ProviderSendLedger,
  runCatalogProviderWork,
  type ProviderSendBinding,
  sendCatalogProviderRequest,
  type ProviderSendRequest,
} from "./provider-send-admission";

const binding: ProviderSendBinding = { windowId: "synthetic-window", phase: "pass", pass: 1 };
function ledger(overrides: Partial<ProviderSendLedger> = {}): ProviderSendLedger {
  return {
    bind: async () => binding,
    debit: async () => ({ state: "admitted", windowId: binding.windowId, sequence: 1 }),
    settle: async () => undefined,
    stop: async () => undefined,
    ...overrides,
  };
}

describe("Catalog provider-send admission", () => {
  it.each([false, true])(
    "real option query entry retains discovery on reload/force refresh (%s)",
    async (forceRefresh) => {
      const debit = vi
        .fn<ProviderSendLedger["debit"]>()
        .mockResolvedValue({ state: "refused", code: "quota-exhausted" });
      const admission = createProviderSendAdmission({ enabled: true, ledger: ledger({ debit }) });
      const network = vi.fn<typeof fetch>();
      vi.stubGlobal("fetch", network);
      try {
        await expect(
          runCatalogProviderWork(admission, () =>
            queryProviderIntegrationOptions(
              {
                providerKey: "tcgdex",
                queryKind: "expansions",
                languageCode: "en",
                parentValue: "swsh",
                forceRefresh,
              },
              null,
              null,
            ),
          ),
        ).rejects.toThrow("quota-exhausted");
        expect(debit).toHaveBeenCalledTimes(1);
        expect(debit.mock.calls[0]![0]).toMatchObject({ provider: "tcgdex", category: "discovery", binding });
        expect(network).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("retained worker continuations keep payload attribution through real adapter pagination", async () => {
    const requests: ProviderSendRequest[] = [];
    const store = ledger({
      debit: async (request) => {
        requests.push(request);
        return { state: "admitted", windowId: binding.windowId, sequence: requests.length };
      },
    });
    const admission = createProviderSendAdmission({ enabled: true, ledger: store });
    const fixture = composedRuntime();
    fixture.query.mockResolvedValue({
      rows: [{ window_id: binding.windowId, phase: binding.phase, pass: binding.pass }],
    });
    const deps: CatalogRuntimeDeps = {
      ...fixture.deps,
      providerSendRuntime: {
        ledger: createPostgresProviderSendLedger(fixture.pool),
        admission,
      },
    };
    const transport = vi.fn<typeof fetch>(async (input) =>
      Response.json({
        data: [{ id: String(input).includes("page=2") ? "synthetic-two" : "synthetic-one", name: "Synthetic card" }],
        has_more: !String(input).includes("page=2"),
        next_page: "https://api.scryfall.com/cards/search?page=2",
      }),
    );
    const adapter = new ProviderAdapterRegistry([createScryfallProviderAdapter({ fetch: transport })]).require(
      "scryfall",
    );
    const [unit] = await adapter.listIntegrationUnits();
    if (!unit) throw new Error("Missing Scryfall unit");
    await runProviderSendJob(deps, "synthetic-integration-or-bulk-job", async () => {
      const plan = await adapter.planImport({ unitKey: unit.unitKey, scopeKey: "set", values: { setCode: "tsp" } });
      const payloads = [];
      for await (const payload of adapter.fetchPayloads(plan)) payloads.push(payload);
      expect(payloads).toHaveLength(2);
    });
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (request) =>
          request.provider === "scryfall" &&
          request.category === "payload" &&
          request.binding?.windowId === binding.windowId,
      ),
    ).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("mirror and promotion asset entry points retain explicit categories before transport", async () => {
    const profile = getActiveCatalogProviderIntegrationProfileVersion("tcgdex");
    if (!profile) throw new Error("Missing TCGdex profile");
    const debit = vi.fn<ProviderSendLedger["debit"]>().mockResolvedValue({ state: "refused", code: "quota-exhausted" });
    const admission = createProviderSendAdmission({ enabled: true, ledger: ledger({ debit }) });
    const transport = vi.fn<typeof fetch>();
    const assetStorage = { putObject: vi.fn() };
    const entries = [
      [
        "mirror",
        () =>
          fetchTcgdexEnglishMirrorEntity({ profile: profile.profile, entity: "set", id: "swsh3", fetch: transport }),
      ],
      [
        "mirror",
        () =>
          readBoundedHttpObject({
            fetch: transport,
            url: "https://synthetic.invalid/pack",
            maxBytes: 1024,
            deadlineMs: 1000,
            accept: "application/json",
          }),
      ],
      [
        "asset",
        () =>
          normalizeTcgdexImageAsset({
            profile: profile.profile,
            imageBaseUrl: "https://synthetic.invalid/image",
            storageBaseKey: "synthetic",
            observedAt: "2026-10-02T00:00:00.000Z",
            fetcher: transport,
            assetStorage,
          }),
      ],
      [
        "asset",
        () =>
          normalizeLorcanaImageAsset({
            providerKey: "lorcanajson",
            imageUrls: ["https://synthetic.invalid/card.webp"],
            storageBaseKey: "synthetic",
            observedAt: "2026-10-02T00:00:00.000Z",
            sourceUpdatedAt: "2026-10-02T00:00:00.000Z",
            fetcher: transport,
            assetStorage,
          }),
      ],
    ] as const;
    for (const [category, entry] of entries) {
      debit.mockClear();
      await expect(runCatalogProviderWork(admission, async () => entry())).rejects.toThrow("quota-exhausted");
      expect(debit).toHaveBeenCalledTimes(1);
      expect(debit.mock.calls[0]![0]).toMatchObject({ category, binding });
    }
    expect(transport).not.toHaveBeenCalled();
    expect(assetStorage.putObject).not.toHaveBeenCalled();
  });

  it.each(["supplied", "wrapper", "bound", "forged-name", "global", "fixture-as-global"] as const)(
    "only closed transport identity exempts the same unknown request (%s)",
    async (kind) => {
      const fixture: typeof fetch = catalogFixtureTransports.tcgdex;
      const input = "https://api.tcgdex.net/v2/en/sets/swsh3";
      const request = {
        provider: "tcgdex",
        category: "unknown",
        binding,
        tariff: "non-scrydex",
        fixture: true,
      } as const;
      const debit = vi
        .fn<ProviderSendLedger["debit"]>()
        .mockResolvedValue({ state: "refused", code: "unknown-request" });
      const admission = createProviderSendAdmission({ enabled: true, ledger: ledger({ debit }) });
      expect((await admission.send(request, fixture, input)).status).toBe(200);
      expect(debit).not.toHaveBeenCalled();
      const supplied = vi.fn<typeof fetch>(async () => Response.json({ fixture: true }));
      const wrapped = vi.fn<typeof fetch>((...args) => fixture(...args));
      const transport =
        kind === "wrapper"
          ? wrapped
          : kind === "bound"
            ? fixture.bind(null)
            : kind === "fixture-as-global"
              ? fixture
              : supplied;
      if (kind === "forged-name") Object.defineProperty(transport, "name", { value: fixture.name });
      if (kind === "global" || kind === "fixture-as-global") vi.stubGlobal("fetch", transport);
      try {
        await expect(admission.send(request, transport, input)).rejects.toThrow("unknown-request");
        expect(debit).toHaveBeenCalledExactlyOnceWith(request);
        expect(supplied).not.toHaveBeenCalled();
        expect(wrapped).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([
    [
      "tcgdex",
      () =>
        createTcgdexProviderAdapter({
          fetch: catalogFixtureTransports.tcgdex,
          loadActiveProfileVersion: async () => {
            const profile = getActiveCatalogProviderIntegrationProfileVersion("tcgdex");
            if (!profile) throw new Error("Missing TCGdex profile");
            return profile;
          },
        }),
      "expansions",
    ],
    ["mtgjson", () => createMtgjsonProviderAdapter({ fetch: catalogFixtureTransports.mtgjson }), "sets"],
    ["lorcanajson", () => createLorcanajsonProviderAdapter({ fetch: catalogFixtureTransports.lorcanajson }), "sets"],
    ["lorcast", () => createLorcastProviderAdapter({ fetch: catalogFixtureTransports.lorcast }), "sets"],
    ["scryfall", () => createScryfallProviderAdapter({ fetch: catalogFixtureTransports.scryfall }), "sets"],
    ["ygoprodeck", () => createYgoprodeckProviderAdapter({ fetch: catalogFixtureTransports.ygoprodeck }), "sets"],
    ["ygojson", () => createYgojsonProviderAdapter({ fetch: catalogFixtureTransports.ygojson }), "sets"],
  ] as const)(
    "production %s adapter never exempts an adapter-supplied fixture identity",
    async (provider, create, optionKind) => {
      const adapter = new ProviderAdapterRegistry([create()]).require(provider);
      const [unit] = await adapter.listIntegrationUnits();
      if (!unit) throw new Error("Missing production integration unit");
      const debit = vi
        .fn<ProviderSendLedger["debit"]>()
        .mockResolvedValue({ state: "refused", code: "quota-exhausted" });
      const admission = createProviderSendAdmission({ enabled: true, ledger: ledger({ debit }) });
      await expect(
        runCatalogProviderWork(admission, () => adapter.listOptions({ unitKey: unit.unitKey, optionKind })),
      ).rejects.toThrow("quota-exhausted");
      expect(debit).toHaveBeenCalledTimes(1);
      expect(debit.mock.calls[0]![0]).toMatchObject({ provider, category: "discovery", binding });
    },
  );

  it.each(["scrydex", "tcgplayer"] as const)(
    "production %s transport refuses a directly supplied closed fixture identity",
    async (provider) => {
      for (const wrapped of [true, false]) {
        const fixture: typeof fetch = catalogFixtureTransports.tcgdex;
        const wrapper = vi.fn<typeof fetch>((...args) => fixture(...args));
        const supplied = wrapped ? wrapper : fixture;
        const debit = vi
          .fn<ProviderSendLedger["debit"]>()
          .mockResolvedValue({ state: "refused", code: "quota-exhausted" });
        const admission = createProviderSendAdmission({ enabled: true, ledger: ledger({ debit }) });
        const adapter = new ProviderAdapterRegistry([
          createScrydexOnePieceProviderAdapter({
            fetch: supplied,
            credentials: { apiKey: "SYNTHETIC_TEST_ONLY", teamId: "SYNTHETIC_TEST_ONLY" },
          }),
        ]).require("scrydex");
        const client = new TcgplayerAutomationDomainHttpClient(
          "infiniteApi",
          "https://api.tcgdex.net/v2/en",
          createInMemoryTcgplayerAutomationHttpConfigStore(),
          { fetch: supplied, sleep: async () => undefined },
        );
        const OriginalResponse = globalThis.Response;
        const response = vi.spyOn(globalThis, "Response").mockImplementation(function (body, init) {
          return new OriginalResponse(body, init);
        });
        const network = vi.fn<typeof fetch>();
        vi.stubGlobal("fetch", network);
        try {
          await expect(
            runCatalogProviderWork(admission, () =>
              provider === "scrydex" ? adapter.getCredentialReadiness() : client.get("/sets/swsh3"),
            ),
          ).rejects.toMatchObject({ name: "ProviderSendStoppedError", code: "quota-exhausted" });
          expect(debit).toHaveBeenCalledTimes(1);
          expect(debit.mock.calls[0]![0]).toMatchObject({
            provider,
            category: provider === "scrydex" ? "usage" : "discovery",
            binding,
          });
          expect(wrapper).not.toHaveBeenCalled();
          expect(response).not.toHaveBeenCalled();
          expect(network).not.toHaveBeenCalled();
        } finally {
          response.mockRestore();
          vi.unstubAllGlobals();
        }
      }
    },
  );

  it.each(["pristine", "armed", "terminal", "stale", "absent"] as const)(
    "all 13 fixture proofs produce observations without ledger or network I/O (%s)",
    async (state) => {
      vi.stubEnv("CATALOG_PROVIDER_SEND_WINDOW_ENABLED", "true");
      const network = vi.fn(() => {
        throw new Error("Unexpected network from a fixture proof");
      });
      vi.stubGlobal("fetch", network);
      const debit = vi.fn<ProviderSendLedger["debit"]>().mockResolvedValue(
        state === "pristine"
          ? { state: "unarmed" }
          : {
              state: "refused",
              code: state === "stale" ? "stale-binding" : state === "terminal" ? "terminal" : "unknown-request",
            },
      );
      const bind = vi.fn<ProviderSendLedger["bind"]>().mockResolvedValue(binding);
      const settle = vi.fn();
      const stop = vi.fn();
      const admission = createProviderSendAdmission({ enabled: true, ledger: ledger({ debit, bind, settle, stop }) });
      const proofs = [...createCatalogIntegrationDryRunProofRegistry()].filter(([key]) =>
        /^(tcgdex|mtgjson|lorcanajson|lorcast|scryfall|ygoprodeck|ygojson):/.test(key),
      );
      expect(proofs).toHaveLength(13);
      try {
        for (const [unitKey, proof] of proofs) {
          const result =
            state === "absent"
              ? await proof()
              : await runCatalogProviderWork(
                  admission,
                  proof,
                  state === "pristine" ? null : state === "stale" ? { ...binding, pass: 0 } : binding,
                );
          expect(result.unitKey).toBe(unitKey);
          expect(result.observations.length, unitKey).toBeGreaterThan(0);
          expect(result.observations.every((observation) => observation.providerKey === unitKey.split(":")[0])).toBe(
            true,
          );
        }
        expect(debit).not.toHaveBeenCalled();
        expect(bind).not.toHaveBeenCalled();
        expect(settle).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
        expect(network).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    },
  );

  function composedRuntime() {
    const query = vi.fn<PgQueryable["query"]>().mockResolvedValue({ rows: [] });
    const client = { query, release: vi.fn() };
    const pool = { query, connect: vi.fn(async () => client) };
    const runtime = createCatalogProviderSendRuntime(pool);
    const unexpected = async (): Promise<never> => {
      throw new Error("Unexpected synthetic event-store access");
    };
    const deps: CatalogRuntimeDeps = {
      providerSendRuntime: runtime,
      db: pool,
      eventStore: {
        appendToStream: unexpected,
        appendToStreams: unexpected,
        readStream: unexpected,
        readAll: unexpected,
      },
      checkpointStore: { loadCheckpoint: unexpected, saveCheckpoint: async () => undefined },
    };
    const transport = vi.fn(async () => Response.json({ synthetic: true }));
    const sourceObservations = createSourceObservationRuntime(
      deps,
      createCatalogItemRuntime(deps),
      createReferenceDataRuntime(deps),
    );
    const services = bindCatalogProviderServices(
      {
        ...sourceObservations,
        listTcgdexLanguages: async () => {
          await sendCatalogProviderRequest(
            "tcgdex",
            transport,
            "https://synthetic.invalid/languages",
            undefined,
            "discovery",
          );
          return [];
        },
      },
      runtime,
    );
    return { query, pool, runtime, deps, services, transport };
  }

  it.each([undefined, "false"])("disabled runtime %s composes without ledger access", async (flag) => {
    if (flag === undefined) vi.stubEnv("CATALOG_PROVIDER_SEND_WINDOW_ENABLED", undefined);
    else vi.stubEnv("CATALOG_PROVIDER_SEND_WINDOW_ENABLED", flag);
    try {
      const fixture = composedRuntime();
      expect(fixture.runtime).toBeNull();
      expect(await readProviderSendWindow(fixture.runtime)).toEqual({ state: "disabled" });
      await runProviderSendJob(fixture.deps, "synthetic-job", () => fixture.services.listTcgdexLanguages());
      expect(fixture.transport).toHaveBeenCalledTimes(1);
      expect(fixture.query).not.toHaveBeenCalled();
      expect(fixture.pool.connect).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("affirmative pristine-unarmed authority passes a composed service and null-bound job", async () => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "staging");
    vi.stubEnv("CATALOG_PROVIDER_SEND_WINDOW_ENABLED", "true");
    try {
      const fixture = composedRuntime();
      fixture.query.mockImplementation(async (sql) => ({
        rows: sql.includes("catalog_provider_send_authority")
          ? [{ window_id: null }]
          : sql.includes("catalog_provider_send_job_bindings")
            ? [{ window_id: null, phase: null, pass: null }]
            : [],
      }));
      expect(await readProviderSendWindow(fixture.runtime)).toEqual({ state: "unarmed" });
      await fixture.services.listTcgdexLanguages();
      await runProviderSendJob(fixture.deps, "synthetic-null-bound-job", () => fixture.services.listTcgdexLanguages());
      expect(fixture.transport).toHaveBeenCalledTimes(2);
      expect(fixture.query.mock.calls.some(([sql]) => sql.includes("catalog_provider_send_windows LIMIT 1"))).toBe(
        true,
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["authority-unavailable", "stale-binding", "terminal"] as const)(
    "composed %s refuses before transport",
    async (code) => {
      vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "staging");
      vi.stubEnv("CATALOG_PROVIDER_SEND_WINDOW_ENABLED", "true");
      try {
        const fixture = composedRuntime();
        if (!fixture.runtime) throw new Error("Synthetic staging runtime must be enabled");
        vi.spyOn(fixture.runtime.ledger, "bind").mockResolvedValue(binding);
        vi.spyOn(fixture.runtime.ledger, "stop").mockResolvedValue(undefined);
        if (code === "authority-unavailable") {
          vi.spyOn(fixture.runtime.ledger, "debit").mockRejectedValue(new Error("synthetic-private-driver-detail"));
        } else {
          vi.spyOn(fixture.runtime.ledger, "debit").mockResolvedValue({ state: "refused", code });
        }
        fixture.query.mockResolvedValue({
          rows: [{ window_id: binding.windowId, phase: binding.phase, pass: binding.pass }],
        });
        await expect(fixture.services.listTcgdexLanguages()).rejects.toThrow(code);
        await expect(
          runProviderSendJob(fixture.deps, "synthetic-retained-job", () => fixture.services.listTcgdexLanguages()),
        ).rejects.toThrow(code);
        expect(fixture.transport).not.toHaveBeenCalled();
        fixture.query.mockResolvedValue({ rows: [] });
        await expect(
          runProviderSendJob(fixture.deps, "synthetic-missing-binding", () => fixture.services.listTcgdexLanguages()),
        ).rejects.toThrow("stale-binding");
        expect(fixture.transport).not.toHaveBeenCalled();
        expect(() =>
          sendCatalogProviderRequest("tcgdex", fixture.transport, "https://synthetic.invalid/no-context"),
        ).toThrow("authority-unavailable");
        expect(fixture.transport).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("composed readout distinguishes armed, terminal, and unavailable without resetting authority", async () => {
    vi.stubEnv("DEPLOYMENT_ENVIRONMENT", "staging");
    vi.stubEnv("CATALOG_PROVIDER_SEND_WINDOW_ENABLED", "true");
    try {
      const fixture = composedRuntime();
      if (!fixture.runtime) throw new Error("Synthetic staging runtime must be enabled");
      const read = vi.spyOn(fixture.runtime.ledger, "read");
      for (const state of ["armed", "terminal"] as const) {
        read.mockResolvedValue({
          state,
          ...binding,
          armedAt: "2026-10-02T00:00:00.000Z",
          quota: providerSendPolicy.totalSends,
          used: 0,
          reserved: providerSendPolicy.totalSends,
          inFlight: 0,
          refusal: state === "terminal" ? "terminal" : null,
          quotas: [],
          members: [],
          attempts: [],
        });
        expect(await readProviderSendWindow(fixture.runtime)).toMatchObject({ state, windowId: binding.windowId });
      }
      read.mockRejectedValue(new Error("synthetic-private-driver-detail"));
      expect(await readProviderSendWindow(fixture.runtime)).toEqual({
        state: "unavailable",
        refusal: "authority-unavailable",
      });
      expect(fixture.query).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["Scryfall", createScryfallProviderAdapter],
    ["YGOPRODeck", createYgoprodeckProviderAdapter],
    ["YGOJSON", createYgojsonProviderAdapter],
    ["MTGJSON", createMtgjsonProviderAdapter],
    ["LorcanaJSON", createLorcanajsonProviderAdapter],
    ["Lorcast", createLorcastProviderAdapter],
  ] as const)("%s real adapter denies omitted Catalog binding before transport", async (_name, createAdapter) => {
    vi.stubEnv("CATALOG_PROVIDER_SEND_WINDOW_ENABLED", "true");
    try {
      const fetch = vi.fn();
      const adapter = createAdapter({ fetch });
      const units = await adapter.listIntegrationUnits();
      const unit = units[0];
      if (!unit) throw new Error("Synthetic adapter fixture has no unit");
      await expect(adapter.listOptions({ unitKey: unit.unitKey, optionKind: "sets" })).rejects.toThrow(
        "authority-unavailable",
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("bounded mirror/pack object retains STOP instead of a retryable transport error", async () => {
    vi.stubEnv("CATALOG_PROVIDER_SEND_WINDOW_ENABLED", "true");
    const fetch = vi.fn();
    try {
      await expect(
        readBoundedHttpObject({
          fetch,
          url: "https://synthetic.invalid/pack",
          maxBytes: 1024,
          deadlineMs: 1000,
          accept: "application/json",
        }),
      ).rejects.toThrow("authority-unavailable");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("STOP cannot be recovered as display-usable stale option cache", async () => {
    const now = new Date("2026-10-02T00:00:00.000Z");
    const request = {
      providerKey: "scrydex",
      profileVersion: "synthetic-v1",
      queryKind: "expansions",
      forceRefresh: true,
    };
    const cached = createCatalogProviderOptionQueryCacheRecord({ request, now, items: [] });
    const write = vi.fn();
    await expect(
      queryCatalogProviderIntegrationOptionsWithCache({
        request,
        now,
        cacheStore: { read: async () => cached, write },
        loadLive: async () => {
          throw new ProviderSendStoppedError("quota-exhausted");
        },
      }),
    ).rejects.toThrow("quota-exhausted");
    expect(write).not.toHaveBeenCalled();
  });
  it("keeps the FINAL's non-transferable quota arithmetic", () => {
    expect(providerSendPolicy).toEqual({
      preflightCard: 32,
      preflightUsage: 768,
      preflightOtherScrydex: 136,
      nonScrydex: 20_000,
      payloadMember: 256,
      additionalScrydex: 3_464,
      passes: 9,
      totalSends: 246_000,
      totalScrydex: 46_000,
    });
  });

  it("disabled admission does not read the ledger or change transport", async () => {
    const debit = vi.fn();
    const fetch = vi.fn(async () => Response.json({ synthetic: true }));
    const admission = createProviderSendAdmission({ enabled: false, ledger: ledger({ debit }) });
    await admission.send({ provider: "scrydex", category: "usage" }, fetch, "https://synthetic.invalid/usage");
    expect(debit).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://synthetic.invalid/usage", undefined);
  });

  it("authority read or commit ambiguity sends zero and exposes no driver detail", async () => {
    const fetch = vi.fn();
    const debit = vi.fn(async () => {
      throw new Error("synthetic secret driver detail");
    });
    const admission = createProviderSendAdmission({ enabled: true, ledger: ledger({ debit }) });
    await expect(
      admission.send({ provider: "scrydex", category: "usage" }, fetch, "https://synthetic.invalid/usage"),
    ).rejects.toEqual(new ProviderSendStoppedError("authority-unavailable"));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("an affirmative unarmed result permits the legacy send, not a missing result", async () => {
    const fetch = vi.fn(async () => Response.json({ synthetic: true }));
    const debit = vi.fn(async () => ({ state: "unarmed" as const }));
    const admission = createProviderSendAdmission({ enabled: true, ledger: ledger({ debit }) });
    await admission.send({ provider: "scrydex", category: "usage" }, fetch, "https://synthetic.invalid/usage");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]).toEqual(["https://synthetic.invalid/usage", undefined]);
  });

  it("C1 Pricing cannot inherit a Catalog binding or terminate its window", async () => {
    const debit = vi.fn(async () => ({ state: "refused" as const, code: "terminal" as const }));
    const stop = vi.fn();
    const admission = createProviderSendAdmission({ enabled: true, ledger: ledger({ debit, stop }) });
    const fetch = vi.fn(async () => Response.json({ synthetic: true }));
    const store = createInMemoryTcgplayerAutomationHttpConfigStore();
    const pricing = new TcgplayerAutomationDomainHttpClient("infiniteApi", "https://synthetic.invalid", store, {
      fetch,
      ownership: "pricing-non-window",
      sleep: async () => undefined,
    });
    await expect(runCatalogProviderWork(admission, () => pricing.get("/synthetic"))).resolves.toEqual({
      synthetic: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(debit).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("C1 legacy TCGplayer retries each debit immediately before its fetch", async () => {
    const order: string[] = [];
    let attempt = 0;
    const debit = vi.fn(async () => {
      order.push("debit");
      return { state: "admitted" as const, windowId: binding.windowId, sequence: ++attempt };
    });
    const fetch = vi.fn(async () => {
      order.push("fetch");
      return new Response("{}", { status: attempt === 1 ? 502 : 200 });
    });
    const admission = createProviderSendAdmission({ enabled: true, ledger: ledger({ debit }) });
    const client = new TcgplayerAutomationDomainHttpClient(
      "infiniteApi",
      "https://synthetic.invalid",
      createInMemoryTcgplayerAutomationHttpConfigStore({ maxRetries: 3 }),
      { fetch, sleep: async () => undefined },
    );
    await runCatalogProviderWork(admission, () => client.get("/synthetic"));
    expect(order).toEqual(["debit", "fetch", "debit", "fetch"]);
    expect(debit).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("C1 authenticated TCGplayer STOP survives custody redaction (durable=%s)", async (durable) => {
    const store = {
      ...createInMemoryTcgplayerAutomationHttpConfigStore({
        auth: { tcgAuthCookie: "SYNTHETIC_STORED_CREDENTIAL", userAgent: "synthetic" },
        maxRetries: 3,
      }),
    };
    const release = vi.fn(async () => undefined);
    if (durable) {
      store.admitDomainRequest = async () => ({
        granted: true,
        leaseId: "synthetic-lease",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        admittedAt: new Date().toISOString(),
        notBefore: new Date().toISOString(),
        epoch: 0,
      });
      store.renewDomainLease = async () => true;
      store.releaseDomainLease = release;
      store.recordDomainRateLimit = store.loadDomainConfig;
      store.recordDomainSuccess = store.loadDomainConfig;
    }
    const debit = vi.fn(async () => ({ state: "refused" as const, code: "quota-exhausted" as const }));
    const stop = vi.fn(async () => undefined);
    const admission = createProviderSendAdmission({ enabled: true, ledger: ledger({ debit, stop }) });
    const fetch = vi.fn();
    const client = new TcgplayerAutomationDomainHttpClient("infiniteApi", "https://synthetic.invalid", store, {
      fetch,
    });
    await expect(runCatalogProviderWork(admission, () => client.get("/synthetic"))).rejects.toMatchObject({
      name: "ProviderSendStoppedError",
      code: "quota-exhausted",
      message: "Catalog provider-send window stopped (quota-exhausted).",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(debit).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledExactlyOnceWith(binding.windowId, "quota-exhausted");
    expect(release).toHaveBeenCalledTimes(durable ? 1 : 0);
  });

  it("C1 durable TCGplayer refusal releases the pacing lease without fetch or retry", async () => {
    const events: string[] = [];
    const store = {
      ...createInMemoryTcgplayerAutomationHttpConfigStore(),
      admitDomainRequest: vi.fn(async () => {
        events.push("lease");
        return {
          granted: true,
          leaseId: "synthetic-lease",
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          admittedAt: new Date().toISOString(),
          notBefore: new Date().toISOString(),
          epoch: 0,
        };
      }),
      renewDomainLease: vi.fn(async () => true),
      releaseDomainLease: vi.fn(async () => {
        events.push("release");
      }),
      recordDomainRateLimit: vi.fn(),
      recordDomainSuccess: vi.fn(),
    };
    const debit = vi.fn(async () => {
      events.push("debit");
      return { state: "refused" as const, code: "quota-exhausted" as const };
    });
    const admission = createProviderSendAdmission({ enabled: true, ledger: ledger({ debit }) });
    const fetch = vi.fn();
    const client = new TcgplayerAutomationDomainHttpClient("infiniteApi", "https://synthetic.invalid", store, {
      fetch,
    });
    await expect(runCatalogProviderWork(admission, () => client.get("/synthetic"))).rejects.toThrow("quota-exhausted");
    expect(events).toEqual(["lease", "debit", "release"]);
    expect(fetch).not.toHaveBeenCalled();
    expect(debit).toHaveBeenCalledTimes(1);
  });

  it("redirects cannot create hidden sends and outstanding charges are retained", async () => {
    const stop = vi.fn();
    const settle = vi.fn();
    const fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "https://synthetic.invalid/next" } }),
    );
    const admission = createProviderSendAdmission({ enabled: true, ledger: ledger({ stop, settle }) });
    await expect(
      admission.send({ provider: "scrydex", category: "payload", binding }, fetch, "https://synthetic.invalid/cards"),
    ).rejects.toThrow("redirect-refused");
    expect(fetch).toHaveBeenCalledExactlyOnceWith("https://synthetic.invalid/cards", { redirect: "manual" });
    expect(stop).toHaveBeenCalledWith(binding.windowId, "redirect-refused");
    expect(settle).not.toHaveBeenCalled();
  });

  it.each(["empty", "duplicate", "infinite", "huge-total"])(
    "Scrydex %s continuation refuses quota+1 without publishing a complete cache",
    async (shape) => {
      let used = 0;
      const debit = vi.fn<ProviderSendLedger["debit"]>(async () =>
        ++used <= 32
          ? { state: "admitted" as const, windowId: binding.windowId, sequence: used }
          : { state: "refused" as const, code: "quota-exhausted" as const },
      );
      const admission = createProviderSendAdmission({ enabled: true, ledger: ledger({ debit }) });
      const write = vi.fn();
      const fetch = vi.fn(async () =>
        Response.json({
          data:
            shape === "empty"
              ? []
              : [{ id: shape === "duplicate" ? "synthetic-same" : `synthetic-${used}`, name: "Synthetic card" }],
          ...(shape === "huge-total"
            ? { total_count: 1_000_000, page_size: 1, count: 1, page: used }
            : { next_page: `/lorcana/v1/cards?page=${used + 1}` }),
        }),
      );
      const registry = new ProviderAdapterRegistry([
        createScrydexOnePieceProviderAdapter({
          credentials: { apiKey: "synthetic-key", teamId: "synthetic-team" },
          lorcanaBaseUrl: "https://synthetic.invalid/lorcana/v1",
          fetch,
          cacheStore: { read: async () => null, write },
        }),
      ]);
      await expect(
        runCatalogProviderWork(admission, () =>
          registry.require("scrydex").listOptions({
            unitKey: SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
            optionKind: "cards",
            parentValues: { expansionId: "synthetic-one", language: "en" },
          }),
        ),
      ).rejects.toThrow("quota-exhausted");
      expect(fetch).toHaveBeenCalledTimes(32);
      expect(debit).toHaveBeenCalledTimes(33);
      expect(debit.mock.calls.every(([request]) => request.category === "card-force")).toBe(true);
      expect(write).not.toHaveBeenCalled();
    },
  );
});
