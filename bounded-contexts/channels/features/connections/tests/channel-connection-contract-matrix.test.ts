import { describe, expect, it } from "vitest";
import { decideChannelConnection, evolveChannelConnection, initialChannelConnectionState } from "../domain/domain";
import {
  ChannelConnectionError,
  type ChannelConnectionCommand,
  type ChannelConnectionStatus,
} from "../domain/contracts";

const origins = [null, "pending-setup", "active", "paused", "disconnected"] as const;
const commands: readonly ChannelConnectionCommand[] = [
  {
    type: "ConnectChannel",
    connectionId: "connection_1",
    accountId: "acc_owner",
    providerKey: "fixture-provider",
    environment: "sandbox",
    createdAt: "2026-09-05T00:00:00.000Z",
  },
  {
    type: "ActivateChannelConnection",
    credentialReference: null,
    bindings: [{ storageLocationId: "location_1", revision: 1 }],
  },
  { type: "PauseChannelConnection" },
  { type: "ResumeChannelConnection" },
  { type: "DisconnectChannelConnection" },
];

const expected = [
  [
    "channels.connection.connected",
    "connection-not-found",
    "connection-not-found",
    "connection-not-found",
    "connection-not-found",
  ],
  [
    "invalid-transition",
    "channels.connection.activated",
    "invalid-transition",
    "invalid-transition",
    "channels.connection.disconnected",
  ],
  [
    "invalid-transition",
    "invalid-transition",
    "channels.connection.paused",
    "invalid-transition",
    "channels.connection.disconnected",
  ],
  [
    "invalid-transition",
    "invalid-transition",
    "no-op",
    "channels.connection.resumed",
    "channels.connection.disconnected",
  ],
  ["connection-disconnected", "connection-disconnected", "connection-disconnected", "connection-disconnected", "no-op"],
] as const;

describe("channel-connection-contract-matrix", () => {
  it("proves every one of the 25 origin-by-service pairs without a default transition arm", () => {
    let visited = 0;
    origins.forEach((origin, originIndex) => {
      commands.forEach((command, commandIndex) => {
        visited += 1;
        const state = stateAt(origin);
        const outcome = expected[originIndex][commandIndex];
        if (
          outcome === "connection-not-found" ||
          outcome === "invalid-transition" ||
          outcome === "connection-disconnected"
        ) {
          expect(() => decideChannelConnection(state, command)).toThrowError(
            expect.objectContaining<Partial<ChannelConnectionError>>({ code: outcome }),
          );
          return;
        }
        const events = decideChannelConnection(state, command);
        if (outcome === "no-op") {
          expect(events).toEqual([]);
          expect(state.createdAt).toBe("2026-09-05T00:00:00.000Z");
          return;
        }
        expect(events.map((event) => event.type)).toEqual([outcome]);
        const evolved = events.reduce(evolveChannelConnection, state);
        expect(evolved.createdAt).toBe("2026-09-05T00:00:00.000Z");
        if (outcome === "channels.connection.disconnected") {
          expect(evolved).toMatchObject({ status: "disconnected", credentialReference: null, bindings: [] });
        }
      });
    });
    expect(visited).toBe(25);
  });
});

function stateAt(status: ChannelConnectionStatus | null) {
  if (status === null) return initialChannelConnectionState;
  return {
    connectionId: "connection_1",
    accountId: "acc_owner",
    providerKey: "fixture-provider",
    environment: "sandbox" as const,
    status,
    createdAt: "2026-09-05T00:00:00.000Z",
    credentialReference: status === "pending-setup" || status === "disconnected" ? null : "credential-reference-1",
    bindings:
      status === "pending-setup" || status === "disconnected" ? [] : [{ storageLocationId: "location_1", revision: 1 }],
  };
}
