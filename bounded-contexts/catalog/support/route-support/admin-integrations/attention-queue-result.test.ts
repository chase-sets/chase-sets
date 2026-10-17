import { describe, expect, it } from "vitest";
import {
  CATALOG_ATTENTION_QUEUE_UNAVAILABLE,
  parseCatalogAttentionQueueReadModel,
  resolveCatalogAttentionQueueResult,
} from "./attention-queue-result";
import {
  CATALOG_ATTENTION_FIXTURE_GENERATED_AT,
  catalogAttentionAliasCandidateItem,
  catalogAttentionProviderHealthItem,
  catalogAttentionQueueReadModelFixture,
} from "../../../features/attention-queue/api/attention-queue-test-fixtures";

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
