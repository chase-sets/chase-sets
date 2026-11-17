import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BcSeedOptions } from "@chase-sets/bounded-context-module";
import { bootstrapContextDatabase, seedApiModuleIfEmpty } from "../bounded-context-runtime/index";
import {
  DISPOSABLE_REPRESENTATIVE_CATALOG_REPLAY_TIMEOUT_MS,
  seedApiHostIfEmpty,
  type ApiContextRegistry,
  type ApiHostRuntime,
  type ApiHostSeedOptions,
} from "./api";

vi.mock("../bounded-context-runtime/index", async (original) => ({
  ...(await original<object>()),
  bootstrapContextDatabase: vi.fn(async () => undefined),
  seedApiModuleIfEmpty: vi.fn(async (module, _pool, _services, options) => module.seed(options)),
  syncContextProjectionGroups: vi.fn(async () => undefined),
  drainProjectionGroups: vi.fn(async () => undefined),
}));

function fixture() {
  const seeds = {
    catalog: vi.fn(async (_options: BcSeedOptions) => undefined),
    discovery: vi.fn(async () => undefined),
  };
  const contexts = Object.entries(seeds).map(([contextName, seed]) => ({
    contextName,
    manifest: { contextName, apiDeployables: ["platform-api"] },
    module: { contextName, streamPrefix: `${contextName}.`, seedProfiles: ["representative-catalog"], seed },
  }));
  const registry = contexts as unknown as ApiContextRegistry;
  const runtime = {
    mountedContexts: contexts.map(({ contextName, module }) => ({
      contextName,
      module,
      pool: {},
      services: {},
      mountRole: "active",
    })),
  } as unknown as ApiHostRuntime;
  const options = {
    environmentName: "dev",
    enabledDataProfiles: ["critical-bootstrap", "catalog-integration-bootstrap", "representative-catalog"],
    substepTimeoutMs: 20,
    fullBootstrapDrain: true,
    schemaBootstrapLockAcquisition: { attempts: 1, waited: false },
    projectionGroupLeasePort: { runWithLease: async (_group, _signal, work) => work({}) },
  } satisfies ApiHostSeedOptions;
  return { registry, runtime, seeds, options };
}

describe("disposable representative Catalog replay timer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])("extends only seed:catalog with explicit replay=%s", async (explicit) => {
    const state = fixture();
    const timers: [string, number | undefined][] = [];
    let label = "";
    vi.mocked(console.log).mockImplementation((message) => {
      const match = /\[seed-api-host\] (.+) started\./.exec(String(message));
      if (match) label = match[1]!;
    });
    const setTimer = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
      timers.push([label, delay]);
      return setTimer(callback, delay, ...args);
    }) as typeof setTimeout);
    await seedApiHostIfEmpty(state.registry, "platform-api", state.runtime, {
      ...state.options,
      ...(explicit ? { disposableRepresentativeCatalogReplay: true } : {}),
    });
    expect(timers.some(([name]) => name === "seed:catalog")).toBe(true);
    expect(timers.some(([name]) => name === "seed-reconcile:catalog")).toBe(true);
    expect(timers.some(([name]) => name === "schema-bootstrap:catalog")).toBe(true);
    for (const [name, delay] of timers) {
      expect(delay).toBe(explicit && name === "seed:catalog" ? 14_400_000 : 20);
    }
    expect(DISPOSABLE_REPRESENTATIVE_CATALOG_REPLAY_TIMEOUT_MS).toBe(14_400_000);
    if (explicit) expect(state.seeds.catalog.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
    else expect(state.seeds.catalog.mock.calls[0]![0].signal).toBeUndefined();
  });

  it.each(["production", "staging", "preview", "test", "remote-dev", null])(
    "refuses an explicit replay in %s before any schema/seed mutation",
    async (environmentName) => {
      const state = fixture();
      await expect(
        seedApiHostIfEmpty(state.registry, "platform-api", state.runtime, {
          ...state.options,
          environmentName,
          disposableRepresentativeCatalogReplay: true,
        }),
      ).rejects.toThrow("explicit local representative bootstrap");
      expect(bootstrapContextDatabase).not.toHaveBeenCalled();
      expect(seedApiModuleIfEmpty).not.toHaveBeenCalled();
    },
  );

  it("refuses the explicit selector without the representative profile", async () => {
    const state = fixture();
    await expect(
      seedApiHostIfEmpty(state.registry, "platform-api", state.runtime, {
        ...state.options,
        enabledDataProfiles: ["critical-bootstrap"],
        disposableRepresentativeCatalogReplay: true,
      }),
    ).rejects.toThrow("explicit local representative bootstrap");
    expect(bootstrapContextDatabase).not.toHaveBeenCalled();
  });

  it("aborts at the selected deadline, settles workers and refuses without receipt or later work", async () => {
    const state = fixture();
    let release!: () => void;
    let signal: AbortSignal | undefined;
    const receipt = vi.fn();
    state.seeds.catalog.mockImplementationOnce(async (options) => {
      signal = options.signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      signal!.throwIfAborted();
      receipt();
    });
    // Collapse only the replay timer, not the surrounding schema/projection controls.
    const setTimer = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) =>
      setTimer(callback, delay === 14_400_000 ? 10 : delay, ...args)) as typeof setTimeout);
    let settled = false;
    const run = seedApiHostIfEmpty(state.registry, "platform-api", state.runtime, {
      ...state.options,
      disposableRepresentativeCatalogReplay: true,
    }).finally(() => {
      settled = true;
    });
    const rejected = expect(run).rejects.toMatchObject({
      code: "BOOTSTRAP_SEED_SUBSTEP_TIMEOUT",
      message: expect.stringContaining("seed:catalog' exceeded 14400000ms"),
    });
    await vi.advanceTimersByTimeAsync(11);
    expect(signal?.aborted).toBe(true);
    expect(settled).toBe(false);
    release();
    await rejected;
    expect(settled).toBe(true);
    expect(receipt).not.toHaveBeenCalled();
    expect(state.seeds.catalog).toHaveBeenCalledTimes(1);
    expect(state.seeds.discovery).not.toHaveBeenCalled();
  });
});
