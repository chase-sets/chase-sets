import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  defineBoundedContextModule,
  type BcApiEntry,
  type BcEventSubscription,
} from "@chase-sets/bounded-context-module";
import { createProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { recordCommittedEvents, type StoredEvent } from "@chase-sets/event-core";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { attachWriteConsistencyMiddleware } from "./api-mounts";
import {
  applyCommittedProjectionEventsInline,
  projectionInlineApplyEnabled,
  type ProjectionInlineApplyOutcomeSignal,
} from "./inline-apply";
import { resolveModuleProjectionGroups } from "./projection-groups";
import { resolveModuleSubscriptions, type MountedContextRuntimeEntry } from "./subscriptions";
import type { ContextProjectionGroup } from "./projection-groups";

const NO_API_ENTRIES: readonly BcApiEntry[] = [];

function storedEvent(): StoredEvent {
  return {
    eventId: "evt_1" as StoredEvent["eventId"],
    streamId: "checkout.session-chk_1",
    streamVersion: 1,
    globalPosition: "1" as StoredEvent["globalPosition"],
    tenantId: "tnt_test" as StoredEvent["tenantId"],
    eventType: "checkout.session.started",
    payload: { sessionId: "chk_1" },
    metadata: {},
    occurredAt: "2026-07-19T00:00:00.000Z" as StoredEvent["occurredAt"],
    recordedAt: "2026-07-19T00:00:00.000Z" as StoredEvent["recordedAt"],
    performedByUserId: "usr_test" as StoredEvent["performedByUserId"],
    forAccountId: "acc_test" as StoredEvent["forAccountId"],
  };
}

function createQueryCaptureGroup(
  handler: NonNullable<ContextProjectionGroup["subscriptionRunners"][number]["handlers"]>[string],
  claimOutcome = "claimed",
): Readonly<{ group: ContextProjectionGroup; statements: string[] }> {
  const statements: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql.trim());
      if (sql.includes("AS outcome") && sql.includes("event_subscription_applications")) {
        return { rows: [{ outcome: claimOutcome }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
    end: vi.fn(async () => undefined),
    release: vi.fn(),
  };
  const pool = {
    query: client.query,
    connect: vi.fn(async () => client),
  } as unknown as PgTransactionalPool;
  const runner = {
    subscriptionName: "checkout.session-projection",
    handlerKind: "projection" as const,
    projectionName: "checkout.session-projection",
    sourceContextName: "checkout",
    targetContextName: "checkout",
    subscriptionVersion: 1,
    checkpointKey: "checkout.session-projection:checkout:v1",
    handlers: { "checkout.session.started": handler },
    inlineApply: true,
    checkpointBatchSize: 10,
    eventTypes: ["checkout.session.started"],
    streamPrefixes: ["checkout.session-"],
    order: 0,
  };
  const group = {
    projectionName: "checkout.session-projection",
    handlerKind: "projection" as const,
    projectionRevision: 1,
    targetContextName: "checkout",
    sourceContextNames: ["checkout"],
    optionalSourceContextNames: [],
    ownedTables: ["checkout_session_pages"],
    requiredDuringBootstrap: false,
    subscriptionRunners: [runner],
    targetPool: pool,
  } as unknown as ContextProjectionGroup;
  return { group, statements };
}

describe("projection inline apply", () => {
  it("defaults off and treats repeated disabled evaluation as a steady-state no-op", () => {
    expect(projectionInlineApplyEnabled({})).toBe(false);
    expect(projectionInlineApplyEnabled({ PROJECTION_INLINE_APPLY_ENABLED: "false" })).toBe(false);
    expect(projectionInlineApplyEnabled({ PROJECTION_INLINE_APPLY_ENABLED: "false" })).toBe(false);
    expect(projectionInlineApplyEnabled({ PROJECTION_INLINE_APPLY_ENABLED: "true" })).toBe(true);
  });

  it("uses one claim, the handler, and the runner completion ledger write", async () => {
    const handler = vi.fn(async (_event, context) => {
      await context?.db?.query("INSERT INTO checkout_session_pages VALUES ('chk_1')");
    });
    const { group, statements } = createQueryCaptureGroup(handler);
    const outcomes: ProjectionInlineApplyOutcomeSignal[] = [];

    await expect(
      applyCommittedProjectionEventsInline({
        committedEvents: [storedEvent()],
        commitSources: [{ sourceContextName: "checkout", eventIds: ["evt_1"] }],
        projectionGroups: [group],
        recordOutcome: (outcome) => outcomes.push(outcome),
      }),
    ).resolves.toEqual({ applied: 1, deferred: 0, failed: 0 });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      statements.filter(
        (statement) => !["BEGIN", "COMMIT"].includes(statement) && !statement.startsWith("SELECT set_config("),
      ),
    ).toHaveLength(3);
    expect(statements.some((statement) => statement.includes("ON CONFLICT (projection_key, event_id)"))).toBe(true);
    expect(statements.some((statement) => statement.includes("SET status = $3"))).toBe(true);
    expect(outcomes).toEqual([expect.objectContaining({ outcome: "applied", reason: "applied" })]);
  });

  it("defers an existing claim without running or stealing the handler", async () => {
    const handler = vi.fn(async () => undefined);
    const { group, statements } = createQueryCaptureGroup(handler, "in-flight");

    await expect(
      applyCommittedProjectionEventsInline({
        committedEvents: [storedEvent()],
        commitSources: [{ sourceContextName: "checkout", eventIds: ["evt_1"] }],
        projectionGroups: [group],
      }),
    ).resolves.toEqual({ applied: 0, deferred: 1, failed: 0 });

    expect(handler).not.toHaveBeenCalled();
    expect(statements.some((statement) => statement.includes("SET status = $3"))).toBe(false);
  });

  it("keeps handler failures and hard-budget overruns out of the command path", async () => {
    const failing = createQueryCaptureGroup(vi.fn(async () => Promise.reject(new Error("projection failed"))));
    await expect(
      applyCommittedProjectionEventsInline({
        committedEvents: [storedEvent()],
        commitSources: [{ sourceContextName: "checkout", eventIds: ["evt_1"] }],
        projectionGroups: [failing.group],
      }),
    ).resolves.toEqual({ applied: 0, deferred: 0, failed: 1 });
    expect(failing.statements).toContain("ROLLBACK");

    const slow = createQueryCaptureGroup(vi.fn(async () => new Promise<void>((resolve) => setTimeout(resolve, 30))));
    const startedAt = Date.now();
    await expect(
      applyCommittedProjectionEventsInline({
        committedEvents: [storedEvent()],
        commitSources: [{ sourceContextName: "checkout", eventIds: ["evt_1"] }],
        projectionGroups: [slow.group],
        budgetMs: 5,
      }),
    ).resolves.toEqual({ applied: 0, deferred: 0, failed: 1 });
    expect(Date.now() - startedAt).toBeLessThan(25);
  });

  it("executes zero projection statements while the kill switch is off", async () => {
    const handler = vi.fn(async () => undefined);
    const { group, statements } = createQueryCaptureGroup(handler);
    const app = new Hono();
    attachWriteConsistencyMiddleware(app, [{ mountPath: "/api/checkout" }], [group], { env: {} });
    app.post("/api/checkout/sessions", (context) => {
      recordCommittedEvents([storedEvent()]);
      return context.json({ id: "chk_1" }, 201);
    });

    expect((await app.request("/api/checkout/sessions", { method: "POST" })).status).toBe(201);
    expect(statements).toEqual([]);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("inline apply eligibility validation", () => {
  it.each([
    {
      name: "multi-source",
      sourceContextNames: ["checkout", "catalog"],
      handlerKind: "projection" as const,
      cascade: false,
      errorPolicy: undefined,
      sideEffectOnly: false,
      ownedTables: ["checkout_pages"],
      resetStrategy: "truncate-owned-tables" as const,
      expected: "single-source, same-context",
    },
    {
      name: "reaction",
      sourceContextNames: ["checkout"],
      handlerKind: "reaction" as const,
      cascade: false,
      errorPolicy: undefined,
      sideEffectOnly: false,
      ownedTables: ["checkout_pages"],
      resetStrategy: "truncate-owned-tables" as const,
      expected: "reaction handlers",
    },
    {
      name: "cascade",
      sourceContextNames: ["checkout"],
      handlerKind: "projection" as const,
      cascade: true,
      errorPolicy: undefined,
      sideEffectOnly: false,
      ownedTables: ["checkout_pages"],
      resetStrategy: "truncate-owned-tables" as const,
      expected: "cascade-capable projections",
    },
    {
      name: "global-strict",
      sourceContextNames: ["checkout"],
      handlerKind: "projection" as const,
      cascade: false,
      errorPolicy: "global-strict" as const,
      sideEffectOnly: false,
      ownedTables: ["checkout_pages"],
      resetStrategy: "truncate-owned-tables" as const,
      expected: "global-strict projections require total global order",
    },
    {
      name: "side-effect-only",
      sourceContextNames: ["checkout"],
      handlerKind: "projection" as const,
      cascade: false,
      errorPolicy: undefined,
      sideEffectOnly: true,
      ownedTables: [],
      resetStrategy: "replay-only" as const,
      expected: "side-effect-only handlers",
    },
  ])(
    "rejects $name projection declarations",
    ({
      sourceContextNames,
      handlerKind,
      cascade,
      errorPolicy,
      sideEffectOnly,
      ownedTables,
      resetStrategy,
      expected,
    }) => {
      const pool = { query: vi.fn() } as unknown as PgTransactionalPool;
      const set = createProjectionHandlerSet({
        projectionName: "checkout.pages",
        handlers: { "checkout.changed": async () => undefined },
        inlineApply: true,
      });
      const subscription: BcEventSubscription = {
        subscriptionName: "checkout.pages",
        handlerKind: "projection",
        sourceContextName: "checkout",
        projectionName: "checkout.pages",
        subscriptionVersion: 1,
        handlers: set.handlers,
        checkpointBatchSize: cascade ? 1 : 10,
        errorPolicy,
      };
      const module = defineBoundedContextModule({
        manifest: {
          contextName: "checkout",
          apiBasePath: "/api/checkout",
          streamPrefix: "checkout.",
          eventSubscriptions: [
            {
              sourceContextName: "checkout",
              projectionName: "checkout.pages",
              subscriptionVersion: 1,
              projectionHandlerSetNames: ["checkout.pages"],
            },
          ],
          projectionGroups: [
            {
              projectionName: "checkout.pages",
              handlerKind,
              sourceContextNames,
              ownedTables,
              sideEffectOnly,
              resetStrategy,
            },
          ],
        },
        schemaSql: "",
        createServices: () => ({}),
        buildApis: () => NO_API_ENTRIES,
        projectionHandlerSets: () => [set],
        buildSubscriptions: () => [subscription],
      });
      const mounted: MountedContextRuntimeEntry[] = [
        {
          contextName: "checkout",
          module,
          services: {},
          pool,
          projectionHandlerSets: [set],
        },
        ...(sourceContextNames.includes("catalog")
          ? [
              {
                contextName: "catalog",
                module: defineBoundedContextModule({
                  manifest: { contextName: "catalog", apiBasePath: "/api/catalog", streamPrefix: "catalog." },
                  schemaSql: "",
                  createServices: () => ({}),
                  buildApis: () => NO_API_ENTRIES,
                }),
                services: {},
                pool,
                projectionHandlerSets: [],
              } satisfies MountedContextRuntimeEntry,
            ]
          : []),
      ];
      const runners = resolveModuleSubscriptions(mounted);

      expect(() => resolveModuleProjectionGroups(mounted, runners)).toThrow(expected);
    },
  );
});
