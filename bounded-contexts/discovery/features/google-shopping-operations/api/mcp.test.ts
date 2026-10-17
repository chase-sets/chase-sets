import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { createGoogleShoppingMcpHandlers } from "./mcp";
import type { GoogleShoppingSyncServices } from "./sync-job";

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "platform-admin",
  permissions: ["google-shopping.manage"],
} satisfies ResolvedActor;

const job = {
  jobId: "job_1",
  jobKind: "full-sync",
  payload: { mode: "dry-run", batchSize: 100, requestedByUserId: "usr_1", requestedForAccountId: "acc_1" },
  progress: {
    phase: "queued",
    completed: 0,
    total: 0,
    currentRowId: null,
    submitted: 0,
    skipped: 0,
    deleted: 0,
    failed: 0,
    excluded: 0,
    message: null,
  },
  status: "queued",
  result: null,
  errorMessage: null,
  createdAt: "2026-10-16T00:00:00.000Z",
  updatedAt: "2026-10-16T00:00:00.000Z",
} as never;

function input(arguments_: Record<string, unknown>, requestActor: ResolvedActor | null = actor) {
  return {
    actor: requestActor,
    tool: null as never,
    arguments: arguments_,
    request: new Request("https://api.test/mcp"),
    protocol: null as never,
  };
}

function services(overrides: Partial<GoogleShoppingSyncServices> = {}): GoogleShoppingSyncServices {
  return {
    enqueueFullSyncJob: vi.fn(async (_params, context) => {
      expect(context.audit.performedByUserId).toBe(actor.userId);
      return job;
    }),
    enqueueDiagnosticsRefreshJob: vi.fn(async () => job),
    enqueueMaintenanceSyncJob: vi.fn(async () => ({ summary: { total: 0 } as never, job: null })),
    getFullSyncJob: vi.fn(async () => job),
    listFeedRows: vi.fn(
      async () =>
        ({
          rows: [],
          summary: {},
          filter: "all",
          search: "",
          limit: 100,
          refreshWindowDays: 25,
          refreshCutoff: "",
        }) as never,
    ),
    ...({} as GoogleShoppingSyncServices),
    ...overrides,
  };
}

describe("MCP source-call contract coverage", () => {
  it("enqueues a dry-run full sync with actor attribution", async () => {
    const sync = services();
    const handler =
      createGoogleShoppingMcpHandlers(sync).toolHandlers["discovery.enqueue-google-shopping-dry-run-full-sync"]!;

    await handler(
      input({
        mode: "dry-run",
        batchSize: 25,
        idempotencyKey: "idem",
        confirmationText: "Enqueue Google Shopping Dry-Run Full Sync",
      }),
    );

    expect(sync.enqueueFullSync).toHaveBeenCalledWith(
      { mode: "dry-run", batchSize: 25 },
      expect.objectContaining({ audit: { performedByUserId: actor.userId, forAccountId: actor.accountId } }),
    );
  });

  it("rejects live mode before any effect", async () => {
    const sync = services();
    const handler =
      createGoogleShoppingMcpHandlers(sync).toolHandlers["discovery.enqueue-google-shopping-dry-run-full-sync"]!;

    await expect(handler(input({ mode: "live", idempotencyKey: "idem", confirmationText: "x" }))).rejects.toThrow(
      "only support dry-run mode",
    );
    expect(sync.enqueueFullSync).not.toHaveBeenCalled();
  });

  it("rejects an unauthorized actor before reads and writes", async () => {
    const sync = services();
    const handlers = createGoogleShoppingMcpHandlers(sync).toolHandlers;

    await expect(
      handlers["discovery.list-google-shopping-feed-rows"]!(input({}, { ...actor, permissions: [] })),
    ).rejects.toThrow("google-shopping.manage");
    await expect(
      handlers["discovery.enqueue-google-shopping-diagnostics-refresh"]!(input({ mode: "dry-run" }, null)),
    ).rejects.toThrow("authenticated operator");
    expect(sync.listFeedRows).not.toHaveBeenCalled();
    expect(sync.enqueueDiagnosticsRefreshJob).not.toHaveBeenCalled();
  });

  it("passes the bounded feed-row filters to the owning query", async () => {
    const sync = services();
    const handler = createGoogleShoppingMcpHandlers(sync).toolHandlers["discovery.list-google-shopping-feed-rows"]!;

    await handler(input({ filter: "stale", search: "Charizard", limit: 20, refreshWindowDays: 10 }));

    expect(sync.listFeedRows).toHaveBeenCalledWith({
      filter: "stale",
      search: "Charizard",
      limit: 20,
      refreshWindowDays: 10,
    });
  });
});
