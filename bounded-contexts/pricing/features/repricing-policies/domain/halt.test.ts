import { describe, expect, it } from "vitest";
import { decideRepricingHalt, evolveRepricingHalt, initialRepricingHaltState } from "./halt";

describe("Repricing Halt", () => {
  it("starts released, engages and releases, retaining audit instants with inert repeats", () => {
    let state = initialRepricingHaltState;
    expect(decideRepricingHalt(state, { engaged: false, changedAt: "initial" })).toEqual([]);
    for (const engaged of [true, false, true, false]) {
      const changedAt = `${engaged}-${state.engagedAt}`;
      const events = decideRepricingHalt(state, { engaged, changedAt });
      expect(events).toHaveLength(1);
      state = events.reduce(evolveRepricingHalt, state);
      expect(state.engaged).toBe(engaged);
      expect(engaged ? state.engagedAt : state.releasedAt).toBe(changedAt);
      expect(decideRepricingHalt(state, { engaged, changedAt: "repeat" })).toEqual([]);
    }
  });
});
