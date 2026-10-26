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

import { seedApiHostIfEmpty, type ApiHostSeedOptions } from "./api";
import { createInlineSeedHarness, heldBootstrapLock, syntheticGroupKeys } from "./inline-seed-test-support";

const { alpha, beta, gamma, delta } = syntheticGroupKeys;
const runtimeGroups = [alpha, beta, delta].sort();

// Executes every seedApiHostIfEmptyWithHeldBootstrapLock path on the real seed API and real
// projection-groups.ts; the deployable callers are executed in
// deployables/platform-api/__tests__/inline-seed-caller-inventory.test.ts.
async function seed(options: Pick<ApiHostSeedOptions, "enabledDataProfiles" | "seedContextDrain">, waited = false) {
  const state = createInlineSeedHarness();
  await seedApiHostIfEmpty(state.registry, "platform-api", state.runtime, {
    ...options,
    environmentName: "test",
    schemaBootstrapLockAcquisition: heldBootstrapLock(waited),
    projectionGroupLeasePort: state.port,
  });
  const leasedGroups = Object.fromEntries(
    Object.entries(state.groupKeysBySubstep()).map(([substep, keys]) => [substep, [...new Set(keys)].sort()]),
  );
  return { ...state, leasedGroups, unheld: state.writes.filter((write) => !write.held) };
}

describe("inline seed caller inventory (seed API paths)", () => {
  beforeEach(() => {
    resetMockPoolState();
    vi.restoreAllMocks();
  });

  it("source-only seed drains its local groups under their leases", async () => {
    const state = await seed({ enabledDataProfiles: ["critical-bootstrap"] });

    expect(state.leasedGroups["projection-drain:gamma"]).toEqual([gamma]);
    expect(state.writes).toEqual(
      expect.arrayContaining([expect.objectContaining({ groupKey: gamma, operation: "handler", held: true })]),
    );
    expect(state.unheld).toEqual([]);
  });

  it("required seed reconciles bootstrap state between leased local syncs", async () => {
    const state = await seed({ enabledDataProfiles: ["critical-bootstrap"] });

    expect(state.reconciles).toEqual(["alpha"]);
    expect(state.leasedGroups["seed:alpha"]).toEqual([alpha]);
    expect(state.writes).toEqual(
      expect.arrayContaining([expect.objectContaining({ groupKey: alpha, operation: "TRUNCATE TABLE alpha_items" })]),
    );
    expect(state.unheld).toEqual([]);
  });

  it("queued twin reconciles or drains existing events under leases without general seed re-entry", async () => {
    const state = await seed({ enabledDataProfiles: ["critical-bootstrap"] }, true);

    expect(state.seeds).toEqual(["gamma", "gamma"]);
    expect(state.reconciles).toEqual(["alpha"]);
    expect(state.leasedGroups["seed:alpha"]).toEqual([alpha]);
    expect(state.leasedGroups["seed:delta"]).toEqual([delta]);
    expect(state.unheld).toEqual([]);
  });

  it("full bootstrap leases the required sync, the no-groups sync, and every global drain, reconcile and settle pass", async () => {
    const state = await seed({ enabledDataProfiles: ["critical-bootstrap", "scenario-seed"] });

    expect(state.leasedGroups).toEqual({
      "projection-sync:alpha": [alpha],
      "projection-drain:alpha": runtimeGroups,
      "projection-sync:beta": [beta],
      "projection-drain:beta": runtimeGroups,
      "projection-drain:gamma": [gamma],
      "projection-sync:delta": [delta],
      "projection-drain:delta": runtimeGroups,
      "projection-drain:all": runtimeGroups,
      "seed-reconcile:alpha": runtimeGroups,
      "seed-reconcile:beta": runtimeGroups,
      "seed-reconcile:gamma": runtimeGroups,
      "seed-reconcile:delta": runtimeGroups,
      "projection-settle:all": runtimeGroups,
    });
    expect(state.unheld).toEqual([]);
  });

  it("seed-context drain leases each owner's groups and skips the runtime-wide drains", async () => {
    const state = await seed({ enabledDataProfiles: ["critical-bootstrap"], seedContextDrain: true });

    expect(state.leasedGroups).toEqual({
      "projection-sync:alpha": [alpha],
      "projection-drain:alpha": [alpha],
      "projection-sync:beta": [beta],
      "projection-drain:beta": [beta],
      "projection-drain:gamma": [gamma],
      "projection-sync:delta": [delta],
      "projection-drain:delta": [delta],
      "seed-reconcile:alpha": [alpha],
      "seed-reconcile:beta": [beta],
      "seed-reconcile:delta": [delta],
    });
    expect(state.substeps.started).not.toContain("projection-drain:all");
    expect(state.substeps.started).not.toContain("projection-settle:all");
    expect(state.writes).toEqual(
      expect.arrayContaining([expect.objectContaining({ groupKey: beta, operation: "handler", held: true })]),
    );
    expect(state.unheld).toEqual([]);
  });
});
