import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapContextDatabase, drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import type { JsonObject } from "@chase-sets/primitives/json";
import { module as catalogModule } from "../../../index";
import type { ReferenceRecordId } from "../../../ids";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import { localizedTextMapFromEnglish, type CatalogValue } from "../../../support/runtime-support/common";
import { providerScopeMappingStreamId } from "../../provider-scope-mapping/domain/domain";
import { buildProviderScopeMappingCandidate } from "../../provider-scope-mapping/domain/mapping";
import { ProviderAdapterRegistry } from "../../source-observations/api/provider-adapters/registry";
import { catalogProviderIntegrationProfileVersions } from "../../source-observations/api/provider-integration-profiles";
import { queryProviderIntegrationOptions } from "../../source-observations/api/providers/provider-option-queries";
import { createYgojsonProviderAdapter } from "../../source-observations/api/providers/ygojson/adapter";
import { createYgoprodeckProviderAdapter } from "../../source-observations/api/providers/ygoprodeck/adapter";
import { acceptedReferenceRecordIdForProposal } from "./proposal-acceptance";
import type { ProviderRefreshCadenceConfig } from "./provider-refresh-cadence";
import { providerScopeDiscoveryRoutes } from "./route";
import { createProviderScopeDiscoveryRuntime, type ProviderScopeDiscoveryPorts } from "./runtime";
import {
  getCanonicalScopeRecordProposal,
  proposeCanonicalScopeRecord,
  type CanonicalScopeRecordProposalRecord,
} from "./scope-record-proposal-store";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = databaseBaseUrl ? describe : describe.skip;
const TEST_CONTEXT = {
  tenantId: "tnt_identity",
  audit: { performedByUserId: "usr_identity_system", forAccountId: "acc_identity_system" },
} as unknown as EventStoreContext;
const fixtureRoot = new URL("../../source-observations/api/__fixtures__/", import.meta.url);
const YGOPRODECK_UNIT = "ygoprodeck:yugioh:single-card:reference-data";
const YGOJSON_UNIT = "ygojson:yugioh:set:reference-data";
const TCGDEX_UNIT = "tcgdex:pokemon:single-card:source-observation-import";
const PRODUCT_LINE = {
  yugioh: "ref_test_yugioh_product_line",
  magic: "ref_test_magic_product_line",
  pokemon: "ref_test_pokemon_product_line",
} as const;
const yugiohPublisherCadence: readonly ProviderRefreshCadenceConfig[] = ["ygoprodeck", "ygojson"].map(
  (providerKey) => ({
    providerKey,
    scheduleEnabled: false,
    manualOnly: true,
    creditAware: false,
    intervalMs: 24 * 60 * 60 * 1000,
    reason: "test",
  }),
);

type YgoprodeckSet = Readonly<{ set_name: string; set_code: string; num_of_cards: number; tcg_date: string }>;
type AcceptResponse = Readonly<{ status: number; body: JsonObject }>;

describeDb("canonical Scope Record proposal acceptance db", () => {
  let pool: PgTransactionalPool;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "catalog_scope_proposal_accept");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
  });

  afterAll(async () => closeMultiContextTestPools({ catalog: pool }));

  async function buildHarness(input: { permissions?: readonly string[] } = {}) {
    const services = createCatalogServices(pool);
    const deps = {
      db: pool,
      eventStore: createPostgresEventStore({ pool }),
      checkpointStore: createPostgresProjectionStore({ db: pool }),
    } as const;
    const sets: { ygoprodeck: readonly YgoprodeckSet[]; ygojson: readonly unknown[] } = {
      ygoprodeck: [],
      ygojson: [],
    };
    const fetch = (async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.endsWith("/cardsets.php")) {
        return new Response(JSON.stringify(sets.ygoprodeck));
      }
      if (href.endsWith("/aggregate/sets.json")) {
        return new Response(JSON.stringify(sets.ygojson));
      }
      throw new Error(`Unexpected provider request in test: ${href}`);
    }) as typeof globalThis.fetch;
    const registry = new ProviderAdapterRegistry([
      createYgoprodeckProviderAdapter({ fetch }),
      createYgojsonProviderAdapter({ fetch }),
    ]);

    // One injected crash per queued command type, raised before the command reaches the store.
    const crashes: string[] = [];
    const crashBefore = (commandType: string) => {
      const index = crashes.indexOf(commandType);
      if (index >= 0) {
        crashes.splice(index, 1);
        throw new Error(`Injected crash before ${commandType}.`);
      }
    };
    const ports: ProviderScopeDiscoveryPorts = {
      listProfileVersions: async () =>
        catalogProviderIntegrationProfileVersions.filter((version) =>
          ["ygoprodeck", "ygojson"].includes(version.providerKey),
        ),
      queryIntegrationOptions: (query) => queryProviderIntegrationOptions(query, pool, null, undefined, registry),
      providerScopeMappingCommandHandler: async (command) => {
        crashBefore(command.command.type);
        return services.providerScopeMappings.commandHandler(command);
      },
      referenceRecordCommandHandler: async (command) => {
        crashBefore(command.command.type);
        return services.referenceData.referenceRecordCommandHandler(command);
      },
    };
    const runtime = createProviderScopeDiscoveryRuntime(deps, ports, yugiohPublisherCadence);

    const app = new Hono<CatalogAuthoringEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", { permissions: [...(input.permissions ?? ["catalog.view", "catalog.manage"])] });
      c.set("context", TEST_CONTEXT);
      await next();
    });
    app.route("/", providerScopeDiscoveryRoutes(runtime));

    const drain = () => drainLocalProjectionHandlerSets("catalog", pool, services.projectors);

    return {
      services,
      runtime,
      drain,
      crashes,
      async refreshYgoprodeck(next: readonly YgoprodeckSet[]) {
        sets.ygoprodeck = next;
        const result = await runtime.runProviderRefreshNow({ providerKey: "ygoprodeck", context: TEST_CONTEXT });
        expect(result.status).toBe("succeeded");
      },
      async refreshYgojson(next: readonly unknown[]) {
        sets.ygojson = next;
        const result = await runtime.runProviderRefreshNow({ providerKey: "ygojson", context: TEST_CONTEXT });
        expect(result.status).toBe("succeeded");
      },
      async accept(proposalId: string, body: unknown): Promise<AcceptResponse> {
        const response = await app.request(`/canonical-scope-record-proposals/${proposalId}/accept`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await response.text();
        return { status: response.status, body: text.startsWith("{") ? (JSON.parse(text) as JsonObject) : {} };
      },
      async listProposals(): Promise<readonly CanonicalScopeRecordProposalRecord[]> {
        const response = await app.request("/canonical-scope-record-proposals");
        expect(response.status).toBe(200);
        return ((await response.json()) as { items: CanonicalScopeRecordProposalRecord[] }).items;
      },
      async authorScopeRecord(record: {
        id: string;
        typeKey: string;
        key: string;
        name: string;
        parent?: string;
        attributes?: Record<string, CatalogValue>;
      }) {
        const streamId = `catalog.reference-record-${record.id}`;
        await services.referenceData.referenceRecordCommandHandler({
          streamId,
          command: {
            type: "CreateReferenceRecord",
            referenceRecordId: record.id as ReferenceRecordId,
            typeKey: record.typeKey,
            key: record.key,
            name: localizedTextMapFromEnglish(record.name),
            attributes: record.attributes ?? {},
            relationships: record.parent
              ? [{ relationshipType: "part-of", referenceId: record.parent as ReferenceRecordId }]
              : [],
          },
          context: TEST_CONTEXT,
        });
        await services.referenceData.referenceRecordCommandHandler({
          streamId,
          command: { type: "PublishReferenceRecord" },
          context: TEST_CONTEXT,
        });
        await drain();
      },
      async authorProductLine(domain: keyof typeof PRODUCT_LINE) {
        const contract = {
          yugioh: { key: "yu-gi-oh-official-card-game", name: "Yu-Gi-Oh! Official Card Game" },
          magic: { key: "magic-the-gathering", name: "Magic: The Gathering" },
          pokemon: { key: "pokemon-trading-card-game", name: "Pokemon Trading Card Game" },
        }[domain];
        await this.authorScopeRecord({ id: PRODUCT_LINE[domain], typeKey: "product-line", ...contract });
      },
    };
  }

  async function ygoprodeckSet(): Promise<YgoprodeckSet> {
    return (await fixture("ygoprodeck-yugioh-set-reference/normal.json")).set as YgoprodeckSet;
  }

  async function onlyProposal(harness: Awaited<ReturnType<typeof buildHarness>>) {
    const proposals = await harness.listProposals();
    expect(proposals).toHaveLength(1);
    return proposals[0]!;
  }

  async function referenceRecordEvents(): Promise<readonly { stream_id: string; event_type: string }[]> {
    const result = await pool.query<{ stream_id: string; event_type: string }>(
      `SELECT stream_id, event_type
       FROM event_store_events
       WHERE stream_id LIKE 'catalog.reference-record-%'
       ORDER BY stream_id ASC, stream_version ASC`,
    );
    return result.rows;
  }

  async function streamEvents(streamId: string): Promise<readonly { event_type: string; payload: JsonObject }[]> {
    const result = await pool.query<{ event_type: string; payload: JsonObject }>(
      "SELECT event_type, payload FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version ASC",
      [streamId],
    );
    return result.rows;
  }

  async function activeScopeRecords(productDomain: string, scopeKind: string) {
    const result = await pool.query<{
      scope_record_id: string;
      reference_record_key: string;
      official_set_code: string | null;
      release_date: string | null;
      language_editions: string[];
      parent_scope_record_id: string | null;
    }>(
      `SELECT scope_record_id, reference_record_key, official_set_code, release_date::text AS release_date,
              language_editions, parent_scope_record_id
       FROM catalog_scope_records
       WHERE product_domain = $1 AND scope_kind = $2 AND lifecycle_status = 'active'
       ORDER BY scope_record_id ASC`,
      [productDomain, scopeKind],
    );
    return result.rows;
  }

  describe("AC1 create mode", () => {
    it("creates, publishes and projects exactly one active Scope Record, and a repeat accept appends nothing", async () => {
      const harness = await buildHarness();
      await harness.authorProductLine("yugioh");
      await harness.refreshYgoprodeck([await ygoprodeckSet()]);
      const proposal = await onlyProposal(harness);
      const acceptedId = acceptedReferenceRecordIdForProposal(proposal.proposalId);
      const eventsBefore = await referenceRecordEvents();

      const accepted = await harness.accept(proposal.proposalId, { create: {} });

      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({
        mode: "create",
        scopeRecordId: acceptedId,
        referenceRecord: { referenceRecordId: acceptedId, created: true, published: true },
        proposal: { reviewStatus: "accepted", acceptedScopeRecordId: acceptedId },
      });
      const created = await streamEvents(`catalog.reference-record-${acceptedId}`);
      expect(created.map((event) => event.event_type)).toEqual([
        "catalog.reference-record.created",
        "catalog.reference-record.published",
      ]);
      expect(created[0]!.payload).toMatchObject({
        referenceRecordId: acceptedId,
        typeKey: "set",
        key: "sdy-en",
        attributes: { "release-date": "2002-03-29", "official-set-code": "SDY", "language-editions": ["en"] },
        relationships: [{ relationshipType: "part-of", referenceId: PRODUCT_LINE.yugioh }],
      });

      await harness.drain();
      expect(await activeScopeRecords("yugioh", "set")).toEqual([
        {
          scope_record_id: acceptedId,
          reference_record_key: "sdy-en",
          official_set_code: "SDY",
          release_date: "2002-03-29",
          language_editions: ["en"],
          parent_scope_record_id: PRODUCT_LINE.yugioh,
        },
      ]);
      expect(await harness.listProposals()).toEqual([
        expect.objectContaining({ reviewStatus: "accepted", acceptedScopeRecordId: acceptedId }),
      ]);

      const repeated = await harness.accept(proposal.proposalId, { create: {} });
      expect(repeated.status).toBe(200);
      expect(repeated.body).toMatchObject({
        scopeRecordId: acceptedId,
        referenceRecord: { referenceRecordId: acceptedId, created: false, published: false },
      });
      expect(await referenceRecordEvents()).toHaveLength(eventsBefore.length + 2);
      await harness.drain();
      expect(await activeScopeRecords("yugioh", "set")).toHaveLength(1);
    });

    it("resumes a crash between create and publish with the same id and no second create", async () => {
      const harness = await buildHarness();
      await harness.authorProductLine("yugioh");
      await harness.refreshYgoprodeck([await ygoprodeckSet()]);
      const proposal = await onlyProposal(harness);
      const acceptedId = acceptedReferenceRecordIdForProposal(proposal.proposalId);
      harness.crashes.push("PublishReferenceRecord");

      const crashed = await harness.accept(proposal.proposalId, { create: {} });

      expect(crashed.status).toBe(500);
      expect((await streamEvents(`catalog.reference-record-${acceptedId}`)).map((event) => event.event_type)).toEqual([
        "catalog.reference-record.created",
      ]);
      expect(await getCanonicalScopeRecordProposal(pool, proposal.proposalId)).toMatchObject({
        reviewStatus: "proposed",
        acceptedScopeRecordId: null,
      });

      await harness.drain();
      const resumed = await harness.accept(proposal.proposalId, { create: {} });

      expect(resumed.status).toBe(200);
      expect(resumed.body).toMatchObject({
        scopeRecordId: acceptedId,
        referenceRecord: { referenceRecordId: acceptedId, created: false, published: true },
      });
      expect((await streamEvents(`catalog.reference-record-${acceptedId}`)).map((event) => event.event_type)).toEqual([
        "catalog.reference-record.created",
        "catalog.reference-record.published",
      ]);
      await harness.drain();
      expect((await activeScopeRecords("yugioh", "set")).map((record) => record.scope_record_id)).toEqual([acceptedId]);
    });

    it("refuses a resumed Reference Record history that is not the record this proposal plans", async () => {
      const harness = await buildHarness();
      await harness.authorProductLine("yugioh");
      await harness.refreshYgoprodeck([await ygoprodeckSet()]);
      const proposal = await onlyProposal(harness);
      const acceptedId = acceptedReferenceRecordIdForProposal(proposal.proposalId);
      await harness.services.referenceData.referenceRecordCommandHandler({
        streamId: `catalog.reference-record-${acceptedId}`,
        command: {
          type: "CreateReferenceRecord",
          referenceRecordId: acceptedId,
          typeKey: "set",
          key: "a-different-key",
          name: localizedTextMapFromEnglish("Starter Deck: Yugi"),
          relationships: [{ relationshipType: "part-of", referenceId: PRODUCT_LINE.yugioh as ReferenceRecordId }],
        },
        context: TEST_CONTEXT,
      });
      const eventsBefore = await referenceRecordEvents();

      const refused = await harness.accept(proposal.proposalId, { create: {} });

      expect(refused).toMatchObject({
        status: 409,
        body: {
          error: {
            code: "scope_record_proposal_reference_history_conflict",
            details: { referenceRecordId: acceptedId },
          },
        },
      });
      expect(await referenceRecordEvents()).toEqual(eventsBefore);
      expect(await getCanonicalScopeRecordProposal(pool, proposal.proposalId)).toMatchObject({
        reviewStatus: "proposed",
      });
    });
  });

  describe("AC2 bind mode and refusals", () => {
    it("refuses create beside a matching Scope Record, then binds onto it without a Reference Record event", async () => {
      const harness = await buildHarness();
      await harness.authorProductLine("yugioh");
      await harness.refreshYgoprodeck([await ygoprodeckSet()]);
      const proposal = await onlyProposal(harness);
      await harness.authorScopeRecord({
        id: "ref_test_promoted_sdy",
        typeKey: "set",
        key: "starter-deck-yugi",
        name: "Starter Deck: Yugi",
        parent: PRODUCT_LINE.yugioh,
        attributes: { "release-date": "2002-03-29", "official-set-code": "SDY", "language-editions": ["en"] },
      });
      const eventsBefore = await referenceRecordEvents();

      const refused = await harness.accept(proposal.proposalId, { create: {} });

      expect(refused).toMatchObject({
        status: 409,
        body: {
          error: {
            code: "scope_record_proposal_candidates_exist",
            details: {
              candidates: [
                {
                  scopeRecordId: "ref_test_promoted_sdy",
                  name: "Starter Deck: Yugi",
                  languageEditions: ["en"],
                  lifecycleStatus: "active",
                  matchedBy: "identity",
                },
              ],
            },
          },
        },
      });
      expect(await referenceRecordEvents()).toEqual(eventsBefore);

      const bound = await harness.accept(proposal.proposalId, { bind: { scopeRecordId: "ref_test_promoted_sdy" } });

      expect(bound.status).toBe(200);
      expect(bound.body).toMatchObject({
        mode: "bind",
        scopeRecordId: "ref_test_promoted_sdy",
        referenceRecord: null,
        proposal: { reviewStatus: "accepted", acceptedScopeRecordId: "ref_test_promoted_sdy" },
        mappings: { repointed: [{ providerKey: "ygoprodeck", unitKey: YGOPRODECK_UNIT, retiredAs: "rejected" }] },
      });
      expect(await referenceRecordEvents()).toEqual(eventsBefore);
      await harness.drain();
      expect((await activeScopeRecords("yugioh", "set")).map((record) => record.scope_record_id)).toEqual([
        "ref_test_promoted_sdy",
      ]);
    });

    it("refuses bind targets from another domain, kind or language edition, and a missing target", async () => {
      const harness = await buildHarness();
      await harness.authorProductLine("yugioh");
      await harness.authorProductLine("magic");
      await harness.refreshYgoprodeck([await ygoprodeckSet()]);
      const proposal = await onlyProposal(harness);
      await harness.authorScopeRecord({
        id: "ref_test_magic_set",
        typeKey: "set",
        key: "starter-deck-yugi",
        name: "Starter Deck: Yugi",
        parent: PRODUCT_LINE.magic,
        attributes: { "release-date": "2002-03-29", "official-set-code": "SDY", "language-editions": ["en"] },
      });
      await harness.authorScopeRecord({
        id: "ref_test_yugioh_series",
        typeKey: "series",
        key: "starter-decks",
        name: "Starter Deck: Yugi",
        parent: PRODUCT_LINE.yugioh,
      });
      await harness.authorScopeRecord({
        id: "ref_test_yugioh_japanese_set",
        typeKey: "set",
        key: "sdy-ja",
        name: "Starter Deck: Yugi",
        parent: PRODUCT_LINE.yugioh,
        attributes: { "release-date": "2001-01-01", "official-set-code": "SDY", "language-editions": ["ja"] },
      });
      const eventsBefore = await referenceRecordEvents();

      for (const [scopeRecordId, reason] of [
        ["ref_test_magic_set", "product-domain"],
        ["ref_test_yugioh_series", "scope-kind"],
        ["ref_test_yugioh_japanese_set", "language-editions"],
        ["ref_test_missing_set", "missing"],
      ] as const) {
        expect(await harness.accept(proposal.proposalId, { bind: { scopeRecordId } })).toMatchObject({
          status: 422,
          body: {
            error: {
              code: "scope_record_proposal_bind_target_ineligible",
              details: { proposalId: proposal.proposalId, scopeRecordId, reason },
            },
          },
        });
      }
      expect(await referenceRecordEvents()).toEqual(eventsBefore);
      expect(await getCanonicalScopeRecordProposal(pool, proposal.proposalId)).toMatchObject({
        reviewStatus: "proposed",
        acceptedScopeRecordId: null,
      });
    });

    it("refuses a rejected proposal and one accepted onto a different target", async () => {
      const harness = await buildHarness();
      await harness.authorProductLine("yugioh");
      await harness.refreshYgoprodeck([
        await ygoprodeckSet(),
        { set_name: "Legend of Blue Eyes White Dragon", set_code: "LOB", num_of_cards: 126, tcg_date: "2002-03-08" },
      ]);
      const proposals = await harness.listProposals();
      const sdy = proposals.find((proposal) => proposal.officialSetCode === "SDY")!;
      const lob = proposals.find((proposal) => proposal.officialSetCode === "LOB")!;
      for (const [id, key, name, code] of [
        ["ref_test_promoted_sdy", "starter-deck-yugi", "Starter Deck: Yugi", "SDY"],
        ["ref_test_other_set", "metal-raiders", "Metal Raiders", "MRD"],
      ] as const) {
        await harness.authorScopeRecord({
          id,
          typeKey: "set",
          key,
          name,
          parent: PRODUCT_LINE.yugioh,
          attributes: { "release-date": "2002-06-26", "official-set-code": code, "language-editions": ["en"] },
        });
      }
      expect((await harness.accept(sdy.proposalId, { bind: { scopeRecordId: "ref_test_promoted_sdy" } })).status).toBe(
        200,
      );
      // No rejection command exists for proposals (out of scope), so the fixture sets the stored status.
      await pool.query("UPDATE catalog_scope_record_proposals SET review_status = 'rejected' WHERE proposal_id = $1", [
        lob.proposalId,
      ]);
      const eventsBefore = await referenceRecordEvents();

      for (const body of [{ bind: { scopeRecordId: "ref_test_other_set" } }, { create: {} }]) {
        expect(await harness.accept(sdy.proposalId, body)).toMatchObject({
          status: 409,
          body: {
            error: {
              code: "scope_record_proposal_accepted_elsewhere",
              details: { proposalId: sdy.proposalId, acceptedScopeRecordId: "ref_test_promoted_sdy" },
            },
          },
        });
        expect(await harness.accept(lob.proposalId, body)).toMatchObject({
          status: 409,
          body: { error: { code: "scope_record_proposal_rejected", details: { proposalId: lob.proposalId } } },
        });
      }
      expect(await referenceRecordEvents()).toEqual(eventsBefore);
      expect(await getCanonicalScopeRecordProposal(pool, sdy.proposalId)).toMatchObject({
        reviewStatus: "accepted",
        acceptedScopeRecordId: "ref_test_promoted_sdy",
      });
    });

    it("refuses a missing contract product line by its key even when other product lines exist", async () => {
      const harness = await buildHarness();
      await harness.authorProductLine("magic");
      await harness.authorScopeRecord({
        id: "ref_test_yugioh_other_product_line",
        typeKey: "product-line",
        key: "yu-gi-oh-rush-duel",
        name: "Yu-Gi-Oh! Rush Duel",
        attributes: { "product-domain": "yugioh" },
      });
      await harness.refreshYgoprodeck([await ygoprodeckSet()]);
      const proposal = await onlyProposal(harness);
      const eventsBefore = await referenceRecordEvents();

      expect(await harness.accept(proposal.proposalId, { create: {} })).toMatchObject({
        status: 409,
        body: {
          error: {
            code: "scope_record_proposal_product_line_missing",
            details: { productDomain: "yugioh", referenceRecordKey: "yu-gi-oh-official-card-game" },
          },
        },
      });
      expect(await referenceRecordEvents()).toEqual(eventsBefore);
    });

    it("fills only fields the proposal lacks and names a leaf attribute still missing", async () => {
      const harness = await buildHarness();
      await harness.authorProductLine("yugioh");
      await harness.refreshYgojson([(await fixture("ygojson-yugioh-set-reference-data/normal.json")).set]);
      const proposal = await onlyProposal(harness);
      expect(proposal).toMatchObject({ officialSetCode: null, releaseDate: "2002-03-08" });
      const eventsBefore = await referenceRecordEvents();

      expect(await harness.accept(proposal.proposalId, { create: {} })).toMatchObject({
        status: 422,
        body: {
          error: { code: "scope_record_proposal_attribute_missing", details: { attributeKey: "official-set-code" } },
        },
      });
      expect(
        await harness.accept(proposal.proposalId, { create: { officialSetCode: "LOB", releaseDate: "2002-03-09" } }),
      ).toMatchObject({
        status: 422,
        body: { error: { code: "scope_record_proposal_field_not_fillable", details: { field: "releaseDate" } } },
      });
      expect(await referenceRecordEvents()).toEqual(eventsBefore);

      const created = await harness.accept(proposal.proposalId, {
        create: { officialSetCode: "LOB", releaseDate: "2002-03-08" },
      });

      expect(created.status).toBe(200);
      await harness.drain();
      expect(await activeScopeRecords("yugioh", "set")).toEqual([
        expect.objectContaining({
          scope_record_id: acceptedReferenceRecordIdForProposal(proposal.proposalId),
          reference_record_key: "lob-en",
          official_set_code: "LOB",
          release_date: "2002-03-08",
          language_editions: ["en"],
        }),
      ]);
    });

    it("refuses a key another Reference Record of the type already holds", async () => {
      const harness = await buildHarness();
      await harness.authorProductLine("yugioh");
      await harness.authorProductLine("magic");
      await harness.refreshYgoprodeck([await ygoprodeckSet()]);
      const proposal = await onlyProposal(harness);
      await harness.authorScopeRecord({
        id: "ref_test_magic_key_holder",
        typeKey: "set",
        key: "sdy-en",
        name: "Some Magic Set",
        parent: PRODUCT_LINE.magic,
        attributes: { "release-date": "2001-01-01", "official-set-code": "SMS", "language-editions": ["en"] },
      });
      const eventsBefore = await referenceRecordEvents();

      expect(await harness.accept(proposal.proposalId, { create: {} })).toMatchObject({
        status: 409,
        body: {
          error: {
            code: "scope_record_proposal_key_unavailable",
            details: { referenceRecordKey: "sdy-en", reason: "taken", referenceRecordId: "ref_test_magic_key_holder" },
          },
        },
      });
      expect(await referenceRecordEvents()).toEqual(eventsBefore);
    });

    it("creates a ja XY2 expansion beside the en xy2 record, and two Japanese-script expansions with different codes", async () => {
      const harness = await buildHarness();
      await harness.authorProductLine("pokemon");
      await harness.authorScopeRecord({
        id: "ref_test_flashfire_en",
        typeKey: "expansion",
        key: "xy2",
        name: "Flashfire",
        parent: PRODUCT_LINE.pokemon,
        attributes: { "release-date": "2014-05-07", "official-set-code": "FLF", "language-editions": ["en"] },
      });
      const japaneseSets = (await fixture("tcgdex/ja-sets.json")) as unknown as readonly { id: string; name: string }[];
      const releaseDates: Record<string, string> = { XY2: "2013-12-06", SV3: "2023-07-28", SV3a: "2023-09-22" };

      for (const [code, key] of [
        ["XY2", "xy2-ja"],
        ["SV3", "sv3-ja"],
        ["SV3a", "sv3a-ja"],
      ] as const) {
        const recorded = japaneseSets.find((set) => set.id === code)!;
        const proposal = await proposeJapaneseExpansion(recorded);
        expect(proposal.normalizedName).toBe("");

        const created = await harness.accept(proposal.proposalId, { create: { releaseDate: releaseDates[code] } });

        expect(created).toMatchObject({ status: 200, body: { referenceRecord: { created: true, published: true } } });
        await harness.drain();
        expect(await activeScopeRecords("pokemon", "expansion")).toContainEqual(
          expect.objectContaining({
            scope_record_id: acceptedReferenceRecordIdForProposal(proposal.proposalId),
            reference_record_key: key,
            official_set_code: code,
            language_editions: ["ja"],
          }),
        );
      }
      expect(await activeScopeRecords("pokemon", "expansion")).toHaveLength(4);
    });

    it("keeps an accepted proposal's status and target when the same observation is proposed again", async () => {
      const harness = await buildHarness();
      await harness.authorProductLine("yugioh");
      const set = await ygoprodeckSet();
      await harness.refreshYgoprodeck([set]);
      const proposal = await onlyProposal(harness);
      expect((await harness.accept(proposal.proposalId, { create: {} })).status).toBe(200);

      const reproposed = await proposeCanonicalScopeRecord(pool, {
        productDomain: "yugioh",
        scopeKind: "set",
        name: set.set_name,
        officialSetCode: set.set_code,
        releaseDate: set.tcg_date,
        languageEditions: ["en"],
        parentExternalIds: [],
        evidence: { "observation:later": { providerKey: "ygoprodeck", unitKey: YGOPRODECK_UNIT } },
      });

      expect(reproposed).toMatchObject({
        proposalId: proposal.proposalId,
        reviewStatus: "accepted",
        acceptedScopeRecordId: acceptedReferenceRecordIdForProposal(proposal.proposalId),
      });
      expect(reproposed.evidence).toEqual(proposal.evidence);
    });

    it("keeps a mapping the bind target already holds for the unit and reports the conflict", async () => {
      const harness = await buildHarness();
      await harness.authorProductLine("yugioh");
      await harness.refreshYgoprodeck([await ygoprodeckSet()]);
      const proposal = await onlyProposal(harness);
      await harness.authorScopeRecord({
        id: "ref_test_promoted_sdy",
        typeKey: "set",
        key: "starter-deck-yugi",
        name: "Starter Deck: Yugi",
        parent: PRODUCT_LINE.yugioh,
        attributes: { "release-date": "2002-03-29", "official-set-code": "SDY", "language-editions": ["en"] },
      });
      const kept = buildProviderScopeMappingCandidate({
        scopeRecordId: "ref_test_promoted_sdy",
        providerKey: "ygoprodeck",
        unitKey: YGOPRODECK_UNIT,
        coordinates: { productLineId: null, seriesId: null, setId: null, setName: "Starter Deck Yugi", language: null },
        confidence: "candidate",
        reviewStatus: "proposed",
        provenance: { source: "operator", sourceId: "hand-proposed" },
        evidence: {},
      });
      const keptStreamId = providerScopeMappingStreamId({
        scopeRecordId: "ref_test_promoted_sdy",
        providerKey: "ygoprodeck",
        unitKey: YGOPRODECK_UNIT,
      });
      await harness.services.providerScopeMappings.commandHandler({
        streamId: keptStreamId,
        command: { type: "ProposeProviderScopeMapping", candidate: kept, actor: "user:test" },
        context: TEST_CONTEXT,
      });
      const sourceStreamId = providerScopeMappingStreamId({
        scopeRecordId: proposal.scopeRecordId,
        providerKey: "ygoprodeck",
        unitKey: YGOPRODECK_UNIT,
      });

      const bound = await harness.accept(proposal.proposalId, { bind: { scopeRecordId: "ref_test_promoted_sdy" } });

      expect(bound.status).toBe(200);
      expect(bound.body).toMatchObject({
        mappings: {
          repointed: [],
          conflicts: [
            {
              providerKey: "ygoprodeck",
              unitKey: YGOPRODECK_UNIT,
              keptMappingId: kept.mappingId,
              keptReviewStatus: "proposed",
              retiredAs: "rejected",
            },
          ],
        },
      });
      expect((await streamEvents(keptStreamId)).map((event) => event.event_type)).toEqual([
        "catalog.provider-scope-mapping.proposed",
      ]);
      const source = await streamEvents(sourceStreamId);
      expect(source.map((event) => event.event_type)).toEqual([
        "catalog.provider-scope-mapping.proposed",
        "catalog.provider-scope-mapping.rejected",
      ]);
      expect(source[1]!.payload.reason).toContain("ref_test_promoted_sdy");
    });

    it("guards the route: manage permission, exactly one mode, and a known proposal", async () => {
      const viewer = await buildHarness({ permissions: ["catalog.view"] });
      expect((await viewer.accept("anything", { create: {} })).status).toBe(403);

      const harness = await buildHarness();
      await harness.authorProductLine("yugioh");
      await harness.refreshYgoprodeck([await ygoprodeckSet()]);
      const proposal = await onlyProposal(harness);
      for (const body of [
        {},
        { create: {}, bind: { scopeRecordId: "ref_test" } },
        { bind: {} },
        { create: { releaseDate: "2002-02-30" } },
        { create: { name: "Renamed" } },
      ]) {
        expect(await harness.accept(proposal.proposalId, body)).toMatchObject({
          status: 400,
          body: { error: { code: "scope_record_proposal_accept_invalid_request" } },
        });
      }
      expect(await harness.accept("missing-proposal", { create: {} })).toMatchObject({
        status: 404,
        body: { error: { code: "scope_record_proposal_not_found" } },
      });
      expect(await referenceRecordEvents()).toHaveLength(2);
    });
  });

  async function proposeJapaneseExpansion(recorded: { id: string; name: string }) {
    // Japanese discovery is #10061; until then a `ja` proposal carries the
    // recorded TCGdex id as its code, the shape that slice will emit.
    return proposeCanonicalScopeRecord(pool, {
      productDomain: "pokemon",
      scopeKind: "expansion",
      name: recorded.name,
      officialSetCode: recorded.id,
      releaseDate: null,
      languageEditions: ["ja"],
      parentExternalIds: [],
      evidence: {
        [`observation:tcgdex-ja-${recorded.id}`]: {
          providerKey: "tcgdex",
          unitKey: TCGDEX_UNIT,
          externalId: recorded.id,
          label: recorded.name,
          languageCode: "ja",
          parents: [],
          profileKey: "pokemon-tcg",
          scanId: "recorded-fixture",
        },
      },
    });
  }
});

async function fixture(path: string): Promise<JsonObject> {
  return JSON.parse(await readFile(new URL(path, fixtureRoot), "utf8")) as JsonObject;
}
