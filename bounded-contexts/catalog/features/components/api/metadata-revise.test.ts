import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { decideComponent, evolveComponent, initialComponentState, type ComponentEvent } from "../domain/domain";
import { componentRoutes } from "./route";
import type { ComponentServices } from "./runtime";

const componentId = "cmp_01M66M1AC783BZKNJ5C2FWCNR3";
const streamId = `catalog.component-${componentId}`;
const fieldRule = { fieldId: "fld_01M66M1AC783BZKNJ5C2FWCNR3", required: true };
const dimensionRule = {
  dimensionId: "dim_01M66M1AC783BZKNJ5C2FWCNR3",
  required: true,
  allowedOptionIds: [],
  appliesWhen: [],
};
const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_test" as never,
    forAccountId: "acc_test" as never,
  },
};

describe("component metadata revision route", () => {
  it("ignores legacy rule arrays and preserves the aggregate rules", async () => {
    const memory = createInMemoryEventStore();
    const aggregate = createAggregateCommandHandler({
      eventStore: memory.eventStore,
      codec: createPassthroughDomainEventCodec<ComponentEvent>(),
      initialState: () => initialComponentState,
      evolve: evolveComponent,
      decide: decideComponent,
    });

    await aggregate.commandHandler({
      streamId,
      context,
      command: {
        type: "CreateComponent",
        componentId: componentId as never,
        key: "base",
        name: { defaultLocale: "en", values: { en: "Base" } },
      },
    });
    await aggregate.commandHandler({
      streamId,
      context,
      command: { type: "AddFieldRuleToComponent", fieldId: fieldRule.fieldId as never, required: fieldRule.required },
    });
    await aggregate.commandHandler({
      streamId,
      context,
      command: {
        type: "AddDimensionRuleToComponent",
        dimensionId: dimensionRule.dimensionId as never,
        required: dimensionRule.required,
      },
    });

    const app = new Hono<CatalogAuthoringEnv>();
    app.use("*", async (c, next) => {
      c.set("context", context);
      await next();
    });
    app.route("/", componentRoutes({ commandHandler: aggregate.commandHandler } as ComponentServices, {} as never));

    const response = await app.fetch(
      new Request(`http://catalog.test/${componentId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          key: "base-v2",
          name: { defaultLocale: "en", values: { en: "Base V2" } },
          description: { defaultLocale: "en", values: { en: "Updated" } },
          fieldRules: [],
          dimensionRules: [],
        }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.snapshot.fieldRules).toEqual([fieldRule]);
    expect(body.snapshot.dimensionRules).toEqual([dimensionRule]);

    const reloaded = await aggregate.repository.load(streamId);
    expect(reloaded.state.fieldRules).toEqual([fieldRule]);
    expect(reloaded.state.dimensionRules).toEqual([dimensionRule]);

    const lastEvent = memory.readAllEvents().at(-1);
    expect(lastEvent?.eventType).toBe("catalog.component.revised");
    expect(Object.keys(lastEvent?.payload ?? {})).toEqual(["key", "name", "description"]);
  });
});
