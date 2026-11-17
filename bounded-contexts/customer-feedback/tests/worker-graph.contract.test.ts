import type { BcApiModule, BcEventSubscription } from "@chase-sets/bounded-context-module";
import { describe, expect, it } from "vitest";
import { module } from "../index";
import contract from "./worker-graph.contract.json";

describe("customer-feedback worker graph contract", () => {
  it("owns nine optional native outcome runners with filtered version-one subscriptions", () => {
    const group = module.projectionGroups?.find(
      (candidate) => candidate.projectionName === "customer-feedback-csat-outcome-fact-projection",
    );
    expect(group).toMatchObject({
      requiredDuringBootstrap: false,
      ownedTables: ["customer_feedback_csat_outcome_facts"],
    });
    expect(group?.sourceContextNames).toEqual([
      "auth",
      "identity",
      "discovery",
      "fulfillment",
      "payments",
      "settlement",
      "platform-operations",
      "marketplace",
      "inventory",
    ]);
    for (const source of [
      "auth",
      "identity",
      "discovery",
      "fulfillment",
      "payments",
      "settlement",
      "platform-operations",
      "marketplace",
      "inventory",
    ]) {
      const subscription = module
        .buildSubscriptions?.({ cases: {}, eventStore: {} } as never)
        .find((candidate) => candidate.sourceContextName === source);
      expect(subscription).toMatchObject({
        projectionName: "customer-feedback-csat-outcome-fact-projection",
        subscriptionVersion: 1,
      });
      expect(Object.keys(subscription!.handlers)).toEqual(subscription!.eventTypes);
      const runner = contract.runners.find(
        (candidate) =>
          candidate.sourceContextName === source && candidate.projectionName === subscription!.projectionName,
      );
      expect(runner).toMatchObject({
        inlineApply: false,
        checkpointBatchSize: 100,
        checkpointKey: `customer-feedback-csat-outcome-fact-projection:${source}:v1`,
      });
    }
  });
  it("owns the complete declared subscription and reaction expectations", () => {
    const declarations: Pick<BcApiModule, "eventSubscriptions" | "eventReactions"> = module;
    const subscriptions: readonly (Pick<
      BcEventSubscription,
      "projectionName" | "sourceContextName" | "subscriptionVersion"
    > & { eventTypes?: unknown })[] = contract.subscriptions;
    const declared = [
      ...(declarations.eventSubscriptions ?? []),
      ...(declarations.eventReactions ?? []).map((reaction) => ({
        ...reaction,
        projectionName: reaction.reactionName,
      })),
    ];
    const identity = (value: { projectionName: string; sourceContextName: string; subscriptionVersion: number }) =>
      `${value.projectionName}:${value.sourceContextName}:v${value.subscriptionVersion}`;
    expect(declared.map(identity).sort()).toEqual(subscriptions.map(identity).sort());
    for (const declaration of declared) {
      const expected = subscriptions.find((subscription) => identity(subscription) === identity(declaration));
      expect([...(declaration.eventTypes ?? [])].sort(), identity(declaration)).toEqual(
        Array.isArray(expected?.eventTypes) ? [...expected.eventTypes].sort() : [],
      );
    }
  });
});
