import type { BcApiModule, BcEventSubscription } from "@chase-sets/bounded-context-module";
import { describe, expect, it } from "vitest";
import { module } from "../index";
import contract from "./worker-graph.contract.json";

describe("customer-feedback worker graph contract", () => {
  it("owns four optional native outcome runners with filtered version-one subscriptions", () => {
    for (const source of ["fulfillment", "payments", "settlement", "platform-operations"]) {
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
