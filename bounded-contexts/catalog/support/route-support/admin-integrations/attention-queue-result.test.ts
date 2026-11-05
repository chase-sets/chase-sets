import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import {
  CATALOG_ATTENTION_QUEUE_UNAVAILABLE,
  parseCatalogAttentionQueueReadModel,
  resolveCatalogAttentionQueueResult,
} from "./attention-queue-result";
import type { CatalogRuntimeDeps } from "../../authoring-support/runtime-support";
import {
  CATALOG_ATTENTION_FIXTURE_GENERATED_AT,
  catalogAttentionAliasCandidateItem,
  catalogAttentionProviderHealthItem,
  catalogAttentionQueueReadModelFixture,
} from "../../../features/attention-queue/api/attention-queue-test-fixtures";
import {
  createCatalogAttentionQueueRuntime,
  type CatalogAttentionControlPlaneSources,
} from "../../../features/attention-queue/api/runtime";

// Loader-local parser for the deferred attention queue (#7845). The single
// valid queue proves `ready` round-trips the assembler's shape unchanged; the
// table applies exactly one mutation each to that same valid queue so every
// `unavailable` verdict is attributable to one closed-contract rule, not to a
// fixture that was malformed in several ways at once.
type Mutable = Record<string, unknown>;

function serialized(value: unknown): Mutable {
  return JSON.parse(JSON.stringify(value)) as Mutable;
}

function item(raw: Mutable, index = 0): Mutable {
  return (raw.items as Mutable[])[index]!;
}

function resolution(raw: Mutable, index = 0): Mutable {
  return item(raw, index).resolution as Mutable;
}

function counts(raw: Mutable): Mutable {
  return raw.counts as Mutable;
}

function freshness(raw: Mutable): Mutable {
  return raw.freshness as Mutable;
}

function coverage(raw: Mutable, kind: string): Mutable {
  return (raw.coverage as Mutable)[kind] as Mutable;
}

function countBasis(raw: Mutable): Mutable {
  return raw.countBasis as Mutable;
}

function queueWindow(raw: Mutable): Mutable {
  return raw.window as Mutable;
}

// The real queue runtime over a database whose sources are all empty, with the
// job snapshot's completeness under test.
async function runtimeQueue(completeness: "complete" | "incomplete") {
  const db: PgQueryable = {
    query: async <T>(sql: string) => {
      if (sql.includes("conflict_total")) return { rows: [{ conflict_total: 0, stale_total: 0 }] as T[] };
      if (sql.includes("AS total")) return { rows: [{ total: 0 }] as T[] };
      return { rows: [] as T[] };
    },
  };
  const controlPlane: CatalogAttentionControlPlaneSources = {
    getReadiness: async () => ({
      generatedAt: CATALOG_ATTENTION_FIXTURE_GENERATED_AT,
      rolloutControls: { generatedAt: CATALOG_ATTENTION_FIXTURE_GENERATED_AT, controls: [] },
      providerUsage: [],
      units: [],
    }),
    listActiveJobSnapshot: async () => ({ items: [], completeness }),
  };
  const context: EventStoreContext = {
    tenantId: "tnt_test" as TenantId,
    audit: { performedByUserId: "usr_reviewer" as UserId, forAccountId: "acc_test" as AccountId },
  };
  const runtime = createCatalogAttentionQueueRuntime({ db } as object as CatalogRuntimeDeps, controlPlane);
  return runtime.getCatalogAttentionQueueReadModel({ context, generatedAt: CATALOG_ATTENTION_FIXTURE_GENERATED_AT });
}

describe("Catalog attention queue deferred result", () => {
  it("validates Catalog attention before marking it ready", () => {
    const nonempty = catalogAttentionQueueReadModelFixture();
    const empty = catalogAttentionQueueReadModelFixture([]);

    // Ready only from a response the parser accepted in full; the accepted read
    // model equals the assembler's shape so the panel renders exactly what the
    // API said, and the parsed copy is a fresh object rather than the response.
    const readyNonempty = resolveCatalogAttentionQueueResult(serialized(nonempty));
    expect(readyNonempty).toEqual({ status: "ready", readModel: nonempty });
    expect(readyNonempty.status === "ready" && readyNonempty.readModel.items).toHaveLength(2);

    const readyEmpty = resolveCatalogAttentionQueueResult(serialized(empty));
    expect(readyEmpty).toEqual({ status: "ready", readModel: empty });
    expect(readyEmpty.status === "ready" && readyEmpty.readModel.freshness).toEqual({
      generatedAt: CATALOG_ATTENTION_FIXTURE_GENERATED_AT,
      oldestObservedAt: null,
      newestObservedAt: null,
    });

    // Timezone offsets other than Z are still timezone-bearing.
    const offsetItem = catalogAttentionAliasCandidateItem({ observedAt: "2026-07-05T02:00:00+02:00" });
    const offsetQueue = catalogAttentionQueueReadModelFixture([offsetItem], "2026-07-09T14:00:00.000+02:00");
    expect(resolveCatalogAttentionQueueResult(serialized(offsetQueue)).status).toBe("ready");

    // A resolution without `requiresReason` stays without it (no key invented).
    const readyResolution = readyNonempty.status === "ready" ? readyNonempty.readModel.items[0]!.resolution : null;
    expect(readyResolution).not.toBeNull();
    expect(readyResolution !== null && "requiresReason" in readyResolution).toBe(false);

    // Non-object transport results are unavailable, never a throw.
    for (const value of [null, undefined, "queue", 7, [], true]) {
      expect(resolveCatalogAttentionQueueResult(value)).toBe(CATALOG_ATTENTION_QUEUE_UNAVAILABLE);
    }
  });

  it("accepts exact cohort totals beyond the window and lower-bound totals as non-empty", () => {
    const exact = catalogAttentionQueueReadModelFixture(undefined, undefined, {
      cohorts: { "alias-candidate": { total: 5027 } },
    });
    const readyExact = resolveCatalogAttentionQueueResult(serialized(exact));
    expect(readyExact).toEqual({ status: "ready", readModel: exact });
    expect(readyExact.status === "ready" && readyExact.readModel.counts.total).toBe(5028);
    expect(readyExact.status === "ready" && readyExact.readModel.coverage["alias-candidate"]).toMatchObject({
      total: 5027,
      returned: 1,
      truncated: true,
      nextOffset: 1,
    });

    const lowerBound = catalogAttentionQueueReadModelFixture(undefined, undefined, {
      cohorts: { "import-job": { totalKind: "lower-bound" } },
    });
    const readyLowerBound = resolveCatalogAttentionQueueResult(serialized(lowerBound));
    expect(readyLowerBound).toEqual({ status: "ready", readModel: lowerBound });
    expect(readyLowerBound.status === "ready" && readyLowerBound.readModel.countBasis).toEqual({
      total: "lower-bound",
      bySeverity: { critical: "lower-bound", warning: "lower-bound", info: "exact" },
    });

    // An incomplete zero is unknown work: ready and not empty, never an empty inbox.
    const incompleteZero = catalogAttentionQueueReadModelFixture([], undefined, {
      cohorts: { "import-job": { totalKind: "lower-bound" } },
    });
    expect(incompleteZero.empty).toBe(false);
    const readyIncompleteZero = resolveCatalogAttentionQueueResult(serialized(incompleteZero));
    expect(readyIncompleteZero.status === "ready" && readyIncompleteZero.readModel.empty).toBe(false);
    const claimedEmpty = serialized(incompleteZero);
    claimedEmpty.empty = true;
    expect(resolveCatalogAttentionQueueResult(claimedEmpty)).toBe(CATALOG_ATTENTION_QUEUE_UNAVAILABLE);
  });

  it("accepts one paged kind and rejects a page carrying another kind's items", () => {
    const window = { kind: "alias-candidate", offset: 20, limit: 20 } as const;
    const paged = catalogAttentionQueueReadModelFixture([catalogAttentionAliasCandidateItem()], undefined, {
      window,
      cohorts: { "alias-candidate": { total: 21 }, "unmapped-scope": { total: 40 } },
    });
    const ready = resolveCatalogAttentionQueueResult(serialized(paged));
    expect(ready).toEqual({ status: "ready", readModel: paged });
    expect(ready.status === "ready" && ready.readModel.coverage["unmapped-scope"]).toEqual({
      total: 40,
      totalKind: "exact",
      offset: 0,
      limit: 0,
      returned: 0,
      truncated: true,
      nextOffset: 0,
    });

    const leaked = serialized(paged);
    (leaked.items as Mutable[]).unshift(serialized(catalogAttentionProviderHealthItem()));
    expect(resolveCatalogAttentionQueueResult(leaked)).toBe(CATALOG_ATTENTION_QUEUE_UNAVAILABLE);
  });

  it("carries the real runtime's job-snapshot completeness through validation", async () => {
    const incomplete = resolveCatalogAttentionQueueResult(serialized(await runtimeQueue("incomplete")));
    expect(incomplete.status).toBe("ready");
    expect(incomplete.status === "ready" && incomplete.readModel.empty).toBe(false);
    expect(incomplete.status === "ready" && incomplete.readModel.countBasis.total).toBe("lower-bound");
    expect(incomplete.status === "ready" && incomplete.readModel.coverage["import-job"].totalKind).toBe("lower-bound");

    const complete = resolveCatalogAttentionQueueResult(serialized(await runtimeQueue("complete")));
    expect(complete.status === "ready" && complete.readModel.empty).toBe(true);
    expect(complete.status === "ready" && complete.readModel.countBasis.total).toBe("exact");
  });

  const singleMutationControls: ReadonlyArray<[label: string, mutate: (raw: Mutable) => void]> = [
    // Top level: exact key set and primitive types.
    ["unknown top-level key", (raw) => void (raw.extra = true)],
    ["missing top-level items", (raw) => void delete raw.items],
    ["missing top-level counts", (raw) => void delete raw.counts],
    ["missing top-level freshness", (raw) => void delete raw.freshness],
    ["items not an array", (raw) => void (raw.items = {})],
    ["empty not a boolean", (raw) => void (raw.empty = "false")],
    ["generatedAt without a timezone", (raw) => void (raw.generatedAt = "2026-07-09T12:00:00")],
    ["generatedAt not a timestamp", (raw) => void (raw.generatedAt = "yesterday")],
    ["generatedAt a calendar date only", (raw) => void (raw.generatedAt = "2026-07-09")],
    ["generatedAt unparseable despite the shape", (raw) => void (raw.generatedAt = "2026-13-45T99:99:00Z")],
    // Derived facts must agree with the items.
    ["empty flag contradicts items", (raw) => void (raw.empty = true)],
    ["counts.total off by one", (raw) => void (counts(raw).total = 3)],
    ["counts.total a float", (raw) => void (counts(raw).total = 2.5)],
    ["severity count mismatch", (raw) => void ((counts(raw).bySeverity as Mutable).critical = 0)],
    ["kind count mismatch", (raw) => void ((counts(raw).byKind as Mutable)["import-job"] = 1)],
    ["unknown severity count key", (raw) => void ((counts(raw).bySeverity as Mutable).fatal = 0)],
    ["missing kind count key", (raw) => void delete (counts(raw).byKind as Mutable)["stale-scope-sync"]],
    ["unknown counts key", (raw) => void (counts(raw).byProvider = {})],
    [
      "severity counts not attributable to the kinds",
      (raw) => void (counts(raw).bySeverity = { critical: 0, warning: 1, info: 1 }),
    ],
    // Windows, coverage and count bases: cohort-wide totals beside one window.
    ["missing top-level window", (raw) => void delete raw.window],
    ["missing top-level coverage", (raw) => void delete raw.coverage],
    ["missing top-level countBasis", (raw) => void delete raw.countBasis],
    ["window limit above the maximum", (raw) => void (queueWindow(raw).limit = 201)],
    ["window limit zero", (raw) => void (queueWindow(raw).limit = 0)],
    ["window offset negative", (raw) => void (queueWindow(raw).offset = -1)],
    ["window offset a float", (raw) => void (queueWindow(raw).offset = 0.5)],
    ["window kind outside the enum", (raw) => void (queueWindow(raw).kind = "everything")],
    ["unknown window key", (raw) => void (queueWindow(raw).cursor = "x")],
    ["coverage missing a kind", (raw) => void delete (raw.coverage as Mutable)["stale-scope-sync"]],
    ["coverage with an unknown kind", (raw) => void ((raw.coverage as Mutable).everything = {})],
    ["coverage total disagrees with the kind count", (raw) => void (coverage(raw, "alias-candidate").total = 2)],
    ["coverage returned disagrees with the items", (raw) => void (coverage(raw, "provider-health").returned = 0)],
    ["coverage limit disagrees with the window", (raw) => void (coverage(raw, "alias-candidate").limit = 200)],
    ["coverage offset disagrees with the window", (raw) => void (coverage(raw, "alias-candidate").offset = 20)],
    ["coverage truncated without a tail", (raw) => void (coverage(raw, "alias-candidate").truncated = true)],
    ["coverage invents a next offset", (raw) => void (coverage(raw, "alias-candidate").nextOffset = 1)],
    ["coverage totalKind outside the enum", (raw) => void (coverage(raw, "import-job").totalKind = "approximate")],
    [
      "coverage lower bound under an exact basis",
      (raw) => void (coverage(raw, "import-job").totalKind = "lower-bound"),
    ],
    ["unknown coverage key", (raw) => void (coverage(raw, "import-job").estimated = true)],
    ["countBasis lower bound without a lower-bound kind", (raw) => void (countBasis(raw).total = "lower-bound")],
    [
      "countBasis severity basis disagrees with the kinds",
      (raw) => void ((countBasis(raw).bySeverity as Mutable).info = "lower-bound"),
    ],
    ["countBasis outside the enum", (raw) => void (countBasis(raw).total = "estimate")],
    ["item severity its kind cannot produce", (raw) => void (item(raw, 1).severity = "critical")],
    [
      "freshness generatedAt disagrees with top level",
      (raw) => void (freshness(raw).generatedAt = "2026-07-09T12:00:01.000Z"),
    ],
    [
      "oldestObservedAt not the item minimum",
      (raw) => void (freshness(raw).oldestObservedAt = "2026-07-05T00:00:00.000Z"),
    ],
    [
      "newestObservedAt not the item maximum",
      (raw) => void (freshness(raw).newestObservedAt = "2026-07-01T00:00:00.000Z"),
    ],
    ["nonempty queue with null extrema", (raw) => void (freshness(raw).oldestObservedAt = null)],
    ["unknown freshness key", (raw) => void (freshness(raw).staleAfter = "2026-07-10T00:00:00.000Z")],
    // Items: closed fields, enums, params and timestamps.
    ["item with an unknown key", (raw) => void (item(raw).note = "x")],
    ["item missing observedAt", (raw) => void delete item(raw).observedAt],
    ["item observedAt without a timezone", (raw) => void (item(raw).observedAt = "2026-07-01T00:00:00")],
    ["item kind outside the enum", (raw) => void (item(raw).kind = "provider-outage")],
    ["item severity outside the enum", (raw) => void (item(raw).severity = "blocker")],
    ["item key empty", (raw) => void (item(raw).itemKey = "")],
    ["item titleKey not a string", (raw) => void (item(raw).titleKey = 12)],
    ["item titleParams not a record", (raw) => void (item(raw).titleParams = ["unit"])],
    ["item detailParams with a boolean value", (raw) => void ((item(raw).detailParams as Mutable).blocker = true)],
    [
      "item detailParams with a nested object",
      (raw) => void ((item(raw).detailParams as Mutable).code = { code: "x" }),
    ],
    ["item providerKey a number", (raw) => void (item(raw).providerKey = 5)],
    ["item unitKey undefined", (raw) => void delete item(raw).unitKey],
    ["item secondaryResolutions not an array", (raw) => void (item(raw).secondaryResolutions = {})],
    // Resolutions: primary and secondary alike.
    ["resolution missing fields", (raw) => void delete resolution(raw).fields],
    ["resolution with an unknown key", (raw) => void (resolution(raw).href = "/x")],
    ["resolution mode outside the enum", (raw) => void (resolution(raw).mode = "link")],
    ["resolution intent empty", (raw) => void (resolution(raw).intent = "")],
    ["resolution field not a string", (raw) => void ((resolution(raw).fields as Mutable).unitKey = 1)],
    ["resolution requiresReason not a boolean", (raw) => void (resolution(raw).requiresReason = "yes")],
    [
      "secondary resolution mode outside the enum",
      (raw) => void ((item(raw, 1).secondaryResolutions as Mutable[])[0]!.mode = "modal"),
    ],
    [
      "secondary resolution labelKey missing",
      (raw) => void delete (item(raw, 1).secondaryResolutions as Mutable[])[0]!.labelKey,
    ],
  ];

  it.each(singleMutationControls)("marks a queue unavailable when %s", (_label, mutate) => {
    const raw = serialized(catalogAttentionQueueReadModelFixture());
    // Guard the control itself: the unmutated copy is ready, so the verdict below
    // is caused by this one mutation.
    expect(resolveCatalogAttentionQueueResult(serialized(raw)).status).toBe("ready");

    mutate(raw);

    expect(resolveCatalogAttentionQueueResult(raw)).toBe(CATALOG_ATTENTION_QUEUE_UNAVAILABLE);
    expect(parseCatalogAttentionQueueReadModel(raw)).toBeNull();
  });

  it("marks an empty queue unavailable when its extrema are not null", () => {
    const raw = serialized(catalogAttentionQueueReadModelFixture([]));
    freshness(raw).oldestObservedAt = CATALOG_ATTENTION_FIXTURE_GENERATED_AT;
    freshness(raw).newestObservedAt = CATALOG_ATTENTION_FIXTURE_GENERATED_AT;

    expect(resolveCatalogAttentionQueueResult(raw)).toBe(CATALOG_ATTENTION_QUEUE_UNAVAILABLE);
  });

  it("rejects a single malformed item even when every other item is valid", () => {
    const raw = serialized(
      catalogAttentionQueueReadModelFixture([
        catalogAttentionProviderHealthItem(),
        catalogAttentionAliasCandidateItem(),
        catalogAttentionAliasCandidateItem({ itemKey: "alias-candidate:h2", observedAt: "2026-07-03T00:00:00.000Z" }),
      ]),
    );
    item(raw, 2).severity = "info-ish";

    expect(resolveCatalogAttentionQueueResult(raw)).toBe(CATALOG_ATTENTION_QUEUE_UNAVAILABLE);
  });
});
