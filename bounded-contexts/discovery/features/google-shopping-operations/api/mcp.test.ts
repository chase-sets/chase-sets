import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { OperatorAuthorityDecision } from "@chase-sets/auth-context";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import {
  createMcpRoutes,
  validateMcpModuleRegistrations,
  type McpAuditRecord,
  type McpToolHandlerInput,
} from "@chase-sets/platform-runtime/mcp";
import {
  findMcpTool,
  getMcpToolConfirmationExpectedValue,
  mcpServiceCatalog,
  validateMcpServiceCatalog,
} from "@chase-sets/platform-runtime/mcp-contracts";
import { contextManifest } from "../../../index";
import { createGoogleShoppingMcpHandlers } from "./mcp";
import {
  toGoogleShoppingFullSyncJobStatus,
  createGoogleShoppingSyncRuntime,
  type GoogleShoppingFullSyncJob,
  type GoogleShoppingMaintenancePreview,
} from "./sync-job";

const prefix = "discovery.";
const fullSync = `${prefix}enqueue-google-shopping-dry-run-full-sync`;
const maintenance = `${prefix}enqueue-google-shopping-dry-run-maintenance-sync`;
const diagnostics = `${prefix}enqueue-google-shopping-diagnostics-refresh`;
const getJob = `${prefix}get-google-shopping-sync-job`;
const listRows = `${prefix}list-google-shopping-feed-rows`;
const names = [diagnostics, fullSync, maintenance, getJob, listRows];
const actor: ResolvedActor = {
  sessionId: "sess_operator",
  tenantId: "tnt_operator",
  userId: "usr_operator",
  accountId: "acc_operator",
  membershipId: "mem_operator",
  roleKey: "platform-admin",
  permissions: ["google-shopping.manage"],
  agentGrant: {
    grantId: "lpa_operator",
    platformProfileUrl: "https://agent.test/.well-known/ucp",
    scopes: ["operations:write"],
    rolePermissions: ["google-shopping.manage"],
  },
};
const authority: OperatorAuthorityDecision = {
  kind: "granted",
  membershipId: actor.membershipId,
  roleKey: "platform-admin",
  rolePermissions: actor.permissions,
};
const timestamp = "2026-10-16T00:00:00.000Z";
const job: GoogleShoppingFullSyncJob = {
  jobId: "job_sync",
  jobKind: "full-sync",
  payload: { mode: "dry-run", batchSize: 100, requestedByUserId: actor.userId, requestedForAccountId: actor.accountId },
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
  eventContext: null,
  claimOwnerId: null,
  claimedUntil: null,
  attemptCount: 0,
  nextEligibleAt: timestamp,
  createdAt: timestamp,
  startedAt: null,
  completedAt: null,
  updatedAt: timestamp,
};
const summary: GoogleShoppingMaintenancePreview = {
  mode: "dry-run",
  refreshWindowDays: 25,
  refreshCutoff: timestamp,
  limit: 100,
  retentionDays: 90,
  refresh: [],
  cleanup: [],
  total: 0,
};
const feed = {
  generatedAt: timestamp,
  filter: "all" as const,
  search: "",
  limit: 100,
  refreshWindowDays: 25,
  refreshCutoff: timestamp,
  summary: {
    totalRows: 0,
    eligibleRows: 0,
    excludedRows: 0,
    attentionRows: 0,
    failedRows: 0,
    disapprovedRows: 0,
    pendingDeleteRows: 0,
    staleRows: 0,
    nearingRefreshRows: 0,
    pendingDiagnosticsRows: 0,
  },
  rows: [],
};

function services() {
  return {
    enqueueFullSyncJob: vi.fn(async () => job),
    enqueueDiagnosticsRefreshJob: vi.fn(async () => job),
    enqueueMaintenanceSyncJob: vi.fn(async () => ({ summary, job: null as GoogleShoppingFullSyncJob | null })),
    getFullSyncJob: vi.fn(async (_jobId: string): Promise<GoogleShoppingFullSyncJob | null> => job),
    listFeedRows: vi.fn(async () => feed),
  } satisfies Parameters<typeof createGoogleShoppingMcpHandlers>[0];
}

function writeArgs(name: string, extra: Record<string, unknown> = {}) {
  return {
    mode: "dry-run",
    confirmed: true,
    confirmationText: getMcpToolConfirmationExpectedValue(findMcpTool(name)!),
    idempotencyKey: "synthetic-action-1",
    ...extra,
  };
}

function harness(sync = services()) {
  let currentActor: ResolvedActor | null = actor;
  let decision: OperatorAuthorityDecision = authority;
  const audit = vi.fn(async (_record: McpAuditRecord): Promise<void> => undefined);
  const handlers = createGoogleShoppingMcpHandlers(sync).toolHandlers;
  const seen = vi.fn((input: McpToolHandlerInput) => handlers[input.tool.name]!(input));
  const app = new Hono<{ Variables: { actor: ResolvedActor | null } }>();
  app.use("*", async (c, next) => {
    c.set("actor", currentActor);
    await next();
  });
  app.route(
    "/",
    createMcpRoutes({
      toolHandlers: Object.fromEntries(names.map((name) => [name, seen])),
      operatorAuthority: async () => decision,
      allowInMemoryIdempotencyStoreForTests: true,
      audit: (record) => audit(record),
    }),
  );
  return {
    sync,
    audit,
    seen,
    setActor: (value: ResolvedActor | null) => {
      currentActor = value;
    },
    setAuthority: (value: OperatorAuthorityDecision) => {
      decision = value;
    },
    async call(name: string, args: Record<string, unknown> = {}) {
      const response = await app.request("/", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "request_1",
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      return response.json() as Promise<{
        error?: { code: number; message: string };
        result: { isError?: boolean; structuredContent?: unknown; content: { text: string }[] };
      }>;
    },
  };
}

describe("Google Shopping MCP", () => {
  it("MCP source-call contract coverage", async () => {
    const h = harness();
    expect(contextManifest.agentCoverage["google-shopping"].tools).toEqual(names);
    expect(Object.keys(createGoogleShoppingMcpHandlers(h.sync).toolHandlers)).toEqual(names);
    const route = readFileSync(new URL("../../../routes/admin/google-shopping.tsx", import.meta.url), "utf8");
    const mappedCalls = [
      "listFeedRows",
      "enqueueFullSyncJob",
      "enqueueMaintenanceSyncJob",
      "enqueueDiagnosticsRefreshJob",
    ];
    expect([...route.matchAll(/await api\.(\w+)\(/g)].map((match) => match[1]).sort()).toEqual([...mappedCalls].sort());
    expect(route).toContain(
      'intent === "live-full-sync" || intent === "live-maintenance-sync" || intent === "targeted-retry"',
    );
    for (const name of [fullSync, diagnostics]) {
      expect((await h.call(name, writeArgs(name, { batchSize: 25 }))).result.structuredContent).toEqual(
        toGoogleShoppingFullSyncJobStatus(job),
      );
    }
    expect(
      (await h.call(maintenance, writeArgs(maintenance, { limit: 10, refreshWindowDays: 20 }))).result
        .structuredContent,
    ).toEqual({ summary, job: null });
    h.sync.enqueueMaintenanceSyncJob.mockResolvedValue({ summary: { ...summary, total: 1 }, job });
    expect(
      (await h.call(maintenance, writeArgs(maintenance, { idempotencyKey: "synthetic-action-2" }))).result
        .structuredContent,
    ).toEqual({ summary: { ...summary, total: 1 }, job: toGoogleShoppingFullSyncJobStatus(job) });
    expect((await h.call(getJob, { jobId: job.jobId })).result.structuredContent).toEqual(
      toGoogleShoppingFullSyncJobStatus(job),
    );
    expect(
      (await h.call(listRows, { filter: "stale", search: " Charizard ", limit: 20, refreshWindowDays: 10 })).result
        .structuredContent,
    ).toEqual(feed);
    const context = {
      tenantId: actor.tenantId,
      audit: { performedByUserId: actor.userId, forAccountId: actor.accountId },
      trace: {},
    };
    expect(h.sync.enqueueFullSyncJob).toHaveBeenCalledWith({ mode: "dry-run", batchSize: 25 }, context);
    expect(h.sync.enqueueDiagnosticsRefreshJob).toHaveBeenCalledWith({ mode: "dry-run", batchSize: 25 }, context);
    expect(h.sync.enqueueMaintenanceSyncJob).toHaveBeenCalledWith(
      { mode: "dry-run", limit: 10, refreshWindowDays: 20 },
      context,
    );
    expect(h.sync.getFullSyncJob).toHaveBeenCalledWith(job.jobId);
    expect(h.sync.listFeedRows).toHaveBeenCalledWith({
      filter: "stale",
      search: "Charizard",
      limit: 20,
      refreshWindowDays: 10,
    });
    expect(h.seen.mock.calls.every(([input]) => input.actor?.agentGrant === actor.agentGrant)).toBe(true);
    const registration = {
      contextName: "discovery",
      capabilities: { tools: names.map((name) => ({ name, ownerSlice: "google-shopping-operations" })) },
      handlers: createGoogleShoppingMcpHandlers(h.sync),
    };
    const service = mcpServiceCatalog.find((entry) => entry.serviceId === "discovery")!;
    const ownedCatalog = [
      { ...service, tools: service.tools.filter((tool) => names.includes(tool.name)), resources: [] },
    ];
    expect(validateMcpModuleRegistrations([registration], ownedCatalog)).toEqual([]);
    for (const omitted of names) {
      const handlers = { toolHandlers: { ...registration.handlers.toolHandlers } };
      delete handlers.toolHandlers[omitted];
      expect(validateMcpModuleRegistrations([{ ...registration, handlers }], ownedCatalog).join("\n")).toContain(
        omitted,
      );
    }
  });

  it("publishes exactly the frozen schemas, risk, permission and guardrails", () => {
    expect(validateMcpServiceCatalog(mcpServiceCatalog)).toEqual([]);
    const inputs = [
      [diagnostics, ["mode", "batchSize", "idempotencyKey", "confirmed", "confirmationText"]],
      [fullSync, ["mode", "batchSize", "idempotencyKey", "confirmed", "confirmationText"]],
      [maintenance, ["mode", "limit", "refreshWindowDays", "idempotencyKey", "confirmed", "confirmationText"]],
      [getJob, ["jobId"]],
      [listRows, ["filter", "search", "limit", "refreshWindowDays"]],
    ] as const;
    for (const [name, fields] of inputs) {
      const tool = findMcpTool(name)!;
      const write = name !== getJob && name !== listRows;
      expect(mcpServiceCatalog.flatMap((entry) => entry.tools).filter((entry) => entry.name === name)).toHaveLength(1);
      expect(Object.keys(tool.inputSchema.properties).sort()).toEqual([...fields].sort());
      expect(tool).toMatchObject({
        availability: "available",
        risk: write ? "sensitive" : "read",
        inputSchema: { additionalProperties: false },
        permissionBoundary: {
          scope: "operator",
          requiredPermissions: ["google-shopping.manage"],
          requiredScopes: [],
          accountScoped: false,
        },
        guardrails: {
          confirmation: { required: write },
          idempotencyKey: write ? "required" : "not-applicable",
          idempotencyAuthority: "platform",
        },
      });
      if (write) expect(tool.inputSchema.properties.mode).toMatchObject({ type: "string", enum: ["dry-run"] });
    }
  });

  it.each([fullSync, diagnostics, maintenance])(
    "confirms and deduplicates %s, rejecting conflicting and unauthorized replay",
    async (name) => {
      const h = harness();
      for (const change of [{ confirmed: false }, { confirmationText: "wrong title" }, { idempotencyKey: "" }]) {
        expect((await h.call(name, writeArgs(name, change))).result.isError).toBe(true);
        expect(h.seen).not.toHaveBeenCalled();
      }
      const args = writeArgs(name);
      const first = await h.call(name, args);
      expect(first.result.isError).not.toBe(true);
      expect(await h.call(name, args)).toEqual(first);
      expect(h.seen).toHaveBeenCalledTimes(1);
      const changed = name === maintenance ? { limit: 2 } : { batchSize: 2 };
      expect((await h.call(name, { ...args, ...changed })).result.isError).toBe(true);
      h.setAuthority({ kind: "denied", reason: "inactive" });
      expect((await h.call(name, args)).result.isError).toBe(true);
      expect(h.seen).toHaveBeenCalledTimes(1);
      expect(h.audit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          outcome: "denied",
          actorId: actor.userId,
          accountId: actor.accountId,
          agentGrantId: actor.agentGrant!.grantId,
        }),
      );
    },
  );

  it.each(names)(
    "denies unauthenticated, demoted, read-grant writes and missing-permission actors for %s",
    async (name) => {
      const h = harness();
      const args = name === getJob ? { jobId: job.jobId } : name === listRows ? {} : writeArgs(name);
      h.setActor(null);
      expect((await h.call(name, args)).error).toMatchObject({ code: -32001 });
      h.setActor(actor);
      h.setAuthority({ kind: "denied", reason: "not-platform-admin" });
      expect((await h.call(name, args)).result.isError).toBe(true);
      h.setAuthority({ ...authority, rolePermissions: [] });
      expect((await h.call(name, args)).result.isError).toBe(true);
      expect(h.seen).not.toHaveBeenCalled();
      h.setAuthority(authority);
      h.setActor({ ...actor, agentGrant: { ...actor.agentGrant!, scopes: ["operations:read"] } });
      const readGrant = await h.call(name, args);
      if (name === getJob || name === listRows) {
        expect(readGrant.result.isError).not.toBe(true);
        expect(h.seen).toHaveBeenCalledTimes(1);
      } else {
        expect(readGrant.result.isError).toBe(true);
        expect(h.seen).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    [fullSync, { mode: "live" }],
    [diagnostics, { mode: "live" }],
    [maintenance, { mode: "live" }],
    [fullSync, { batchSize: "25" }],
    [fullSync, { batchSize: 0 }],
    [maintenance, { refreshWindowDays: -1 }],
    [listRows, { filter: "unrecognized" }],
    [listRows, { limit: 1.5 }],
    [getJob, { jobId: "" }],
    [fullSync, { accountId: "acc_other" }],
    [getJob, { accountId: "acc_other" }],
    [listRows, { userId: "usr_other" }],
  ])("rejects invalid or overriding %s input %j before effects", async (name, extra) => {
    const h = harness();
    const args = name === getJob ? { jobId: job.jobId } : name === listRows ? {} : writeArgs(name);
    expect((await h.call(name, { ...args, ...extra })).result.isError).toBe(true);
    for (const service of Object.values(h.sync)) expect(service).not.toHaveBeenCalled();
  });

  it("uses owner defaults and surfaces missing jobs and service failures instead of empty success", async () => {
    const h = harness();
    await h.call(fullSync, writeArgs(fullSync, { mode: undefined }));
    expect(h.sync.enqueueFullSyncJob).toHaveBeenCalledWith(
      { mode: "dry-run", batchSize: undefined },
      expect.anything(),
    );
    h.sync.getFullSyncJob.mockResolvedValue(null);
    expect((await h.call(getJob, { jobId: "missing" })).result.isError).toBe(true);
    h.sync.listFeedRows.mockRejectedValue(new Error("synthetic query failure"));
    expect((await h.call(listRows)).result.content[0]!.text).toContain("synthetic query failure");
    expect(h.audit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it.each([fullSync, diagnostics, maintenance])(
    "writes operator attribution into the durable job insert for %s",
    async (name) => {
      const inserts: { payload: Record<string, unknown>; context: Record<string, unknown> }[] = [];
      const db: PgQueryable = {
        async query<Row>(sql: string, values: readonly unknown[] = []) {
          let rows: unknown[] = [];
          if (sql.includes("count(*)")) rows = [{ total: 1 }];
          else if (sql.includes("INSERT INTO discovery_google_shopping_sync_jobs")) {
            const payload = JSON.parse(String(values[2])) as Record<string, unknown>;
            const context = JSON.parse(String(values[4])) as Record<string, unknown>;
            inserts.push({ payload, context });
            rows = [
              {
                job_id: values[0],
                job_kind: values[1],
                status: "queued",
                payload,
                progress: JSON.parse(String(values[3])),
                event_context: context,
                created_at: timestamp,
                updated_at: timestamp,
              },
            ];
          } else if (sql.includes("RETURNING sequence")) rows = [{ sequence: 1 }];
          else if (sql.includes("AS action"))
            rows = [
              {
                action: "cleanup",
                row_id: "row_1",
                listing_id: "lst_1",
                merchant_offer_id: "offer_1",
                eligibility_status: "excluded",
                tombstone_status: "deleted",
                sync_status: "submitted",
                payload_hash: null,
                last_submitted_payload_hash: null,
                last_submitted_at: null,
                last_accepted_at: null,
                delete_submitted_at: null,
              },
            ];
          return { rows: rows as Row[], rowCount: rows.length };
        },
      };
      const handlers = createGoogleShoppingMcpHandlers(createGoogleShoppingSyncRuntime({ db }));
      await handlers.toolHandlers[name]!({
        actor,
        tool: findMcpTool(name)!,
        arguments: writeArgs(name, name === maintenance ? { limit: 1 } : { batchSize: 1000 }),
        request: new Request("https://api.test/mcp"),
        protocol: { protocolVersion: "2025-06-18", stateless: false, clientInfo: null, clientCapabilities: null },
      });
      expect(inserts).toHaveLength(1);
      expect(inserts[0]).toMatchObject({
        payload: { mode: "dry-run", requestedByUserId: actor.userId, requestedForAccountId: actor.accountId },
        context: {
          tenantId: actor.tenantId,
          audit: { performedByUserId: actor.userId, forAccountId: actor.accountId },
        },
      });
      if (name !== maintenance) expect(inserts[0]!.payload.batchSize).toBe(500);
      expect(inserts[0]!.payload).not.toHaveProperty("idempotencyKey");
    },
  );

  it.each(["denied", "failed"] as const)("awaits %s metadata-only audit", async (outcome) => {
    const h = harness();
    let release!: () => void;
    h.audit.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    h.sync.enqueueFullSyncJob.mockRejectedValue(new Error("synthetic enqueue failure"));
    const pending = h.call(fullSync, writeArgs(fullSync, { confirmed: outcome !== "denied" }));
    await vi.waitFor(() => expect(h.audit).toHaveBeenCalledTimes(1));
    let completed = false;
    void pending.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    release();
    await pending;
    const record = h.audit.mock.calls[0]![0];
    expect(record.outcome).toBe(outcome);
    expect(record).not.toHaveProperty("arguments");
    expect(record.sensitiveInputFields).toEqual(expect.arrayContaining(["idempotencyKey", "confirmationText"]));
  });
});
