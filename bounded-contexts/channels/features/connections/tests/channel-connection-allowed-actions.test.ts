import { describe, expect, it } from "vitest";
import {
  allowedChannelConnectionActions,
  decideChannelConnection,
  initialChannelConnectionState,
} from "../domain/domain";
import type { ChannelConnectionAllowedAction } from "../domain/domain";
import type { ChannelConnectionCommand, ChannelConnectionStatus } from "../domain/contracts";

const statuses: readonly ChannelConnectionStatus[] = ["pending-setup", "active", "paused", "disconnected"];
const actions: readonly ChannelConnectionAllowedAction[] = ["pause", "resume", "disconnect"];
const commands: Readonly<Record<ChannelConnectionAllowedAction, ChannelConnectionCommand>> = {
  pause: { type: "PauseChannelConnection" },
  resume: { type: "ResumeChannelConnection" },
  disconnect: { type: "DisconnectChannelConnection" },
};

describe("channel-connection-allowed-actions", () => {
  it("allows an action exactly when the real decider emits an event", () => {
    for (const status of statuses) {
      const state = { ...initialChannelConnectionState, connectionId: "connection", status };
      for (const action of actions) {
        let emitsEvent = false;
        try {
          emitsEvent = decideChannelConnection(state, commands[action]).length > 0;
        } catch {
          emitsEvent = false;
        }
        expect(allowedChannelConnectionActions(status).includes(action)).toBe(emitsEvent);
      }
    }
  });

  it.each([
    ["pending-setup", ["disconnect"]],
    ["active", ["pause", "disconnect"]],
    ["paused", ["resume", "disconnect"]],
    ["disconnected", []],
  ] as const)("pins the ordered table for %s", (status, expected) => {
    expect(allowedChannelConnectionActions(status)).toEqual(expected);
  });
});
