import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createChannelConnectionRuntime } from "../api/runtime";
import type {
  ChannelConnectionHostPorts,
  ChannelConnectionSetupDeclaration,
  ChannelCredentialAuthorityResult,
} from "../domain/contracts";

export const fixedCreatedAt = "2026-09-05T12:34:56.789-05:00";
export const testContext: EventStoreContext = {
  tenantId: "tnt_channels" as never,
  audit: { performedByUserId: "usr_channels" as never, forAccountId: "acc_owner" as never },
};

export function createConnectionHarness(overrides: ChannelConnectionHostPorts = {}) {
  const memory = createInMemoryEventStore();
  const setups = new Map<string, ChannelConnectionSetupDeclaration>();
  const authorityCalls = { credential: 0, policy: 0, storage: 0, clock: 0 };
  const sandboxSetup: ChannelConnectionSetupDeclaration = {
    providerKey: "fixture-provider",
    environment: "sandbox",
    requirements: { credential: "required", requiredPolicyKeys: ["terms-accepted"], binding: "one-or-more-current" },
  };
  setups.set("fixture-provider:sandbox", sandboxSetup);
  const credential: ChannelCredentialAuthorityResult = {
    accountId: "acc_owner",
    providerKey: "fixture-provider",
    environment: "sandbox",
    generation: 1,
    status: "current",
  };
  const ports: ChannelConnectionHostPorts = {
    setupResolver: {
      resolve: async ({ providerKey, environment }) => setups.get(`${providerKey}:${environment}`) ?? null,
    },
    credentialAuthority: {
      resolve: async () => {
        authorityCalls.credential += 1;
        return credential;
      },
    },
    policyAuthority: {
      resolve: async ({ policyKey }) => {
        authorityCalls.policy += 1;
        return { policyKey, revision: 1, status: "complete" };
      },
    },
    storageLocationAuthority: {
      resolve: async ({ accountId, storageLocationId }) => {
        authorityCalls.storage += 1;
        return {
          accountId,
          storageLocationId,
          revision: Number(storageLocationId.split("_").at(-1) ?? 1),
          status: "active",
        };
      },
    },
    clock: {
      now: () => {
        authorityCalls.clock += 1;
        return fixedCreatedAt;
      },
    },
    ...overrides,
  };
  const services = createChannelConnectionRuntime(
    { eventStore: memory.eventStore, db: { query: async () => ({ rows: [] }) } },
    ports,
  );
  return { services, memory, setups, authorityCalls, sandboxSetup, ports };
}

export async function connectFixture(
  services: ReturnType<typeof createConnectionHarness>["services"],
  connectionId = "connection_1",
) {
  return services.connectChannel(
    { connectionId, accountId: "acc_owner", providerKey: "fixture-provider" },
    { deploymentEnvironment: "local" },
    testContext,
  );
}

export async function activateFixture(
  services: ReturnType<typeof createConnectionHarness>["services"],
  connectionId = "connection_1",
) {
  return services.activateChannelConnection(
    {
      accountId: "acc_owner",
      connectionId,
      credentialReference: "credential-reference-1",
      bindings: [{ storageLocationId: "location_1", revision: 1 }],
    },
    testContext,
  );
}
