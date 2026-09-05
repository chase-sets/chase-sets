import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { DEPLOYMENT_ENVIRONMENTS, type DeploymentEnvironment } from "@chase-sets/platform-runtime/config-schema";
import { channelConnectionEventCodec } from "../domain/codec";
import {
  ChannelConnectionError,
  type ChannelConnectionBinding,
  type ChannelConnectionClock,
  type ChannelConnectionHostPorts,
  type ChannelConnectionServices,
  type ChannelConnectionSetupDeclaration,
  type ChannelConnectionSetupResolver,
  type ChannelCredentialAuthorityResolver,
  type ChannelEnvironment,
  type ChannelPolicyAuthorityResolver,
  type ChannelStorageLocationAuthorityResolver,
} from "../domain/contracts";
import { decideChannelConnection, evolveChannelConnection, initialChannelConnectionState } from "../domain/domain";
import {
  assertBindingsShape,
  assertChannelEnvironment,
  assertClosedRecord,
  assertCredentialReference,
  assertOpaqueId,
  assertProviderKey,
  assertRfc3339Instant,
  assertSafeInteger,
  assertSetupDeclaration,
} from "../domain/validation";
import { buildChannelConnectionProjectionHandlers } from "../read-model/projection";
import { getPublicChannelConnection, listPublicChannelConnections } from "../read-model/queries";

export type ChannelConnectionRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
}>;

const absentSetupResolver: ChannelConnectionSetupResolver = { resolve: async () => null };
const absentCredentialAuthority: ChannelCredentialAuthorityResolver = { resolve: async () => null };
const absentStorageLocationAuthority: ChannelStorageLocationAuthorityResolver = { resolve: async () => null };
const absentPolicyAuthority: ChannelPolicyAuthorityResolver = { resolve: async () => null };
const serverClock: ChannelConnectionClock = { now: () => new Date().toISOString() };

export function mapDeploymentEnvironment(environment: DeploymentEnvironment): ChannelEnvironment {
  switch (environment) {
    case "production":
      return "production";
    case "staging":
    case "preview":
    case "test":
    case "dev":
    case "local":
    case "remote-dev":
      return "sandbox";
  }
}

export function createChannelConnectionRuntime(
  deps: ChannelConnectionRuntimeDeps,
  ports: ChannelConnectionHostPorts = {},
): ChannelConnectionServices {
  const setupResolver = ports.setupResolver ?? absentSetupResolver;
  const credentialAuthority = ports.credentialAuthority ?? absentCredentialAuthority;
  const storageLocationAuthority = ports.storageLocationAuthority ?? absentStorageLocationAuthority;
  const policyAuthority = ports.policyAuthority ?? absentPolicyAuthority;
  const clock = ports.clock ?? serverClock;
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: channelConnectionEventCodec,
    initialState: () => initialChannelConnectionState,
    evolve: evolveChannelConnection,
    decide: decideChannelConnection,
    commitSourceContextName: "channels",
  });
  const streamId = (connectionId: string) => `channels.connection-${connectionId}`;

  async function loadOwned(accountId: string, connectionId: string) {
    assertOpaqueId(accountId, "accountId");
    assertOpaqueId(connectionId, "connectionId");
    const loaded = await repository.load(streamId(connectionId));
    if (loaded.state.connectionId === null || loaded.state.accountId !== accountId) {
      throw new ChannelConnectionError("connection-not-found");
    }
    return loaded;
  }

  async function resolveSetup(
    providerKey: string,
    environment: ChannelEnvironment,
  ): Promise<ChannelConnectionSetupDeclaration> {
    const declaration = await setupResolver.resolve({ providerKey, environment });
    if (!declaration) throw new ChannelConnectionError("provider-setup-not-registered");
    assertSetupDeclaration(declaration, { providerKey, environment });
    return declaration;
  }

  async function guardSetup(
    declaration: ChannelConnectionSetupDeclaration,
    input: Readonly<{
      accountId: string;
      connectionId: string;
      providerKey: string;
      environment: ChannelEnvironment;
      credentialReference: string | null;
      bindings: readonly ChannelConnectionBinding[];
    }>,
  ) {
    assertBindingsShape(input.bindings);
    if (input.credentialReference !== null) assertCredentialReference(input.credentialReference);

    if (declaration.requirements.credential === "required" || input.credentialReference !== null) {
      if (input.credentialReference === null) throw new ChannelConnectionError("credential-not-current");
      const credential = await credentialAuthority.resolve(input.credentialReference);
      if (!credentialIsCurrent(credential, input)) throw new ChannelConnectionError("credential-not-current");
    }

    for (const policyKey of declaration.requirements.requiredPolicyKeys) {
      const policy = await policyAuthority.resolve({
        accountId: input.accountId,
        connectionId: input.connectionId,
        policyKey,
      });
      if (!policyIsComplete(policy, policyKey)) throw new ChannelConnectionError("required-policy-incomplete");
    }

    if (input.bindings.length === 0) throw new ChannelConnectionError("binding-required");
    for (const binding of input.bindings) {
      const current = await storageLocationAuthority.resolve({
        accountId: input.accountId,
        storageLocationId: binding.storageLocationId,
      });
      if (!storageLocationIsCurrent(current, input.accountId, binding)) {
        throw new ChannelConnectionError("binding-not-current");
      }
    }
  }

  const projectors = [
    createProjectionHandlerSet({
      projectionName: "channel-connection-projection",
      handlers: buildChannelConnectionProjectionHandlers(deps.db),
    }),
  ];

  const services: ChannelConnectionServices = {
    connectChannel: async (input, options, context) => {
      assertClosedRecord(input, ["connectionId", "accountId", "providerKey"], "connect input");
      assertClosedRecord(options, ["deploymentEnvironment"], "connect options");
      assertOpaqueId(input.connectionId, "connectionId");
      assertOpaqueId(input.accountId, "accountId");
      assertProviderKey(input.providerKey);
      assertDeploymentEnvironment(options.deploymentEnvironment);
      const loaded = await repository.load(streamId(input.connectionId));
      if (loaded.state.status === "disconnected") throw new ChannelConnectionError("connection-disconnected");
      if (loaded.state.connectionId !== null) throw new ChannelConnectionError("invalid-transition");
      const environment = mapDeploymentEnvironment(options.deploymentEnvironment);
      await resolveSetup(input.providerKey, environment);
      const createdAt = clock.now();
      assertRfc3339Instant(createdAt, "createdAt");
      return commandHandler({
        streamId: streamId(input.connectionId),
        expectedVersion: "no_stream",
        command: { type: "ConnectChannel", ...input, environment, createdAt },
        context,
      });
    },
    activateChannelConnection: async (input, context) => {
      assertClosedRecord(input, ["accountId", "connectionId", "credentialReference", "bindings"], "activate input");
      const loaded = await loadOwned(input.accountId, input.connectionId);
      if (loaded.state.status === "disconnected") throw new ChannelConnectionError("connection-disconnected");
      if (loaded.state.status !== "pending-setup") throw new ChannelConnectionError("invalid-transition");
      const declaration = await resolveSetup(loaded.state.providerKey!, loaded.state.environment!);
      const credentialReference = input.credentialReference ?? null;
      await guardSetup(declaration, {
        accountId: input.accountId,
        connectionId: input.connectionId,
        providerKey: loaded.state.providerKey!,
        environment: loaded.state.environment!,
        credentialReference,
        bindings: input.bindings,
      });
      return commandHandler({
        streamId: streamId(input.connectionId),
        expectedVersion: loaded.version,
        command: { type: "ActivateChannelConnection", credentialReference, bindings: input.bindings },
        context,
      });
    },
    pauseChannelConnection: async (input, context) => {
      assertClosedRecord(input, ["accountId", "connectionId"], "pause input");
      const loaded = await loadOwned(input.accountId, input.connectionId);
      return commandHandler({
        streamId: streamId(input.connectionId),
        expectedVersion: loaded.version,
        command: { type: "PauseChannelConnection" },
        context,
      });
    },
    resumeChannelConnection: async (input, context) => {
      assertClosedRecord(input, ["accountId", "connectionId"], "resume input");
      const loaded = await loadOwned(input.accountId, input.connectionId);
      if (loaded.state.status === "disconnected") throw new ChannelConnectionError("connection-disconnected");
      if (loaded.state.status !== "paused") throw new ChannelConnectionError("invalid-transition");
      const declaration = await resolveSetup(loaded.state.providerKey!, loaded.state.environment!);
      await guardSetup(declaration, {
        accountId: input.accountId,
        connectionId: input.connectionId,
        providerKey: loaded.state.providerKey!,
        environment: loaded.state.environment!,
        credentialReference: loaded.state.credentialReference,
        bindings: loaded.state.bindings,
      });
      return commandHandler({
        streamId: streamId(input.connectionId),
        expectedVersion: loaded.version,
        command: { type: "ResumeChannelConnection" },
        context,
      });
    },
    disconnectChannelConnection: async (input, context) => {
      assertClosedRecord(input, ["accountId", "connectionId"], "disconnect input");
      const loaded = await loadOwned(input.accountId, input.connectionId);
      return commandHandler({
        streamId: streamId(input.connectionId),
        expectedVersion: loaded.version,
        command: { type: "DisconnectChannelConnection" },
        context,
      });
    },
    getConnection: (input) => getPublicChannelConnection(deps.db, input),
    listConnections: (input) => listPublicChannelConnections(deps.db, input),
    projectors,
  };

  return services;
}

function credentialIsCurrent(
  value: Awaited<ReturnType<ChannelCredentialAuthorityResolver["resolve"]>>,
  expected: Readonly<{ accountId: string; providerKey: string; environment: ChannelEnvironment }>,
): boolean {
  if (!value) return false;
  assertClosedRecord(
    value,
    ["accountId", "providerKey", "environment", "generation", "status"],
    "credential authority",
  );
  assertOpaqueId(value.accountId, "credential accountId");
  assertProviderKey(value.providerKey);
  assertChannelEnvironment(value.environment);
  assertSafeInteger(value.generation, "credential generation");
  if (!["current", "stale", "revoked"].includes(value.status)) {
    throw new ChannelConnectionError("invalid-input", "credential authority status is invalid.");
  }
  return (
    value.accountId === expected.accountId &&
    value.providerKey === expected.providerKey &&
    value.environment === expected.environment &&
    value.status === "current"
  );
}

function policyIsComplete(
  value: Awaited<ReturnType<ChannelPolicyAuthorityResolver["resolve"]>>,
  policyKey: string,
): boolean {
  if (!value) return false;
  assertClosedRecord(value, ["policyKey", "revision", "status"], "policy authority");
  assertSafeInteger(value.revision, "policy revision");
  if (value.status !== "complete" && value.status !== "incomplete") {
    throw new ChannelConnectionError("invalid-input", "policy authority status is invalid.");
  }
  return value.policyKey === policyKey && value.status === "complete";
}

function storageLocationIsCurrent(
  value: Awaited<ReturnType<ChannelStorageLocationAuthorityResolver["resolve"]>>,
  accountId: string,
  binding: ChannelConnectionBinding,
): boolean {
  if (!value) return false;
  assertClosedRecord(value, ["accountId", "storageLocationId", "revision", "status"], "storage authority");
  assertOpaqueId(value.accountId, "storage accountId");
  assertOpaqueId(value.storageLocationId, "storageLocationId");
  assertSafeInteger(value.revision, "storage revision");
  if (value.status !== "active" && value.status !== "retired") {
    throw new ChannelConnectionError("invalid-input", "storage authority status is invalid.");
  }
  return (
    value.accountId === accountId &&
    value.storageLocationId === binding.storageLocationId &&
    value.revision === binding.revision &&
    value.status === "active"
  );
}

function assertDeploymentEnvironment(value: unknown): asserts value is DeploymentEnvironment {
  if (!DEPLOYMENT_ENVIRONMENTS.includes(value as never)) {
    throw new ChannelConnectionError("invalid-input", "deploymentEnvironment is invalid.");
  }
}
