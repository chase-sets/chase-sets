import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { TransportEvent } from "@chase-sets/event-core";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { buildTransportEvent, createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { module as settlementModule } from "../../../../index";
import type { SettlementServices } from "../../../../support/runtime-support/services";
import { createPayoutReviewHoldRuntime } from "../../api/payout-review-hold-runtime";
import { payoutReviewHoldStreamId } from "../../domain/payout-review-hold";

const tenantId = "tnt_synthetic_migration";
const operatorContext: EventStoreContext = {
  tenantId: tenantId as never,
  audit: { performedByUserId: "usr_synthetic_operator" as never, forAccountId: "acc_synthetic_operator" as never },
};
const migrationReason = "Migrated manual-payout-review badge";

type Direction = "assigned" | "removed";
type Badge = "assigned" | "removed" | "never";
type StreamBefore = "empty" | "migration-only" | "non-migration";
type OperatorCommand = "place" | "release";
type Timing = "before" | "during" | "after";

// Pre-freeze manual-payout-review histories ending in each current badge state. A "never" account
// carries only another badge, so the subscription still delivers an event the migration must ignore.
const badgeHistories: Record<Badge, readonly Readonly<{ badgeKey: string; direction: Direction }>[]> = {
  assigned: [
    { badgeKey: "manual-payout-review", direction: "assigned" },
    { badgeKey: "manual-payout-review", direction: "removed" },
    { badgeKey: "manual-payout-review", direction: "assigned" },
  ],
  removed: [
    { badgeKey: "manual-payout-review", direction: "assigned" },
    { badgeKey: "manual-payout-review", direction: "removed" },
  ],
  never: [{ badgeKey: "trusted-seller", direction: "assigned" }],
};

function createMigrationHarness() {
  const store = createInMemoryEventStore();
  const holds = createPayoutReviewHoldRuntime({ eventStore: store.eventStore });
  // settlement_account_risk_sources.manual_payout_review, written by the unchanged version-1
  // identity risk-source subscription, which runs at head before the migration subscription.
  const riskSourceBadges = new Map<string, boolean>();
  const db = {
    query: async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("manual_payout_review") && sql.includes("settlement_account_risk_sources")) {
        const accountId = String(params[0]);
        return riskSourceBadges.has(accountId)
          ? { rows: [{ manual_payout_review: riskSourceBadges.get(accountId) }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as PgQueryable;
  const services = {
    db,
    payoutReviewHold: holds,
    policies: {},
    wallets: {},
    protectionCoverage: {},
    supportHoldLifecycle: {},
    projectors: [],
  } as unknown as SettlementServices;
  const subscription = (settlementModule.buildSubscriptions?.(services) ?? []).find(
    (candidate) =>
      candidate.sourceContextName === "identity" &&
      candidate.projectionName === "settlement-payout-review-hold-migration",
  );
  if (!subscription) throw new Error("Settlement must declare the identity badge migration subscription.");
  const identityLog: TransportEvent[] = [];

  function appendBadgeEvent(accountId: string, badgeKey: string, direction: Direction) {
    const position = identityLog.length + 1;
    identityLog.push(
      buildTransportEvent(
        direction === "assigned" ? "identity.account.badge-assigned" : "identity.account.badge-removed",
        { badgeKey },
        {
          id: `evt_synthetic_identity_${position}`,
          streamId: `identity.account-${accountId}`,
          globalPosition: String(position),
          tenantId,
          audit: { performedByUserId: "usr_synthetic_badge_admin", forAccountId: accountId },
        },
      ),
    );
    if (badgeKey === "manual-payout-review") riskSourceBadges.set(accountId, direction === "assigned");
  }

  /** Runs the declared subscription from an empty checkpoint; events appended mid-run are delivered too. */
  async function runFromOrigin(afterEvent?: (position: number) => Promise<void>) {
    for (let position = 0; position < identityLog.length; position += 1) {
      const event = identityLog[position]!;
      if (subscription!.eventTypes?.includes(event.type)) await subscription!.handlers[event.type]?.(event);
      await afterEvent?.(position);
    }
  }

  const holdEvents = (accountId: string) =>
    store.readAllEvents().filter((event) => event.streamId === payoutReviewHoldStreamId(accountId));

  return { holds, appendBadgeEvent, runFromOrigin, holdEvents, store };
}

const badges = ["assigned", "removed", "never"] as const;
const streamsBefore = ["empty", "migration-only", "non-migration"] as const;
// Only an account that once held the badge can carry a migration-only stream.
const reachable = (badge: Badge, stream: StreamBefore) => !(badge === "never" && stream === "migration-only");
const operatorCells = badges.flatMap((badge) =>
  streamsBefore
    .filter((stream) => reachable(badge, stream))
    .flatMap((stream) =>
      (["place", "release"] as const).flatMap((command) =>
        (["before", "during", "after"] as const).map((timing) => ({ badge, stream, command, timing })),
      ),
    ),
);
const baselineCells = badges.flatMap((badge) =>
  streamsBefore.filter((stream) => reachable(badge, stream)).map((stream) => ({ badge, stream })),
);

async function runCell(
  badge: Badge,
  stream: StreamBefore,
  operator?: Readonly<{ command: OperatorCommand; timing: Timing }>,
) {
  const harness = createMigrationHarness();
  const accountId = "acc_synthetic_cell";
  for (const entry of badgeHistories[badge]) harness.appendBadgeEvent(accountId, entry.badgeKey, entry.direction);
  const migrationContext: EventStoreContext = {
    tenantId: tenantId as never,
    audit: { performedByUserId: "usr_settlement_system" as never, forAccountId: accountId as never },
  };
  const migrationCommand = {
    accountId: accountId as never,
    reason: migrationReason,
    source: "badge-migration" as const,
  };
  if (stream === "migration-only") {
    // What an earlier, interrupted run left behind for this badge history.
    await harness.holds.place({ ...migrationCommand, sourceReference: "evt_synthetic_identity_1" }, migrationContext);
    if (badge === "removed") {
      await harness.holds.release(
        { ...migrationCommand, sourceReference: "evt_synthetic_identity_2" },
        migrationContext,
      );
    }
  }
  if (stream === "non-migration") {
    await harness.holds.place(
      { accountId: accountId as never, reason: "Operator review before migration", source: "operator" },
      operatorContext,
    );
  }
  const runOperator = async () => {
    if (!operator) return;
    const command = {
      accountId: accountId as never,
      reason: `Operator ${operator.command}`,
      source: "operator" as const,
    };
    if (operator.command === "place") await harness.holds.place(command, operatorContext);
    else await harness.holds.release(command, operatorContext);
  };
  if (operator?.timing === "before") await runOperator();
  await harness.runFromOrigin(async (position) => {
    if (operator?.timing === "during" && position === 0) await runOperator();
  });
  if (operator?.timing === "after") await runOperator();

  const converged = await harness.holds.get(accountId as never);
  const appended = harness.holdEvents(accountId).length;
  // Reset the checkpoint and replay the whole identity history.
  await harness.runFromOrigin();
  return { converged, appended, harness, accountId };
}

describe("badge migration converges once and never undoes an operator release", () => {
  it.each(operatorCells)(
    "badge $badge, $stream stream, operator $command $timing migration",
    async ({ badge, stream, command, timing }) => {
      const { converged, appended, harness, accountId } = await runCell(badge, stream, { command, timing });

      // Every cell has an operator command; it is the latest non-migration command, so it governs.
      expect(converged.active).toBe(command === "place");
      expect(harness.holdEvents(accountId)).toHaveLength(appended);
      expect((await harness.holds.get(accountId as never)).active).toBe(converged.active);
    },
  );

  it.each(baselineCells)("badge $badge, $stream stream, no operator command", async ({ badge, stream }) => {
    const { converged, appended, harness, accountId } = await runCell(badge, stream);

    expect(converged.active).toBe(stream === "non-migration" || badge === "assigned");
    expect(harness.holdEvents(accountId)).toHaveLength(appended);
    if (badge !== "assigned" && stream === "empty") expect(appended).toBe(0);
  });
});

describe("badge migration subscription", () => {
  it("badge migration subscription replays from origin", async () => {
    const harness = createMigrationHarness();
    harness.appendBadgeEvent("acc_synthetic_pre_freeze", "manual-payout-review", "assigned");
    harness.appendBadgeEvent("acc_synthetic_removed", "manual-payout-review", "assigned");
    harness.appendBadgeEvent("acc_synthetic_removed", "manual-payout-review", "removed");

    await harness.runFromOrigin(async (position) => {
      // A pre-freeze instance appends a badge while the empty-checkpoint run is in flight.
      if (position === 0) harness.appendBadgeEvent("acc_synthetic_mid_run", "manual-payout-review", "assigned");
    });

    expect((await harness.holds.get("acc_synthetic_pre_freeze" as never)).active).toBe(true);
    expect((await harness.holds.get("acc_synthetic_mid_run" as never)).active).toBe(true);
    expect(harness.holdEvents("acc_synthetic_removed")).toEqual([]);
    const placed = [...harness.holdEvents("acc_synthetic_pre_freeze"), ...harness.holdEvents("acc_synthetic_mid_run")];
    expect(placed.map((event) => [event.eventType, event.payload, event.performedByUserId])).toEqual([
      [
        "settlement.payout-review-hold.placed",
        {
          factSchemaVersion: 1,
          accountId: "acc_synthetic_pre_freeze",
          reason: migrationReason,
          source: "badge-migration",
          sourceReference: "evt_synthetic_identity_1",
        },
        "usr_settlement_system",
      ],
      [
        "settlement.payout-review-hold.placed",
        {
          factSchemaVersion: 1,
          accountId: "acc_synthetic_mid_run",
          reason: migrationReason,
          source: "badge-migration",
          sourceReference: "evt_synthetic_identity_4",
        },
        "usr_settlement_system",
      ],
    ]);

    const appended = harness.store.readAllEvents().length;
    await harness.runFromOrigin();
    await harness.runFromOrigin();
    expect(harness.store.readAllEvents()).toHaveLength(appended);
  });

  it("pins the badge migration and identity risk-source subscriptions at version 1", () => {
    const subscriptions = settlementModule.eventSubscriptions ?? [];
    expect(
      subscriptions.find(
        (entry) =>
          entry.sourceContextName === "identity" &&
          entry.projectionName === "settlement-account-risk-source-projection",
      ),
    ).toMatchObject({ subscriptionName: "settlement.identity-account-risk-source-projection", subscriptionVersion: 1 });
    expect(
      subscriptions.find((entry) => entry.projectionName === "settlement-payout-review-hold-migration"),
    ).toMatchObject({
      sourceContextName: "identity",
      subscriptionName: "settlement.identity-payout-review-hold-migration",
      subscriptionVersion: 1,
      filterToEventTypes: true,
      eventTypes: ["identity.account.badge-assigned", "identity.account.badge-removed"],
      projectionHandlerSetNames: ["settlement-payout-review-hold-migration"],
    });
    expect(
      subscriptions.find(
        (entry) =>
          entry.sourceContextName === "settlement" &&
          entry.projectionName === "settlement-account-risk-source-projection",
      ),
    ).toMatchObject({
      subscriptionVersion: 1,
      eventTypes: ["settlement.payout-review-hold.placed", "settlement.payout-review-hold.released"],
    });
    const groups = settlementModule.projectionGroups ?? [];
    expect(groups.find((group) => group.projectionName === "settlement-account-risk-source-projection")).toMatchObject({
      projectionRevision: 3,
      sourceContextNames: ["identity", "marketplace", "payments", "settlement"],
    });
    expect(groups.find((group) => group.projectionName === "settlement-payout-review-hold-migration")).toMatchObject({
      sourceContextNames: ["identity"],
      sideEffectOnly: true,
      resetStrategy: "replay-only",
    });
  });
});
