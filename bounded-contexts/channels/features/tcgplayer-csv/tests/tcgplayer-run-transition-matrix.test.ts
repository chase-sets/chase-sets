import { describe, expect, it } from "vitest";
import {
  channelSyncRunStates,
  channelSyncRunTriggers,
  type ChannelSyncRunState,
  type ChannelSyncRunTrigger,
} from "../domain/contracts";
import { channelSyncRunTransitions, decideChannelSyncRunTransition } from "../domain/lifecycle";

describe("tcgplayer-run-transition-matrix", () => {
  it("exhausts every exported state and trigger with a deterministic result or refusal", () => {
    const cells = new Map<string, string>();
    for (const state of channelSyncRunStates) {
      for (const trigger of channelSyncRunTriggers) {
        try {
          cells.set(key(state, trigger), decideChannelSyncRunTransition(state, trigger, { verificationMatched: true }));
        } catch (error) {
          cells.set(key(state, trigger), error instanceof Error ? error.message : "unknown");
        }
      }
    }
    expect(cells.size).toBe(channelSyncRunStates.length * channelSyncRunTriggers.length);
    for (const transition of channelSyncRunTransitions) {
      expect(cells.get(key(transition.from, transition.trigger))).toBe(transition.to);
    }
    for (const terminal of channelSyncRunStates.slice(3)) {
      for (const trigger of channelSyncRunTriggers) expect(cells.get(key(terminal, trigger))).toBe("terminal");
    }
  });

  it("makes verification mismatch irreversibly unknown", () => {
    expect(decideChannelSyncRunTransition("awaiting-verification", "verify", { verificationMatched: false })).toBe(
      "application-unknown",
    );
  });

  it("makes a repeated upload attempt irreversibly unknown", () => {
    expect(decideChannelSyncRunTransition("awaiting-verification", "report-upload-attempted")).toBe(
      "application-unknown",
    );
  });
});

function key(state: ChannelSyncRunState, trigger: ChannelSyncRunTrigger): string {
  return `${state}:${trigger}`;
}
