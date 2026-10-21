import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { composeModuleSchemaSql } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  REPORTED_CONTENT_ACTIONS_BY_TARGET_TYPE,
  REPORTED_CONTENT_STATUS_BY_ACTION,
  REPORTED_CONTENT_TARGET_TYPES,
} from "../api/contracts";
import { createReportedContentRuntime } from "../api/runtime";
import { reportedContentSchemaSql } from "../read-model/schema";
import {
  buildIdentityReportedContentProjectionHandlers,
  buildMarketplaceReportedContentProjectionHandlers,
  buildPlatformOperationsReportedContentProjectionHandlers,
} from "../read-model/projection";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI)
  throw new Error("TEST_DATABASE_URL is required for reported content lifecycle replay in CI.");
const describeDb = databaseBaseUrl ? describe : describe.skip;

const id = (prefix: string, suffix: number | string) => `${prefix}_01HZ${String(suffix).padStart(22, "0")}`;
const listing = id("lst", "A1");
const profile = id("acc", "B1");
const reporterMarker = id("acc", "C1");
const secondReporter = id("acc", "C2");
const operator = id("usr", "D1");
const at = (minute: number) => `2026-07-08T10:${String(minute).padStart(2, "0")}:00.000Z`;
const context: EventStoreContext = {
  tenantId: "tnt_test" as never,
  audit: { performedByUserId: operator as never, forAccountId: id("acc", "E1") as never },
};

type Fact = Readonly<{
  name: string;
  type: string;
  streamId: string;
  recordedAt: string;
  data: Record<string, unknown>;
}>;

function marketplaceReport(name: string, minute: number, reporterKey: string): Fact {
  return {
    name,
    type: "marketplace.report.submitted",
    streamId: `marketplace.report-listing-${listing}-${reporterKey}`,
    recordedAt: at(minute),
    data: {
      reportId: id("rpt", minute),
      targetType: "listing",
      targetId: listing,
      targetOwnerAccountId: id("acc", "F1"),
      reporterKind: "visitor",
      reporterKey,
      reporterAccountId: null,
      reporterUserId: null,
      reason: "counterfeit-concern",
      details: null,
      sourceRoutePath: `/listings/${listing}`,
      submittedAt: at(minute),
    },
  };
}

function profileReport(name: string, minute: number, reporterAccountId: string): Fact {
  return {
    name,
    type: "identity.account-profile.report-submitted",
    streamId: `identity.account-profile-report-${minute}`,
    recordedAt: at(minute),
    data: {
      version: 1,
      reportId: id("rpt", minute),
      targetType: "account-profile",
      targetId: profile,
      reporterAccountId,
      reason: "impersonation-or-deception",
      details: "Copies a seller's shop name.",
      submittedAt: at(minute),
    },
  };
}

function actionRecorded(name: string, minute: number, targetType: string, targetId: string, action: string): Fact {
  return {
    name,
    type: "platform-operations.reported-content.action-recorded",
    streamId: `platform-operations.reported-content-${targetType}-${targetId}`,
    recordedAt: at(minute),
    data: {
      actionId: id("rca", minute),
      targetType,
      targetId,
      action,
      note: "Operator reason.",
      operatorUserId: operator,
      recordedAt: at(minute),
    },
  };
}

// Three independently checkpointed sources; each keeps its own order, never another's.
const marketplace = [
  marketplaceReport("m1", 1, "visitor:one"),
  {
    name: "mAuto",
    type: "marketplace.listing.auto-unlisted",
    streamId: `marketplace.listing-${listing}`,
    recordedAt: at(3),
    data: { reportId: id("rpt", 1), reportCount: 3, threshold: 3, autoUnlistedAt: at(3) },
  },
  marketplaceReport("m2", 6, "visitor:two"),
];
const identity = [profileReport("i1", 2, reporterMarker), profileReport("i2", 7, secondReporter)];
const operations = [
  actionRecorded("pDismiss", 4, "listing", listing, "dismiss"),
  actionRecorded("pContactAccount", 5, "account-profile", profile, "contact-account"),
  actionRecorded("pRedact", 8, "account-profile", profile, "redact-profile-display-name"),
  actionRecorded("pContactSeller", 9, "listing", listing, "contact-seller"),
];
const canonical = [...marketplace, ...identity, ...operations].sort((left, right) =>
  left.recordedAt.localeCompare(right.recordedAt),
);

function interleavings(sources: readonly (readonly Fact[])[]): Fact[][] {
  if (sources.every((source) => source.length === 0)) return [[]];
  return sources.flatMap((source, index) =>
    source.length === 0
      ? []
      : interleavings(sources.map((other, otherIndex) => (otherIndex === index ? other.slice(1) : other))).map(
          (rest) => [source[0]!, ...rest],
        ),
  );
}

describeDb("reported-content-lifecycle-replay", () => {
  let pools: ReturnType<typeof createMultiContextTestPools<"platform-operations">>;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["platform-operations"], "reported_lifecycle");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await pools["platform-operations"].query(composeModuleSchemaSql({ schemaSql: reportedContentSchemaSql }));
  });
  afterAll(async () => {
    if (pools) await closeMultiContextTestPools(pools);
  });

  const db = () => pools["platform-operations"];
  const handlers = () => ({
    ...buildMarketplaceReportedContentProjectionHandlers(db()),
    ...buildIdentityReportedContentProjectionHandlers(db()),
    ...buildPlatformOperationsReportedContentProjectionHandlers(db()),
  });
  async function deliver(facts: readonly Fact[]) {
    const projection = handlers();
    for (const [index, fact] of facts.entries()) {
      await projection[fact.type]!(
        buildTransportEvent(fact.type, fact.data, {
          id: `evt_${fact.name}`,
          streamId: fact.streamId,
          globalPosition: String(index + 1),
          tenantId: "tnt_test",
          audit: { performedByUserId: operator, forAccountId: profile },
          timing: { occurredAt: fact.recordedAt, recordedAt: fact.recordedAt },
        }),
      );
    }
  }
  const snapshot = async () =>
    JSON.parse(
      JSON.stringify(
        (
          await db().query(
            "SELECT * FROM platform_operations_reported_content_queue_pages ORDER BY target_type, target_id",
          )
        ).rows,
      ),
    ) as Record<string, unknown>[];
  const truncate = () => db().query("TRUNCATE platform_operations_reported_content_queue_pages");
  const eventCount = async () =>
    Number((await db().query<{ count: string }>("SELECT COUNT(*) AS count FROM event_store_events")).rows[0]!.count);

  it("every reordered cross-source delivery converges on the canonical state", async () => {
    await deliver(canonical);
    const expected = await snapshot();
    expect(expected.map((row) => [row.target_type, row.status, row.report_count, row.last_action])).toEqual([
      ["account-profile", "profile-display-name-redacted", 2, "redact-profile-display-name"],
      ["listing", "seller-contact-requested", 2, "contact-seller"],
    ]);
    expect(expected[1]).toMatchObject({ auto_unlisted_at: at(3), first_reported_at: at(1), updated_at: at(9) });

    // Facts for different targets write disjoint rows and commute, so each target's
    // sources are interleaved on their own: every order of its report, automatic and
    // operator facts must reach the state that canonical order reaches.
    const earlyAction = actionRecorded("pEarly", 2, "listing", listing, "contact-seller");
    const lateAuto = {
      ...marketplace[1]!,
      name: "mAutoLate",
      recordedAt: at(5),
      data: { ...marketplace[1]!.data, autoUnlistedAt: at(5) },
    };
    const scenarios = [
      {
        sources: [marketplace, [earlyAction, operations[0]!, operations[3]!]],
        status: "seller-contact-requested",
        orders: 20,
      },
      {
        sources: [
          [marketplace[0]!, lateAuto],
          [earlyAction, operations[0]!],
        ],
        status: "auto-unlisted",
        orders: 6,
      },
      { sources: [identity, [operations[1]!, operations[2]!]], status: "profile-display-name-redacted", orders: 6 },
    ];
    for (const scenario of scenarios) {
      const facts = scenario.sources.flat();
      await truncate();
      await deliver([...facts].sort((left, right) => left.recordedAt.localeCompare(right.recordedAt)));
      const target = await snapshot();
      expect(target.map((row) => row.status)).toEqual([scenario.status]);
      const orders = interleavings(scenario.sources);
      expect(orders).toHaveLength(scenario.orders);
      for (const order of orders) {
        await truncate();
        await deliver(order);
        expect(await snapshot(), order.map((fact) => fact.name).join(",")).toEqual(target);
      }
    }
  });

  it("redelivery, stale actions and rebuild change nothing", async () => {
    await deliver(canonical);
    const expected = await snapshot();
    await deliver([...canonical].reverse());
    expect(await snapshot()).toEqual(expected);
    await deliver([operations[0]!, operations[3]!, operations[1]!]);
    expect(await snapshot()).toEqual(expected);
    await truncate();
    await deliver(canonical);
    expect(await snapshot()).toEqual(expected);
  });

  it("needs-review, auto-unlisted, a re-report and each disposition hold their status", async () => {
    await deliver(canonical.slice(0, 2));
    expect((await snapshot()).map((row) => row.status)).toEqual(["needs-review", "needs-review"]);
    await deliver(canonical.slice(2, 3));
    expect((await snapshot()).find((row) => row.target_type === "listing")?.status).toBe("auto-unlisted");
    await deliver(canonical.slice(3, 5));
    await deliver([marketplace[2]!]);
    expect((await snapshot()).find((row) => row.target_type === "listing")).toMatchObject({
      status: "dismissed",
      report_count: 2,
    });

    for (const targetType of REPORTED_CONTENT_TARGET_TYPES) {
      for (const action of REPORTED_CONTENT_ACTIONS_BY_TARGET_TYPE[targetType]) {
        for (const actionFirst of [false, true]) {
          await truncate();
          const targetId = targetType === "account-profile" ? profile : listing;
          const report: Fact =
            targetType === "account-profile"
              ? identity[0]!
              : { ...marketplace[0]!, data: { ...marketplace[0]!.data, targetType } };
          const recorded = actionRecorded(`${targetType}-${action}`, 30, targetType, targetId, action);
          await deliver(actionFirst ? [recorded, report] : [report, recorded]);
          expect(await snapshot(), `${targetType} ${action} actionFirst=${actionFirst}`).toEqual([
            expect.objectContaining({
              target_type: targetType,
              status: REPORTED_CONTENT_STATUS_BY_ACTION[action],
              report_count: 1,
              last_action: action,
            }),
          ]);
        }
      }
    }
  });

  it("malformed events poison without writing", async () => {
    await deliver(canonical);
    const expected = await snapshot();
    const malformed: Fact[] = [
      { ...identity[0]!, data: { ...identity[0]!.data, details: { nested: true } } },
      { ...identity[0]!, data: { ...identity[0]!.data, reporterAccountId: profile } },
      { ...identity[0]!, data: { ...identity[0]!.data, version: 2 } },
      { ...operations[0]!, data: { ...operations[0]!.data, action: "reopen" } },
      { ...operations[1]!, data: { ...operations[1]!.data, action: "unlist" } },
      { ...operations[2]!, data: { ...operations[2]!.data, note: null } },
      { ...marketplace[0]!, data: { ...marketplace[0]!.data, targetType: "saved-list" } },
    ];
    for (const fact of malformed) {
      await expect(deliver([fact]), fact.name).rejects.toThrow();
      expect(await snapshot()).toEqual(expected);
    }
  });

  it("next-day reads append nothing and a next-day action appends exactly its audit", async () => {
    await deliver(canonical);
    const runtime = createReportedContentRuntime({ db: db(), eventStore: createPostgresEventStore({ pool: db() }) });
    expect(await eventCount()).toBe(0);

    const list = await runtime.listReportedContentQueue({ limit: 250 });
    const detail = await runtime.getReportedContentQueueItem("account-profile", profile);
    await runtime.getReportedContentQueueMetrics();
    expect(list.items).toHaveLength(2);
    expect(detail).toMatchObject({ report_count: 2, distinct_reporter_count: 2 });
    expect(JSON.stringify({ list, detail })).not.toContain(reporterMarker);
    expect(await eventCount()).toBe(0);

    await expect(
      runtime.recordModerationAction(
        {
          targetType: "account-profile",
          targetId: profile,
          action: "redact-profile-display-name",
          note: null,
          operatorUserId: operator,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "note-required" });
    await expect(
      runtime.recordModerationAction(
        {
          targetType: "account-profile",
          targetId: createId("acc"),
          action: "dismiss",
          note: null,
          operatorUserId: operator,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: "target-not-queued" });
    expect(await eventCount()).toBe(0);

    const recorded = await runtime.recordModerationAction(
      { targetType: "account-profile", targetId: profile, action: "dismiss", note: null, operatorUserId: operator },
      context,
    );
    expect(await eventCount()).toBe(1);
    await deliver([
      {
        name: "nextDay",
        type: "platform-operations.reported-content.action-recorded",
        streamId: `platform-operations.reported-content-account-profile-${profile}`,
        recordedAt: recorded.recordedAt,
        data: {
          actionId: recorded.actionId,
          targetType: "account-profile",
          targetId: profile,
          action: "dismiss",
          note: null,
          operatorUserId: operator,
          recordedAt: recorded.recordedAt,
        },
      },
    ]);
    expect(await runtime.getReportedContentQueueItem("account-profile", profile)).toMatchObject({
      status: "dismissed",
      last_action: "dismiss",
    });
    expect(await eventCount()).toBe(1);
  });
});
