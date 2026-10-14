import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainContextRuntime, syncContextProjectionGroups } from "../bounded-context-runtime/index";
import {
  seedApiHostIfEmpty,
  representativeCommerceStateDataProfiles,
  type ApiContextRegistry,
  type ApiHostRuntime,
} from "./api";

vi.mock("../bounded-context-runtime/index", async (original) => ({
  ...(await original<object>()),
  bootstrapContextDatabase: vi.fn(),
  withSchemaBootstrapLock: async (
    _pool: unknown,
    _options: unknown,
    run: (lock: { waited: boolean }) => Promise<void>,
  ) => run({ waited: false }),
  syncContextProjectionGroups: vi.fn(),
  drainContextRuntime: vi.fn(),
}));

function fixture(retained = false) {
  const operations: string[] = [];
  let committed = retained;
  let projected = false;
  let creations = 0;
  let interrupt = false;
  const query = vi.fn(async () => ({ rows: [{ count: committed ? "1" : "0" }] }));
  const seed = vi.fn(async () => {
    operations.push("seed");
    if (committed && !projected) throw new Error("synthetic retained prerequisite has not projected");
    if (!committed) {
      committed = true;
      creations += 1;
      if (interrupt) throw new Error("synthetic interruption after prerequisite commit");
    }
  });
  const module = {
    contextName: "synthetic-seed-owner",
    streamPrefix: "synthetic.",
    seedProfiles: ["representative-commerce-state"],
    seed,
  };
  const registry = [
    {
      contextName: module.contextName,
      manifest: { contextName: module.contextName, apiDeployables: ["platform-api"] },
      module,
    },
  ] as unknown as ApiContextRegistry;
  const runtime = {
    mountedContexts: [{ contextName: module.contextName, module, pool: { query }, services: {}, mountRole: "active" }],
  } as unknown as ApiHostRuntime;
  vi.mocked(syncContextProjectionGroups).mockImplementation(async (_runtime, context) => {
    expect(context).toBe(module.contextName);
    operations.push("sync");
    projected = committed;
  });
  return {
    registry,
    runtime,
    operations,
    seed,
    creations: () => creations,
    interrupt: () => {
      interrupt = true;
    },
  };
}

describe("representative seed-owner convergence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(drainContextRuntime).mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reaches the canary within the same budget while the ordinary full drain stalls on unrelated runners", async () => {
    const state = fixture(true);
    const unrelated = vi.fn(async () => new Promise<void>(() => undefined));
    vi.mocked(drainContextRuntime).mockImplementation(unrelated);
    const options = {
      enabledDataProfiles: representativeCommerceStateDataProfiles,
      environmentName: "staging",
      substepTimeoutMs: 20,
    };
    const full = seedApiHostIfEmpty(state.registry, "platform-api", state.runtime, {
      ...options,
      fullBootstrapDrain: true,
    });
    const rejected = expect(full).rejects.toThrow("projection-drain:synthetic-seed-owner");
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(unrelated).toHaveBeenCalledTimes(1);
    unrelated.mockClear();
    const canary = vi.fn();
    await seedApiHostIfEmpty(state.registry, "platform-api", state.runtime, {
      ...options,
      seedContextDrain: true,
    }).then(canary);
    expect(canary).toHaveBeenCalledTimes(1);
    expect(unrelated).not.toHaveBeenCalled();
    expect(state.creations()).toBe(0);
  });

  it.each([false, true])(
    "projects before/after seed and reconciles fresh=%s without duplicate creation",
    async (retained) => {
      const state = fixture(retained);
      const options = { enabledDataProfiles: representativeCommerceStateDataProfiles, seedContextDrain: true };
      await seedApiHostIfEmpty(state.registry, "platform-api", state.runtime, options);
      expect(state.operations).toEqual(["sync", "seed", "sync", "seed", "sync", "seed", "sync"]);
      await seedApiHostIfEmpty(state.registry, "platform-api", state.runtime, options);
      expect(state.creations()).toBe(retained ? 0 : 1);
      expect(drainContextRuntime).not.toHaveBeenCalled();
      expect(syncContextProjectionGroups).toHaveBeenCalledWith(state.runtime, "synthetic-seed-owner", {
        requiredOnly: false,
      });
    },
  );

  it("resumes a prerequisite committed before an interrupted seed's projection", async () => {
    const state = fixture();
    state.interrupt();
    const options = { enabledDataProfiles: representativeCommerceStateDataProfiles, seedContextDrain: true };
    await expect(seedApiHostIfEmpty(state.registry, "platform-api", state.runtime, options)).rejects.toThrow(
      "after prerequisite commit",
    );
    await seedApiHostIfEmpty(state.registry, "platform-api", state.runtime, options);
    expect(state.creations()).toBe(1);
    expect(drainContextRuntime).not.toHaveBeenCalled();
  });

  it("keeps ordinary scenario bootstrap's whole-runtime convergence", async () => {
    const state = fixture();
    await seedApiHostIfEmpty(state.registry, "platform-api", state.runtime, {
      enabledDataProfiles: [...representativeCommerceStateDataProfiles, "scenario-seed"],
    });
    expect(drainContextRuntime).toHaveBeenCalledTimes(5);
    expect(drainContextRuntime).toHaveBeenLastCalledWith(state.runtime, { settleIdleCheckpoints: true });
  });
});
