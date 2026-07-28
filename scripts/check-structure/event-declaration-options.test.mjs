import { describe, expect, it } from "vitest";
import { validateEventDeclarationOptions } from "./run.mjs";

describe("event declaration option schema", () => {
  it("accepts optional declaration metadata when present", () => {
    expect(
      validateEventDeclarationOptions(
        {
          subscriptionName: "nebula.delivery-view",
          filterToEventTypes: true,
        },
        "bounded-contexts/nebula/context.json eventSubscriptions[4]",
      ),
    ).toEqual([]);
  });

  it("does not require either declaration option", () => {
    expect(
      validateEventDeclarationOptions(
        {
          sourceContextName: "aurora",
          projectionName: "nebula-delivery-view",
        },
        "bounded-contexts/nebula/context.json eventSubscriptions[4]",
      ),
    ).toEqual([]);
  });

  it("names a wrong-typed filter flag at its context and declaration index", () => {
    expect(
      validateEventDeclarationOptions(
        {
          filterToEventTypes: "enabled",
        },
        "bounded-contexts/nebula/context.json eventSubscriptions[4]",
      ),
    ).toEqual([
      "bounded-contexts/nebula/context.json eventSubscriptions[4]: filterToEventTypes must be a boolean when provided",
    ]);
  });

  it("rejects empty and wrong-typed subscription names through a sibling reaction fixture", () => {
    const label = "bounded-contexts/orbit/context.json eventReactions[7]";

    expect(validateEventDeclarationOptions({ subscriptionName: "  " }, label)).toEqual([
      "bounded-contexts/orbit/context.json eventReactions[7]: subscriptionName must be a non-empty string when provided",
    ]);
    expect(validateEventDeclarationOptions({ subscriptionName: 42 }, label)).toEqual([
      "bounded-contexts/orbit/context.json eventReactions[7]: subscriptionName must be a non-empty string when provided",
    ]);
  });

  it("rejects nested objects instead of treating them as truthy option values", () => {
    const label = "bounded-contexts/quasar/context.json eventSubscriptions[11]";

    expect(
      validateEventDeclarationOptions(
        {
          subscriptionName: { value: "quasar.summary" },
          filterToEventTypes: { enabled: true },
        },
        label,
      ),
    ).toEqual([
      "bounded-contexts/quasar/context.json eventSubscriptions[11]: subscriptionName must be a non-empty string when provided",
      "bounded-contexts/quasar/context.json eventSubscriptions[11]: filterToEventTypes must be a boolean when provided",
    ]);
  });
});
