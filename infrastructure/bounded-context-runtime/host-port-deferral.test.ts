import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildEventSubscriptionsFromManifest,
  defineBoundedContextModule,
  type BcApiModule,
} from "@chase-sets/bounded-context-module";
import {
  createEventCoreMock,
  createEventCorePostgresMock,
  createMockPool,
  createStoredEvent,
  getCheckpointStore,
  resetMockPoolState,
  sourceEventsByPool,
} from "./index-test-harness";
import type { MountedContextRuntimeEntry } from "./subscriptions";
vi.mock("@chase-sets/event-core", () => createEventCoreMock());
vi.mock("@chase-sets/event-core-postgres", () => createEventCorePostgresMock());
import { drainContextProcesses, resolveModuleSubscriptions } from "./subscriptions";
import { resolveModuleProjectionGroups, syncContextProjectionGroups } from "./projection-groups";

const declaration = {
  sourceContextName: "source",
  projectionName: "target-facts",
  subscriptionVersion: 1,
  projectionHandlerSetNames: ["target-facts"],
  eventTypes: ["source.created"],
  deferUntilHostPort: "activation",
} as const;
const group = {
  projectionName: "target-facts",
  sourceContextNames: ["source"],
  ownedTables: ["target_facts"],
  resetStrategy: "replay-only",
  requiredDuringBootstrap: false,
} as const;

function fixture(available = false, overrides: Partial<BcApiModule> = {}) {
  const sourcePool = createMockPool();
  const targetPool = createMockPool();
  const handler = vi.fn(async () => undefined);
  const manifest = {
    contextName: "target",
    apiBasePath: "/target",
    streamPrefix: "target.",
    hostPorts: [{ portName: "activation" }],
    eventSubscriptions: [declaration],
    projectionGroups: [group],
  };
  const module: BcApiModule = {
    ...defineBoundedContextModule({
      manifest,
      schemaSql: "",
      createServices: () => ({}),
      buildApis: () => [],
      hasHostPort: () => available,
      buildSubscriptions: () =>
        buildEventSubscriptionsFromManifest({
          contextName: "target",
          manifest,
          handlers: available ? { "source.target-facts": () => ({ "source.created": handler }) } : {},
        }),
    }),
    ...overrides,
  };
  const sourceModule: BcApiModule = {
    contextName: "source",
    routePrefix: "/source",
    streamPrefix: "source.",
    schemaSql: "",
    apiMounts: [],
    createServices: () => ({}),
    buildApis: () => [],
  };
  const entries: MountedContextRuntimeEntry[] = [
    { contextName: "source", module: sourceModule, services: {}, pool: sourcePool as never, projectionHandlerSets: [] },
    { contextName: "target", module, services: {}, pool: targetPool as never, projectionHandlerSets: [] },
  ];
  sourceEventsByPool.set(sourcePool, [createStoredEvent("1", "source.created", { id: "fact-1" })]);
  return { entries, targetPool, handler };
}

describe("host port subscription deferral", () => {
  beforeEach(resetMockPoolState);

  it("keeps absent-port work out of every drain without checkpoints or a caught-up group", async () => {
    const { entries, targetPool, handler } = fixture();
    const runners = resolveModuleSubscriptions(entries);
    const groups = resolveModuleProjectionGroups(entries, runners);
    expect(runners).toEqual([]);
    expect(groups).toEqual([]);
    await drainContextProcesses({ subscriptionRunners: runners });
    const runtime = { mountedContexts: entries, projectionGroups: groups };
    await syncContextProjectionGroups(runtime, "target", { requiredOnly: true });
    await syncContextProjectionGroups(runtime, "target");
    await syncContextProjectionGroups(runtime, "target");
    expect(handler).not.toHaveBeenCalled();
    expect(getCheckpointStore(targetPool).size).toBe(0);
  });

  it("mounts the complete normal group with unchanged identity when available", async () => {
    const { entries, targetPool, handler } = fixture(true);
    const runners = resolveModuleSubscriptions(entries);
    const groups = resolveModuleProjectionGroups(entries, runners);
    expect(groups).toHaveLength(1);
    expect(runners[0]!.checkpointKey).toBe("target-facts:source:v1");
    await runners[0]!.runOnce();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getCheckpointStore(targetPool).get("target-facts:source:v1")).toBe("1");
  });

  it.each([
    [
      "undeferred omission",
      { eventSubscriptions: [{ ...declaration, deferUntilHostPort: undefined }] },
      /no registered handler/,
    ],
    [
      "unknown port",
      { eventSubscriptions: [{ ...declaration, deferUntilHostPort: "unknown" }] },
      /unknown deferUntilHostPort/,
    ],
    ["empty port", { eventSubscriptions: [{ ...declaration, deferUntilHostPort: "" }] }, /invalid or unknown/],
    ["missing resolver", { hasHostPort: undefined }, /no hasHostPort resolver/],
    ["required group", { projectionGroups: [{ ...group, requiredDuringBootstrap: true }] }, /non-required/],
    ["missing group", { projectionGroups: [] }, /exactly one/],
    [
      "partial sources",
      { projectionGroups: [{ ...group, sourceContextNames: ["source", "other"] }] },
      /mixed or partial/,
    ],
    [
      "mixed declarations",
      {
        eventSubscriptions: [
          declaration,
          { ...declaration, sourceContextName: "other", deferUntilHostPort: undefined },
        ],
        projectionGroups: [{ ...group, sourceContextNames: ["source", "other"] }],
      },
      /mixed or partial/,
    ],
  ] as const)("rejects %s rather than weakening omission", (_name, overrides, message) => {
    const { entries } = fixture(false, overrides);
    expect(() => resolveModuleSubscriptions(entries)).toThrow(message);
    if (_name !== "undeferred omission") expect(() => resolveModuleProjectionGroups(entries, [])).toThrow(message);
  });

  it("rejects built handlers while the port is absent", () => {
    const { entries } = fixture(true, { hasHostPort: () => false });
    expect(() => resolveModuleSubscriptions(entries)).toThrow("must not build handlers");
  });

  it("keeps missing handlers strict when the port is present", () => {
    const { entries } = fixture(false, { hasHostPort: () => true });
    expect(() => resolveModuleSubscriptions(entries)).toThrow("no registered handler");
  });

  it("retains source presence checks for deferred subscriptions and groups", () => {
    const { entries } = fixture();
    const targetOnly = entries.slice(1);
    expect(() => resolveModuleSubscriptions(targetOnly)).toThrow("not mounted");
    expect(() => resolveModuleProjectionGroups(targetOnly, [])).toThrow("not mounted");
  });

  it("retains table ownership checks even between deferred groups", () => {
    const second = { ...declaration, projectionName: "second-facts" };
    const { entries } = fixture(false, {
      eventSubscriptions: [declaration, second],
      projectionGroups: [group, { ...group, projectionName: "second-facts" }],
    });
    expect(() => resolveModuleProjectionGroups(entries, [])).toThrow("owned by both");
  });

  it("never suppresses unrelated unconditional declarations", () => {
    const { entries } = fixture(false, {
      eventSubscriptions: [
        declaration,
        { ...declaration, projectionName: "unconditional", deferUntilHostPort: undefined },
      ],
    });
    expect(() => resolveModuleSubscriptions(entries)).toThrow("no registered handler");
  });
});
