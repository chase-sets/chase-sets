import type { CommandExecutionResult } from "@chase-sets/event-core/command-handler";
import type { DomainEvent } from "@chase-sets/event-core";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { DeploymentEnvironment } from "@chase-sets/platform-runtime/config-schema";

export const channelEnvironments = ["sandbox", "production"] as const;
export type ChannelEnvironment = (typeof channelEnvironments)[number];

export const channelConnectionStatuses = ["pending-setup", "active", "paused", "disconnected"] as const;
export type ChannelConnectionStatus = (typeof channelConnectionStatuses)[number];

export type ChannelConnectionBinding = Readonly<{
  storageLocationId: string;
  revision: number;
}>;

export type ChannelConnectionState = Readonly<{
  connectionId: string | null;
  accountId: string | null;
  providerKey: string | null;
  environment: ChannelEnvironment | null;
  status: ChannelConnectionStatus | null;
  createdAt: string | null;
  credentialReference: string | null;
  bindings: readonly ChannelConnectionBinding[];
}>;

export type ConnectChannelCommand = Readonly<{
  type: "ConnectChannel";
  connectionId: string;
  accountId: string;
  providerKey: string;
  environment: ChannelEnvironment;
  createdAt: string;
}>;

export type ActivateChannelConnectionCommand = Readonly<{
  type: "ActivateChannelConnection";
  credentialReference: string | null;
  bindings: readonly ChannelConnectionBinding[];
}>;

export type PauseChannelConnectionCommand = Readonly<{ type: "PauseChannelConnection" }>;
export type ResumeChannelConnectionCommand = Readonly<{ type: "ResumeChannelConnection" }>;
export type DisconnectChannelConnectionCommand = Readonly<{ type: "DisconnectChannelConnection" }>;

export type ChannelConnectionCommand =
  | ConnectChannelCommand
  | ActivateChannelConnectionCommand
  | PauseChannelConnectionCommand
  | ResumeChannelConnectionCommand
  | DisconnectChannelConnectionCommand;

export type ChannelConnectionConnectedEvent = DomainEvent<
  "channels.connection.connected",
  Readonly<{
    connectionId: string;
    accountId: string;
    providerKey: string;
    environment: ChannelEnvironment;
    createdAt: string;
  }>
>;

export type ChannelConnectionActivatedEvent = DomainEvent<
  "channels.connection.activated",
  Readonly<{
    connectionId: string;
    credentialReference: string | null;
    bindings: readonly ChannelConnectionBinding[];
  }>
>;

export type ChannelConnectionPausedEvent = DomainEvent<
  "channels.connection.paused",
  Readonly<{ connectionId: string }>
>;

export type ChannelConnectionResumedEvent = DomainEvent<
  "channels.connection.resumed",
  Readonly<{ connectionId: string }>
>;

export type ChannelConnectionDisconnectedEvent = DomainEvent<
  "channels.connection.disconnected",
  Readonly<{ connectionId: string }>
>;

export type ChannelConnectionEvent =
  | ChannelConnectionConnectedEvent
  | ChannelConnectionActivatedEvent
  | ChannelConnectionPausedEvent
  | ChannelConnectionResumedEvent
  | ChannelConnectionDisconnectedEvent;

export type ChannelConnectionErrorCode =
  | "connection-not-found"
  | "invalid-transition"
  | "connection-disconnected"
  | "provider-setup-not-registered"
  | "credential-not-current"
  | "required-policy-incomplete"
  | "binding-required"
  | "binding-not-current"
  | "invalid-input";

export class ChannelConnectionError extends Error {
  public constructor(
    public readonly code: ChannelConnectionErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "ChannelConnectionError";
  }
}

export type ChannelConnectionSetupDeclaration = Readonly<{
  providerKey: string;
  environment: ChannelEnvironment;
  requirements: Readonly<{
    credential: "required" | "not-required";
    requiredPolicyKeys: readonly string[];
    binding: "one-or-more-current";
  }>;
}>;

export interface ChannelConnectionSetupResolver {
  resolve(
    input: Readonly<{ providerKey: string; environment: ChannelEnvironment }>,
  ): Promise<ChannelConnectionSetupDeclaration | null>;
}

export type ChannelCredentialAuthorityResult = Readonly<{
  accountId: string;
  providerKey: string;
  environment: ChannelEnvironment;
  generation: number;
  status: "current" | "stale" | "revoked";
}>;

export interface ChannelCredentialAuthorityResolver {
  resolve(credentialReference: string): Promise<ChannelCredentialAuthorityResult | null>;
}

export type ChannelStorageLocationAuthorityResult = Readonly<{
  accountId: string;
  storageLocationId: string;
  revision: number;
  status: "active" | "retired";
}>;

export interface ChannelStorageLocationAuthorityResolver {
  resolve(
    input: Readonly<{ accountId: string; storageLocationId: string }>,
  ): Promise<ChannelStorageLocationAuthorityResult | null>;
}

export type ChannelPolicyAuthorityResult = Readonly<{
  policyKey: string;
  revision: number;
  status: "complete" | "incomplete";
}>;

export interface ChannelPolicyAuthorityResolver {
  resolve(
    input: Readonly<{ accountId: string; connectionId: string; policyKey: string }>,
  ): Promise<ChannelPolicyAuthorityResult | null>;
}

export interface ChannelConnectionClock {
  now(): string;
}

export type ChannelConnectionHostPorts = Readonly<{
  setupResolver?: ChannelConnectionSetupResolver;
  credentialAuthority?: ChannelCredentialAuthorityResolver;
  storageLocationAuthority?: ChannelStorageLocationAuthorityResolver;
  policyAuthority?: ChannelPolicyAuthorityResolver;
  clock?: ChannelConnectionClock;
}>;

export type PublicChannelConnection = Readonly<{
  connectionId: string;
  providerKey: string;
  environment: ChannelEnvironment;
  status: ChannelConnectionStatus;
  createdAt: string;
}>;

export type ChannelConnectionPage = Readonly<{
  items: readonly PublicChannelConnection[];
  nextCursor?: string;
}>;

export type ChannelConnectionCommandResult = CommandExecutionResult<ChannelConnectionState, ChannelConnectionEvent>;

export interface ChannelConnectionServices {
  connectChannel(
    input: Readonly<{ connectionId: string; accountId: string; providerKey: string }>,
    options: Readonly<{ deploymentEnvironment: DeploymentEnvironment }>,
    context: EventStoreContext,
  ): Promise<ChannelConnectionCommandResult>;
  activateChannelConnection(
    input: Readonly<{
      accountId: string;
      connectionId: string;
      credentialReference?: string | null;
      bindings: readonly ChannelConnectionBinding[];
    }>,
    context: EventStoreContext,
  ): Promise<ChannelConnectionCommandResult>;
  pauseChannelConnection(
    input: Readonly<{ accountId: string; connectionId: string }>,
    context: EventStoreContext,
  ): Promise<ChannelConnectionCommandResult>;
  resumeChannelConnection(
    input: Readonly<{ accountId: string; connectionId: string }>,
    context: EventStoreContext,
  ): Promise<ChannelConnectionCommandResult>;
  disconnectChannelConnection(
    input: Readonly<{ accountId: string; connectionId: string }>,
    context: EventStoreContext,
  ): Promise<ChannelConnectionCommandResult>;
  getConnection(input: Readonly<{ accountId: string; connectionId: string }>): Promise<PublicChannelConnection | null>;
  listConnections(
    input: Readonly<{
      accountId: string;
      cursor?: string;
      limit?: number;
      status?: ChannelConnectionStatus;
    }>,
  ): Promise<ChannelConnectionPage>;
  projectors: readonly ProjectionHandlerSet[];
}

export type ChannelsServices = Readonly<{
  connections: ChannelConnectionServices;
  projectors: readonly ProjectionHandlerSet[];
}>;
