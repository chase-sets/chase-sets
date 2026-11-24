import { afterEach, describe, expect, it, vi } from "vitest";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { queryVocabularyPolicy } from "../features/search/domain/query-vocabulary-policy";
import { createDiscoveryServices } from "../support/runtime-support/services";

// Hoisted by Vitest; hands the composed Discovery services an in-memory event store.
const composition = vi.hoisted(() => ({ eventStore: undefined as EventStore | undefined }));
vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/event-core-postgres")>()),
  createPostgresEventStore: () => composition.eventStore,
}));

const policyKey = "discovery.query-vocabulary";
const context = {
  tenantId: "tnt_discovery" as never,
  audit: { performedByUserId: "usr_operator" as never, forAccountId: "acc_operator" as never },
};

// Serves one active Query Vocabulary document from the Discovery database and one Search Index row.
function discoveryDatabase() {
  return vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    const rows =
      sql.includes("FROM platform_policy_documents") && values.includes(policyKey)
        ? [
            {
              document_id: "pol_query_vocabulary",
              policy_key: policyKey,
              context_name: "discovery",
              schema_summary: queryVocabularyPolicy.schemaSummary,
              status: "active",
              value: { expansions: { sq: "squirtle" } },
              effective_from: "2026-07-01T00:00:00.000Z",
              effective_until: null,
              created_at: "2026-07-01T00:00:00.000Z",
              updated_at: "2026-07-01T00:00:00.000Z",
            },
          ]
        : sql.startsWith("SELECT * FROM (")
          ? [{ catalog_item_id: "cat_squirtle" }]
          : [];
    return { rows, rowCount: rows.length };
  });
}

describe("Discovery services", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A search runtime handed any other resolver type-checks and searches on the compiled
  // default, whatever an operator saves through the Policy Console.
  it("search with the Query Vocabulary read from the Discovery database through their own policy runtime", async () => {
    // The policy cache ages by the wall clock; a frozen clock keeps the three requests inside one read.
    vi.useFakeTimers({ toFake: ["Date"] });
    composition.eventStore = createInMemoryEventStore().eventStore;
    const query = discoveryDatabase();
    const { items, policies, projectors } = createDiscoveryServices({ query } as never, {
      notificationOutbox: {} as never,
    });
    // The policy console writes through, and the projection invalidates, this one policy runtime.
    const resolvePolicy = vi.spyOn(policies, "resolvePolicy");
    const boundTo = (request: () => Promise<unknown>) => async () => {
      query.mockClear();
      await request();
      return query.mock.calls.flatMap(([, values]) => values ?? []);
    };
    const requests = [
      ["full search", boundTo(() => items.search.searchItems({ search: "sq etb" })), "(sq | (squirtle)) & etb"],
      ["suggestions", boundTo(() => items.search.suggestItems("sq etb")), "(sq | (squirtle)) & etb:*"],
      ["bulk-add preview", boundTo(() => items.search.previewBulkAdd({ search: "sq etb" })), "(sq | (squirtle)) & etb"],
    ] as const;

    let policyReads = 0;
    for (const [name, request, expected] of requests) {
      const bindings = await request();
      policyReads += query.mock.calls.filter(([sql]) => sql.includes("FROM platform_policy_documents")).length;
      // The saved key expands; "etb", a key of the compiled default only, does not.
      expect(bindings, name).toContain(expected);
      expect(
        bindings.filter((value) => typeof value === "string" && value.includes("elite")),
        name,
      ).toEqual([]);
    }

    expect(resolvePolicy.mock.calls).toEqual([
      [queryVocabularyPolicy],
      [queryVocabularyPolicy],
      [queryVocabularyPolicy],
    ]);
    expect(policyReads).toBe(1);
    expect(projectors.map((projector) => projector.projectionName)).toContain("platform-policy-document-projection");
    expect(projectors).toEqual(expect.arrayContaining([...policies.projectors]));
  });

  // Without the name, a Policy Console write's commit receipt names a source no Discovery subscription answers to.
  it("write a Query Vocabulary revision under the Discovery commit source", async () => {
    composition.eventStore = createInMemoryEventStore().eventStore;
    // A Discovery database holding no policy document yet.
    const query = async () => ({ rows: [], rowCount: 0 });
    const { policies } = createDiscoveryServices(
      { connect: async () => ({ query, release: () => {} }), query } as never,
      { notificationOutbox: {} as never },
    );

    const sources = await runWithEventCommitMetadata(async () => {
      await policies.createPolicyDocument(
        queryVocabularyPolicy,
        {
          status: "active",
          value: { expansions: { sq: "squirtle" } },
          effectiveFrom: "2026-01-01T00:00:00.000Z",
          effectiveUntil: null,
          actorUserId: context.audit.performedByUserId,
        },
        context,
      );
      return getEventCommitMetadata().sources.map((source) => source.sourceContextName);
    });

    expect(sources).toEqual(["discovery"]);
  });
});
