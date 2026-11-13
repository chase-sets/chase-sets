import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetMockPoolState } from "../bounded-context-runtime/index-test-harness";

vi.mock("@chase-sets/event-core", async (original) => ({
  ...(await original<object>()),
  ...(await import("../bounded-context-runtime/index-test-harness")).createEventCoreMock(),
}));
vi.mock("@chase-sets/event-core-postgres", async (original) => ({
  ...(await original<object>()),
  ...(await import("../bounded-context-runtime/index-test-harness")).createEventCorePostgresMock(),
}));
vi.mock("../bounded-context-runtime/index", async (original) => ({
  ...(await original<object>()),
  bootstrapContextDatabase: vi.fn(async () => undefined),
  countEventsWithPrefix: vi.fn(async () => 1),
  seedApiModuleIfEmpty: vi.fn(async (module: { seed?: () => Promise<void> }) => module.seed?.()),
}));

import { syncContextProjectionGroups } from "../bounded-context-runtime/index";
import { seedApiHostIfEmpty, type ProjectionGroupLeasePort } from "./api";
import { createInlineSeedHarness, heldBootstrapLock, syntheticGroupKeys } from "./inline-seed-test-support";

const fullScenarioProfiles = ["critical-bootstrap", "scenario-seed"] as const;

describe("inline seed group lease (unit, real projection-groups paths)", () => {
  beforeEach(() => {
    resetMockPoolState();
    vi.restoreAllMocks();
  });

  it("resets, truncates, deletes checkpoints and advances runners only while that group's lease is held", async () => {
    const state = createInlineSeedHarness();

    await seedApiHostIfEmpty(state.registry, "platform-api", state.runtime, {
      enabledDataProfiles: fullScenarioProfiles,
      environmentName: "test",
      schemaBootstrapLockAcquisition: heldBootstrapLock(false),
      projectionGroupLeasePort: state.port,
    });

    expect(state.writes.filter((write) => !write.held)).toEqual([]);
    const operations = (groupKey: string) =>
      state.writes.filter((write) => write.groupKey === groupKey).map((write) => write.operation);
    // alpha's stale revision forces the reset path; every group's runner advances.
    expect(operations(syntheticGroupKeys.alpha)).toEqual(
      expect.arrayContaining([
        "TRUNCATE TABLE alpha_items",
        "DELETE FROM event_subscription_checkpoints",
        "WITH saved_checkpoint AS (",
        "handler",
      ]),
    );
    for (const groupKey of [syntheticGroupKeys.beta, syntheticGroupKeys.gamma, syntheticGroupKeys.delta]) {
      expect(operations(groupKey), groupKey).toEqual(expect.arrayContaining(["WITH saved_checkpoint AS (", "handler"]));
    }
  });

  it("does not reset, truncate, or advance a group whose lease another owner holds", async () => {
    const state = createInlineSeedHarness();
    const contended = new Error("projection-group:alpha.alpha-items is held by worker:platform");
    const port: ProjectionGroupLeasePort = {
      runWithLease: async (group, signal, work) => {
        if (`${group.targetContextName}.${group.projectionName}` === syntheticGroupKeys.alpha) throw contended;
        return state.port.runWithLease(group, signal, work);
      },
    };

    await expect(
      seedApiHostIfEmpty(state.registry, "platform-api", state.runtime, {
        enabledDataProfiles: fullScenarioProfiles,
        environmentName: "test",
        schemaBootstrapLockAcquisition: heldBootstrapLock(false),
        projectionGroupLeasePort: port,
      }),
    ).rejects.toBe(contended);

    expect(state.writes.filter((write) => write.groupKey === syntheticGroupKeys.alpha)).toEqual([]);
    expect(state.queries.filter((query) => query.startsWith("alpha: TRUNCATE"))).toEqual([]);
    expect(state.seeds).toEqual([]);
  });

  it("drains every context group under its own lease when a required-only sync finds no required group", async () => {
    const state = createInlineSeedHarness();
    state.append("alpha");

    await syncContextProjectionGroups(state.runtime, "beta", {
      requiredOnly: true,
      context: { signal: new AbortController().signal },
      runWithLease: state.port.runWithLease,
    });

    expect(state.leaseCalls).toEqual([` ${syntheticGroupKeys.beta}`, ` ${syntheticGroupKeys.beta}`]);
    expect(state.writes.filter((write) => write.groupKey === syntheticGroupKeys.beta)).toEqual(
      expect.arrayContaining([expect.objectContaining({ operation: "handler", held: true })]),
    );
    expect(state.writes.filter((write) => !write.held)).toEqual([]);
  });

  it("refuses an unleased seed drain when a context has subscriptions outside any projection group", async () => {
    const state = createInlineSeedHarness();
    const ungrouped = { ...state.runtime, projectionGroups: [] };

    await expect(
      syncContextProjectionGroups(ungrouped, "beta", { requiredOnly: true, runWithLease: state.port.runWithLease }),
    ).rejects.toThrow("refusing an unleased seed drain");
    expect(state.writes).toEqual([]);
  });
});
