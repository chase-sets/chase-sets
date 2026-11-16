import { vi } from "vitest";
import { withConfigurationEpochTransaction } from "@chase-sets/event-core-postgres";

export { createConnectionPersistence } from "../api/owner-epochs";

export async function createConnectionEpochsForWitness(
  ...args: Parameters<typeof import("../api/owner-epochs").createConnectionEpochs>
) {
  return (await import("../api/owner-epochs")).createConnectionEpochs(...args);
}

type ConnectionRuntimeFactory = typeof import("../api/runtime").createChannelConnectionRuntime;
export async function disconnectChannelConnectionForWitness(
  options: Parameters<ConnectionRuntimeFactory>[0],
  ...args: Parameters<ReturnType<ConnectionRuntimeFactory>["disconnectChannelConnection"]>
) {
  const { createChannelConnectionRuntime } = await import("../api/runtime");
  return createChannelConnectionRuntime(options).disconnectChannelConnection(...args);
}

type SetupResolver = typeof import("../../publication-port/api/registry").channelProviderRegistry.setupResolver.resolve;
const control = vi.hoisted(() => ({
  omit: (): boolean => false,
  setupResolver: undefined as SetupResolver | undefined,
}));
export const connectionWriterProbe = control;

vi.mock("../../publication-port/api/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../publication-port/api/registry")>();
  const resolve: SetupResolver = async (input) =>
    (await control.setupResolver?.(input)) ?? actual.channelProviderRegistry.setupResolver.resolve(input);
  return {
    ...actual,
    channelProviderRegistry: { ...actual.channelProviderRegistry, setupResolver: { resolve } },
  };
});

vi.mock("../api/owner-epochs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/owner-epochs")>();
  const create: typeof actual.createConnectionEpochs = (pool, ...args) => {
    const epochs = actual.createConnectionEpochs(pool, ...args);
    return {
      ...epochs,
      transaction: (keys, work) =>
        control.omit() ? withConfigurationEpochTransaction(pool, work) : epochs.transaction(keys, work),
    };
  };
  return { ...actual, createConnectionEpochs: create };
});
