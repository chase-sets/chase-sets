import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { OperatorAuthorityDecision, ResolvedActor } from "@chase-sets/auth-context";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createId } from "@chase-sets/primitives/typed-ids";
import { createMcpRoutes, type McpAuditSink } from "@chase-sets/platform-runtime/mcp";
import { flattenMcpTools } from "@chase-sets/platform-runtime/mcp-contracts";
import { contextManifest as manifest } from "../../../index";
import type { CatalogAuthoringBulkJob } from "../../../support/authoring-support/bulk-authoring-jobs";
import { decideBlueprint, evolveBlueprint, initialBlueprintState, type BlueprintEvent } from "../domain/domain";
import { getBlueprintDetail, type BlueprintRow } from "../read-model/queries";
import type { BlueprintServices } from "./runtime";
import { createBlueprintMcpHandlers } from "./mcp";

const id = createId("bpr");
const componentId = createId("cmp");
const fieldId = createId("fld");
const dimensionId = createId("dim");
const conditionalId = createId("dim");
const optionId = createId("chc");
const conditionalOptionId = createId("chc");
const text = { defaultLocale: "en", values: { en: "Cards", fr: "Cartes" } };
const dimensions = [
  { dimensionId, required: true, allowedOptionIds: [optionId] },
  {
    dimensionId: conditionalId,
    required: false,
    allowedOptionIds: [conditionalOptionId],
    appliesWhen: [{ dimensionId, optionIds: [optionId] }],
  },
];
const actor: ResolvedActor = {
  sessionId: "sess_operator",
  tenantId: "tenant",
  userId: "user_operator",
  accountId: "account_operator",
  membershipId: "membership_operator",
  roleKey: "platform-admin",
  permissions: ["catalog.view", "catalog.manage"],
};
const granted: OperatorAuthorityDecision = {
  kind: "granted",
  membershipId: actor.membershipId,
  roleKey: "platform-admin",
  rolePermissions: actor.permissions,
};
const row: BlueprintRow = {
  blueprint_id: id,
  key: "cards",
  name: "Cards",
  name_i18n: text,
  description: "",
  description_i18n: text,
  status: "draft",
  component_ids: [],
  field_rules: [],
  dimension_rules: [],
  canonical_dimension_order: [],
  updated_at: "2026-11-08T00:00:00.000Z",
};
const job: CatalogAuthoringBulkJob = {
  jobId: "job_blueprints",
  kind: "catalog.authoring.blueprints.lifecycle",
  action: "publish",
  status: "queued",
  progress: { phase: "queued", completed: 0, total: 1, currentName: null, status: null },
  result: null,
  errorMessage: null,
  createdAt: row.updated_at,
  updatedAt: row.updated_at,
  startedAt: null,
  completedAt: null,
};
const writes = [
  [
    "create-blueprint",
    "Create Blueprint",
    { key: "cards", name: text },
    { type: "CreateBlueprint", blueprintId: id, key: "cards", name: text },
  ],
  [
    "revise-blueprint",
    "Revise Blueprint",
    { key: "cards", name: text },
    { type: "ReviseBlueprint", key: "cards", name: text },
  ],
  ["attach-component", "Attach Component", { componentId }, { type: "AttachComponentToBlueprint", componentId }],
  ["detach-component", "Detach Component", { componentId }, { type: "DetachComponentFromBlueprint", componentId }],
  [
    "set-blueprint-fields",
    "Set Blueprint Fields",
    { fieldRules: [{ fieldId, required: true }] },
    { type: "SetBlueprintFields", fieldRules: [{ fieldId, required: true }] },
  ],
  [
    "set-blueprint-dimensions",
    "Set Blueprint Dimensions",
    { dimensionRules: dimensions },
    { type: "SetBlueprintDimensions", dimensionRules: dimensions },
  ],
  [
    "set-blueprint-product-resolution-rules",
    "Set Blueprint Product Resolution Rules",
    { canonicalDimensionOrder: [dimensionId, conditionalId] },
    { type: "SetBlueprintProductResolutionRules", canonicalDimensionOrder: [dimensionId, conditionalId] },
  ],
  ["publish-blueprint", "Publish Blueprint", {}, { type: "PublishBlueprint" }],
  ["deprecate-blueprint", "Deprecate Blueprint", {}, { type: "DeprecateBlueprint" }],
  ["archive-blueprint", "Archive Blueprint", {}, { type: "ArchiveBlueprint" }],
] as const;
const listTools = [
  "list-blueprints",
  "create-blueprint",
  "preview-bulk-blueprint-lifecycle",
  "confirm-bulk-blueprint-lifecycle",
  "get-authoring-job",
];
const detailTools = [
  "get-blueprint",
  "publish-blueprint",
  "deprecate-blueprint",
  "archive-blueprint",
  "revise-blueprint",
  "attach-component",
  "detach-component",
  "set-blueprint-product-resolution-rules",
  "set-blueprint-fields",
  "set-blueprint-dimensions",
];

function harness(audit?: McpAuditSink) {
  const { eventStore } = createInMemoryEventStore();
  const aggregate = createAggregateCommandHandler({
    eventStore,
    codec: createPassthroughDomainEventCodec<BlueprintEvent>(),
    initialState: () => initialBlueprintState,
    decide: decideBlueprint,
    evolve: evolveBlueprint,
  });
  const services = {
    commandHandler: vi.fn(aggregate.commandHandler),
    listBlueprints: vi.fn<BlueprintServices["listBlueprints"]>().mockResolvedValue({ items: [row], total: 1 }),
    getBlueprintDetail: vi.fn<BlueprintServices["getBlueprintDetail"]>().mockResolvedValue({ ...row, components: [] }),
    bulkLifecycle: {
      preview: vi.fn<BlueprintServices["bulkLifecycle"]["preview"]>().mockImplementation(async (selection, action) => ({
        mode: selection.mode,
        action,
        ids: selection.mode === "ids" ? selection.ids : [],
        total: 1,
        ready_count: 1,
        blocked_count: 0,
        candidates: [],
      })),
      execute: vi.fn<BlueprintServices["bulkLifecycle"]["execute"]>(),
    },
    projectors: [],
  } satisfies BlueprintServices;
  const jobs = { enqueue: vi.fn().mockResolvedValue(job), get: vi.fn().mockResolvedValue(job) };
  const handlers = createBlueprintMcpHandlers(services, jobs).toolHandlers;
  let currentActor: ResolvedActor | null = actor;
  let authority: OperatorAuthorityDecision = granted;
  const app = new Hono<{ Variables: { actor: ResolvedActor | null } }>();
  app.use("*", async (c, next) => {
    c.set("actor", currentActor);
    await next();
  });
  app.route(
    "/",
    createMcpRoutes({
      toolHandlers: handlers,
      operatorAuthority: async () => authority,
      allowInMemoryIdempotencyStoreForTests: true,
      audit,
    }),
  );
  return {
    services,
    jobs,
    handlers,
    eventStore,
    setActor: (value: ResolvedActor | null) => {
      currentActor = value;
    },
    setAuthority: (value: OperatorAuthorityDecision) => {
      authority = value;
    },
    async call(name: string, args: Record<string, unknown> = {}) {
      const response = await app.request("/", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "request",
          method: "tools/call",
          params: { name: `catalog.${name}`, arguments: args },
        }),
      });
      return response.json() as Promise<{
        result: { isError?: boolean; structuredContent?: unknown; content: { text: string }[] };
        error?: unknown;
      }>;
    },
  };
}
const confirmed = (title: string, key = title) => ({
  confirmed: true,
  confirmationText: `${title}.`,
  idempotencyKey: key,
});

describe("Blueprint MCP", () => {
  it("MCP source-call contract coverage", async () => {
    const h = harness();
    const expectedNames = [...listTools, ...detailTools].map((name) => `catalog.${name}`).sort();
    expect(Object.keys(h.handlers).sort()).toEqual(expectedNames);
    expect(manifest.agentCoverage.blueprints.tools).toEqual(listTools.map((name) => `catalog.${name}`));
    expect(manifest.agentCoverage["blueprints-detail"].tools).toEqual(detailTools.map((name) => `catalog.${name}`));
    expect(
      manifest.mcpCapabilities.tools
        .filter((entry) => entry.ownerSlice === "blueprints")
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(expectedNames);
    for (const name of expectedNames) {
      const descriptors = flattenMcpTools().filter((tool) => tool.name === name);
      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        availability: "available",
        permissionBoundary: { scope: "operator", requiredScopes: [], accountScoped: false },
      });
      const read = [
        "catalog.list-blueprints",
        "catalog.get-blueprint",
        "catalog.get-authoring-job",
        "catalog.preview-bulk-blueprint-lifecycle",
      ].includes(name);
      expect(descriptors[0]!.permissionBoundary.requiredPermissions).toEqual([
        read && name !== "catalog.preview-bulk-blueprint-lifecycle" ? "catalog.view" : "catalog.manage",
      ]);
      expect(descriptors[0]!.risk).toBe(
        read
          ? "read"
          : [
                "catalog.archive-blueprint",
                "catalog.detach-component",
                "catalog.confirm-bulk-blueprint-lifecycle",
              ].includes(name)
            ? "destructive"
            : "sensitive",
      );
      expect(descriptors[0]!.guardrails).toMatchObject({
        confirmation: { required: !read },
        idempotencyKey: read ? "not-applicable" : "required",
      });
    }
    for (const [name, title, args, command] of writes) {
      const result = await h.call(name, { blueprintId: id, ...args, ...confirmed(title) });
      expect(result.error, name).toBeUndefined();
      expect(result.result.isError, JSON.stringify(result)).not.toBe(true);
      expect(h.services.commandHandler).toHaveBeenLastCalledWith(
        expect.objectContaining({
          streamId: `catalog.blueprint-${id}`,
          command: expect.objectContaining(command),
          context: expect.objectContaining({
            audit: { performedByUserId: actor.userId, forAccountId: actor.accountId },
          }),
        }),
      );
    }
    const events = await h.eventStore.readStream({ streamId: `catalog.blueprint-${id}` });
    expect(events).toHaveLength(10);
    expect(
      events.every((event) => event.performedByUserId === actor.userId && event.forAccountId === actor.accountId),
    ).toBe(true);
    const list = await h.call("list-blueprints", {
      search: "cards",
      status: "draft",
      limit: 10,
      offset: 0,
      hasComponents: "false",
      hasFieldRules: "true",
      hasDimensionRules: "true",
    });
    expect(list.result.isError).not.toBe(true);
    expect(h.services.listBlueprints).toHaveBeenLastCalledWith({
      search: "cards",
      status: "draft",
      limit: 10,
      offset: undefined,
      hasComponents: "false",
      hasFieldRules: "true",
      hasDimensionRules: "true",
    });
    expect((await h.call("get-blueprint", { blueprintId: id })).result.isError).not.toBe(true);
    expect(h.services.getBlueprintDetail).toHaveBeenCalledWith(id);
    expect((await h.call("get-authoring-job", { jobId: job.jobId })).result.isError).not.toBe(true);
    expect(h.jobs.get).toHaveBeenCalledWith(
      job.jobId,
      expect.objectContaining({ audit: { performedByUserId: actor.userId, forAccountId: actor.accountId } }),
    );
    for (const selection of [
      { mode: "ids", ids: [id] },
      {
        mode: "filter",
        query: {
          search: " cards ",
          hasComponents: "false",
          hasFieldRules: "true",
          hasDimensionRules: "true",
          status: "draft",
        },
      },
    ]) {
      expect(
        (await h.call("preview-bulk-blueprint-lifecycle", { action: "publish", selection })).result.isError,
      ).not.toBe(true);
      expect(
        (
          await h.call("confirm-bulk-blueprint-lifecycle", {
            action: "publish",
            selection,
            ...confirmed("Confirm Bulk Blueprint Lifecycle", selection.mode),
          })
        ).result.isError,
      ).not.toBe(true);
      expect(h.services.bulkLifecycle.preview).toHaveBeenLastCalledWith({ mode: "ids", ids: [id] }, "publish");
      expect(h.jobs.enqueue).toHaveBeenLastCalledWith({
        kind: "catalog.authoring.blueprints.lifecycle",
        action: "publish",
        selection: { mode: "ids", ids: [id] },
        context: expect.objectContaining({ audit: { performedByUserId: actor.userId, forAccountId: actor.accountId } }),
      });
    }
    expect(h.services.listBlueprints).toHaveBeenLastCalledWith({
      search: "cards",
      hasComponents: "false",
      hasFieldRules: "true",
      hasDimensionRules: "true",
      status: "draft",
      limit: 500,
      offset: 0,
    });
    expect(h.services.bulkLifecycle.execute).not.toHaveBeenCalled();
  });

  it.each(writes)(
    "rejects missing, false, and mismatched confirmation before %s effects",
    async (name, title, args) => {
      const h = harness();
      for (const controls of [
        { idempotencyKey: "key" },
        { ...confirmed(title), confirmed: false },
        { ...confirmed(title), confirmationText: "wrong" },
        { ...confirmed(title), idempotencyKey: "" },
      ]) {
        expect((await h.call(name, { blueprintId: id, ...args, ...controls })).result.isError).toBe(true);
      }
      expect(h.services.commandHandler).not.toHaveBeenCalled();
    },
  );

  it("rejects unauthorized actors and stale live authority for every tool before effects", async () => {
    for (const candidate of [null, { ...actor, roleKey: "owner" }, { ...actor, accountId: "other" }]) {
      const h = harness();
      h.setActor(candidate);
      h.setAuthority({ kind: "denied", reason: "not-platform-admin" });
      for (const name of Object.keys(h.handlers)) {
        const response = await h.call(name.slice(8));
        expect(response.error !== undefined || response.result?.isError === true).toBe(true);
      }
      expect(h.services.commandHandler).not.toHaveBeenCalled();
      expect(h.jobs.enqueue).not.toHaveBeenCalled();
      expect(h.services.listBlueprints).not.toHaveBeenCalled();
      expect(h.services.getBlueprintDetail).not.toHaveBeenCalled();
      expect(h.jobs.get).not.toHaveBeenCalled();
    }
  });

  it("enforces each permission independently", async () => {
    const h = harness();
    h.setAuthority({ ...granted, rolePermissions: ["catalog.view"] });
    expect(
      (await h.call("preview-bulk-blueprint-lifecycle", { action: "publish", selection: { mode: "ids", ids: [id] } }))
        .result.isError,
    ).toBe(true);
    expect(
      (
        await h.call("create-blueprint", {
          blueprintId: id,
          key: "cards",
          name: text,
          ...confirmed("Create Blueprint"),
        })
      ).result.isError,
    ).toBe(true);
    expect((await h.call("get-blueprint", { blueprintId: id })).result.isError).not.toBe(true);
    expect(h.services.commandHandler).not.toHaveBeenCalled();
    expect(h.services.bulkLifecycle.preview).not.toHaveBeenCalled();
  });

  it.each([
    ["create-blueprint", { blueprintId: componentId, key: "cards", name: text }],
    ["create-blueprint", { blueprintId: id, key: "cards", name: { defaultLocale: "en", values: { en: 5 } } }],
    ["create-blueprint", { blueprintId: id, key: "cards", name: text, accountId: "other" }],
    ["attach-component", { blueprintId: id, componentId: id }],
    ["set-blueprint-fields", { blueprintId: id, fieldRules: [{ fieldId, required: "true" }] }],
    [
      "set-blueprint-dimensions",
      { blueprintId: id, dimensionRules: [{ ...dimensions[1], appliesWhen: [{ dimensionId, optionIds: [id] }] }] },
    ],
    ["set-blueprint-product-resolution-rules", { blueprintId: id, canonicalDimensionOrder: [componentId] }],
    ["confirm-bulk-blueprint-lifecycle", { action: "erase", selection: { mode: "ids", ids: [id] } }],
    ["confirm-bulk-blueprint-lifecycle", { action: "publish", selection: { mode: "filter" } }],
    ["confirm-bulk-blueprint-lifecycle", { action: "publish", selection: { mode: "ids", ids: [id], query: {} } }],
  ])("rejects invalid %s input before effects", async (name, args) => {
    const h = harness();
    const tool = flattenMcpTools().find((tool) => tool.name === `catalog.${name}`)!;
    expect((await h.call(name, { ...args, ...confirmed(tool.title) })).result.isError).toBe(true);
    expect(h.services.commandHandler).not.toHaveBeenCalled();
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("retries once, rejects conflicting and unauthorized replays, and retains persisted attribution", async () => {
    const h = harness();
    const args = { blueprintId: id, key: "cards", name: text, ...confirmed("Create Blueprint") };
    const first = await h.call("create-blueprint", args);
    expect(first.result.isError).not.toBe(true);
    expect((await h.call("create-blueprint", args)).result).toEqual(first.result);
    expect((await h.call("create-blueprint", { ...args, key: "other" })).result.isError).toBe(true);
    h.setAuthority({ kind: "denied", reason: "not-platform-admin" });
    expect((await h.call("create-blueprint", args)).result.isError).toBe(true);
    expect(h.services.commandHandler).toHaveBeenCalledTimes(1);
    expect(await h.eventStore.readStream({ streamId: `catalog.blueprint-${id}` })).toHaveLength(1);
  });

  it("deduplicates bulk enqueue and preserves action and selection on replay conflicts", async () => {
    const h = harness();
    const args = {
      action: "archive",
      selection: { mode: "ids", ids: [id] },
      ...confirmed("Confirm Bulk Blueprint Lifecycle"),
    };
    const first = await h.call("confirm-bulk-blueprint-lifecycle", args);
    expect(first.result.isError).not.toBe(true);
    expect((await h.call("confirm-bulk-blueprint-lifecycle", args)).result).toEqual(first.result);
    expect((await h.call("confirm-bulk-blueprint-lifecycle", { ...args, action: "publish" })).result.isError).toBe(
      true,
    );
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(1);
  });

  it("requires bulk confirmation before queueing and retains OAuth grant metadata in audit", async () => {
    const audit = vi.fn<McpAuditSink>();
    const h = harness(audit);
    h.setActor({
      ...actor,
      agentGrant: {
        grantId: "grant_operator",
        platformProfileUrl: "https://example.test/platform",
        scopes: ["operations:write"],
        rolePermissions: actor.permissions,
      },
    });
    const args = { action: "archive", selection: { mode: "ids", ids: [id] } };
    for (const controls of [
      { idempotencyKey: "bulk" },
      { ...confirmed("Confirm Bulk Blueprint Lifecycle"), confirmed: false },
      { ...confirmed("Confirm Bulk Blueprint Lifecycle"), confirmationText: "wrong" },
    ]) {
      expect((await h.call("confirm-bulk-blueprint-lifecycle", { ...args, ...controls })).result.isError).toBe(true);
    }
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        actorId: actor.userId,
        accountId: actor.accountId,
        agentGrantId: "grant_operator",
        agentGrantScopes: ["operations:write"],
      }),
    );
  });

  it("pages the complete filtered selection and rejects a truncated or changing selection", async () => {
    const h = harness();
    const rows = Array.from({ length: 501 }, () => ({ ...row, blueprint_id: createId("bpr") }));
    h.services.listBlueprints
      .mockResolvedValueOnce({ items: rows.slice(0, 500), total: 501 })
      .mockResolvedValueOnce({ items: rows.slice(500), total: 501 });
    const args = { action: "deprecate", selection: { mode: "filter", query: { hasComponents: "false" } } };
    expect((await h.call("preview-bulk-blueprint-lifecycle", args)).result.isError).not.toBe(true);
    expect(h.services.bulkLifecycle.preview).toHaveBeenCalledWith(
      { mode: "ids", ids: rows.map((item) => item.blueprint_id) },
      "deprecate",
    );
    h.services.bulkLifecycle.preview.mockClear();
    h.services.listBlueprints
      .mockResolvedValueOnce({ items: rows.slice(0, 500), total: 501 })
      .mockResolvedValueOnce({ items: [], total: 501 });
    expect((await h.call("preview-bulk-blueprint-lifecycle", args)).result.isError).toBe(true);
    h.services.listBlueprints
      .mockResolvedValueOnce({ items: rows.slice(0, 500), total: 501 })
      .mockResolvedValueOnce({ items: rows.slice(500), total: 502 });
    expect(
      (await h.call("confirm-bulk-blueprint-lifecycle", { ...args, ...confirmed("Confirm Bulk Blueprint Lifecycle") }))
        .result.isError,
    ).toBe(true);
    expect(h.services.bulkLifecycle.preview).not.toHaveBeenCalled();
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("preserves missing read models, job snapshots, and domain lifecycle failures", async () => {
    const h = harness();
    h.services.getBlueprintDetail.mockResolvedValue(
      await getBlueprintDetail({ query: vi.fn().mockResolvedValue({ rows: [] }) }, id),
    );
    h.jobs.get.mockResolvedValue(null);
    expect((await h.call("get-blueprint", { blueprintId: id })).result.content[0].text).toContain(
      "Blueprint not found",
    );
    expect((await h.call("get-authoring-job", { jobId: job.jobId })).result.content[0].text).toContain("job not found");
    expect(
      (await h.call("publish-blueprint", { blueprintId: id, ...confirmed("Publish Blueprint") })).result.isError,
    ).toBe(true);
    expect(await h.eventStore.readStream({ streamId: `catalog.blueprint-${id}` })).toHaveLength(0);
  });

  it("fails visibly before queueing a filter beyond the original pagination bound", async () => {
    const h = harness();
    h.services.listBlueprints.mockResolvedValue({ items: [row], total: 10_501 });
    const response = await h.call("confirm-bulk-blueprint-lifecycle", {
      action: "archive",
      selection: { mode: "filter", query: {} },
      ...confirmed("Confirm Bulk Blueprint Lifecycle"),
    });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain("incomplete or changed while paging");
    expect(h.services.listBlueprints).toHaveBeenCalledTimes(1);
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("awaits denied and failed audit records", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const audit = vi.fn<McpAuditSink>(async (record) => {
      if (record.outcome === "denied") {
        entered();
        await gate;
      }
    });
    const h = harness(audit);
    let settled = false;
    const request = h.call("create-blueprint", {}).then((result) => {
      settled = true;
      return result;
    });
    await started;
    expect(settled).toBe(false);
    release();
    await request;
    const failed = await h.call("publish-blueprint", { blueprintId: id, ...confirmed("Publish Blueprint") });
    expect(failed.result.isError).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", actorId: actor.userId }));
  });
});
