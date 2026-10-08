import { describe, expect, it } from "vitest";
import { module as channelsModule } from "../../../index";
import { createChannelsServicesForTest } from "../../../tests/channels-services-test-support";
import {
  fulfillmentObservationSchemaMigrations,
  fulfillmentObservationSchemaSql,
  fulfillmentObservationRetentionSweeps,
} from "../read-model/schema";

describe("channel-order-observation-callers", () => {
  it("composes the real retry handlers and declares their complete reaction group", () => {
    const subscriptions = channelsModule.buildSubscriptions?.(createChannelsServicesForTest()) ?? [];
    const retry = subscriptions.filter(
      (subscription) => subscription.projectionName === "channel-fulfillment-observation-retry",
    );
    expect(retry).toHaveLength(2);
    const group = channelsModule.projectionGroups?.find(
      (group) => group.projectionName === "channel-fulfillment-observation-retry",
    );
    expect(group).toMatchObject({
      handlerKind: "reaction",
      sourceContextNames: ["inventory", "channels"],
      sideEffectOnly: true,
      resetStrategy: "replay-only",
    });
    expect(
      channelsModule.projectionGroups?.filter(
        (group) => group.projectionName === "channel-fulfillment-observation-retry",
      ),
    ).toHaveLength(1);
  });
  it("keeps executable migrations/boot indexes equivalent and registers the candidate DELETE", () => {
    const statements = fulfillmentObservationSchemaMigrations.flatMap((migration) => migration.statements);
    const indexes = statements.filter((statement) => statement.startsWith("CREATE INDEX"));
    expect(indexes).toHaveLength(3);
    for (const statement of indexes) {
      expect(statement).toContain("CREATE INDEX CONCURRENTLY");
      expect(fulfillmentObservationSchemaSql.replace(/\s+/g, " ")).toContain(
        statement.replace(" CONCURRENTLY", "").replace(/\s+/g, " "),
      );
    }
    expect(channelsModule.retentionSweeps).toEqual(expect.arrayContaining(fulfillmentObservationRetentionSweeps));
  });
});
