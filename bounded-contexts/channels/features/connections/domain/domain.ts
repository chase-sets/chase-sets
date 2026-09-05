import type { AggregateDecider, AggregateEvolver } from "@chase-sets/event-core";
import {
  ChannelConnectionError,
  type ChannelConnectionCommand,
  type ChannelConnectionEvent,
  type ChannelConnectionState,
} from "./contracts";

export const initialChannelConnectionState: ChannelConnectionState = {
  connectionId: null,
  accountId: null,
  providerKey: null,
  environment: null,
  status: null,
  createdAt: null,
  credentialReference: null,
  bindings: [],
};

export const decideChannelConnection: AggregateDecider<
  ChannelConnectionState,
  ChannelConnectionCommand,
  ChannelConnectionEvent
> = (state, command) => {
  if (state.status === "disconnected") {
    if (command.type === "DisconnectChannelConnection") return [];
    throw new ChannelConnectionError("connection-disconnected");
  }

  switch (command.type) {
    case "ConnectChannel":
      if (state.connectionId !== null) throw new ChannelConnectionError("invalid-transition");
      return [
        {
          type: "channels.connection.connected",
          data: {
            connectionId: command.connectionId,
            accountId: command.accountId,
            providerKey: command.providerKey,
            environment: command.environment,
            createdAt: command.createdAt,
          },
        },
      ];
    case "ActivateChannelConnection":
      requirePresent(state);
      if (state.status !== "pending-setup") throw new ChannelConnectionError("invalid-transition");
      return [
        {
          type: "channels.connection.activated",
          data: {
            connectionId: state.connectionId,
            credentialReference: command.credentialReference,
            bindings: command.bindings,
          },
        },
      ];
    case "PauseChannelConnection":
      requirePresent(state);
      if (state.status === "paused") return [];
      if (state.status !== "active") throw new ChannelConnectionError("invalid-transition");
      return [{ type: "channels.connection.paused", data: { connectionId: state.connectionId } }];
    case "ResumeChannelConnection":
      requirePresent(state);
      if (state.status !== "paused") throw new ChannelConnectionError("invalid-transition");
      return [{ type: "channels.connection.resumed", data: { connectionId: state.connectionId } }];
    case "DisconnectChannelConnection":
      requirePresent(state);
      return [{ type: "channels.connection.disconnected", data: { connectionId: state.connectionId } }];
  }
};

export const evolveChannelConnection: AggregateEvolver<ChannelConnectionState, ChannelConnectionEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "channels.connection.connected":
      return {
        connectionId: event.data.connectionId,
        accountId: event.data.accountId,
        providerKey: event.data.providerKey,
        environment: event.data.environment,
        status: "pending-setup",
        createdAt: event.data.createdAt,
        credentialReference: null,
        bindings: [],
      };
    case "channels.connection.activated":
      return {
        ...state,
        status: "active",
        credentialReference: event.data.credentialReference,
        bindings: event.data.bindings,
      };
    case "channels.connection.paused":
      return { ...state, status: "paused" };
    case "channels.connection.resumed":
      return { ...state, status: "active" };
    case "channels.connection.disconnected":
      return { ...state, status: "disconnected", credentialReference: null, bindings: [] };
  }
};

function requirePresent(
  state: ChannelConnectionState,
): asserts state is ChannelConnectionState & { connectionId: string } {
  if (state.connectionId === null) throw new ChannelConnectionError("connection-not-found");
}
