import { resolveRolePermissions, type OperatorAuthorityDecision, type ResolvedActor } from "@chase-sets/auth-context";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { buildMcpHandlersFromModules, createMcpRoutes, type McpAuditSink } from "@chase-sets/platform-runtime/mcp";
import { findMcpTool, flattenMcpTools } from "@chase-sets/platform-runtime/mcp-contracts";
import { createId } from "@chase-sets/primitives/typed-ids";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { contextManifest, module as catalogModule } from "../../../index";
import type {
  CatalogAuthoringBulkJob,
  CatalogAuthoringBulkJobServices,
} from "../../../support/authoring-support/bulk-authoring-jobs";
import { createCatalogServices } from "../../../support/authoring-support/services";
import { decideCategory, evolveCategory, initialCategoryState, type CategoryEvent } from "../domain/domain";
import type { CategoryListRow } from "../read-model/queries";
import { createCategoryMcpHandlers } from "./mcp";
import type { CategoryServices } from "./runtime";

const categoryId = createId("ctg");
const parentCategoryId = createId("ctg");
const wrongId = createId("bpr");
const streamId = `catalog.category-${categoryId}`;
const name = { defaultLocale: "en", values: { en: "Card Prints", fr: "Cartes" } };
const revisedName = { ...name, values: { ...name.values, en: "Singles" } };
const description = { defaultLocale: "en", values: { en: "Individual cards" } };
const metadata = { categoryId, key: "magic-card-prints", name, description, parentCategoryId, displayOrder: 8 };
const writeCases = [
  ["create-category", "Create Category", metadata, "CreateCategory", "sensitive"],
  ["revise-category", "Revise Category", { ...metadata, name: revisedName }, "ReviseCategory", "sensitive"],
  ["publish-category", "Publish Category", { categoryId }, "PublishCategory", "sensitive"],
  ["deprecate-category", "Deprecate Category", { categoryId }, "DeprecateCategory", "sensitive"],
  ["archive-category", "Archive Category", { categoryId }, "ArchiveCategory", "destructive"],
] as const;
const writeControls = (title: string, key = title) => ({
  confirmed: true,
  confirmationText: `${title}.`,
  idempotencyKey: key,
});
const bulkTitle = "Confirm Bulk Category Lifecycle";
const explicitBulk = { action: "publish", selection: { mode: "ids", ids: [categoryId] } } as const;
const listTools = [
  "list-categories",
  "create-category",
  "preview-bulk-category-lifecycle",
  "confirm-bulk-category-lifecycle",
  "get-authoring-job",
];
const detailTools = ["get-category", "publish-category", "deprecate-category", "archive-category", "revise-category"];
const actor: ResolvedActor = {
  sessionId: "sess_operator",
  tenantId: "tenant",
  userId: "user_operator",
  accountId: "account_operator",
  membershipId: "membership_operator",
  roleKey: "platform-admin",
  permissions: resolveRolePermissions("platform-admin"),
  agentGrant: {
    grantId: "grant_operator",
    platformProfileUrl: "https://example.test/platform",
    scopes: ["operations:write"],
    rolePermissions: resolveRolePermissions("platform-admin"),
  },
};
const granted: OperatorAuthorityDecision = {
  kind: "granted",
  membershipId: actor.membershipId,
  roleKey: "platform-admin",
  rolePermissions: actor.permissions,
};
const auditContext = { performedByUserId: actor.userId, forAccountId: actor.accountId };
const row: CategoryListRow = {
  category_id: categoryId,
  key: metadata.key,
  name: name.values.en,
  name_i18n: name,
  description: description.values.en,
  description_i18n: description,
  status: "draft",
  parent_category_id: parentCategoryId,
  parent_category: { categoryId: parentCategoryId, name: "Magic" },
  display_order: metadata.displayOrder,
  updated_at: "2026-11-22T00:00:00.000Z",
};
const job: CatalogAuthoringBulkJob = {
  jobId: "job_categories",
  kind: "catalog.authoring.categories.lifecycle",
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

function harness(audit?: McpAuditSink) {
  const { eventStore } = createInMemoryEventStore();
  const category = createAggregateCommandHandler({
    eventStore,
    codec: createPassthroughDomainEventCodec<CategoryEvent>(),
    initialState: () => initialCategoryState,
    decide: decideCategory,
    evolve: evolveCategory,
  });
  const services = {
    commandHandler: vi.fn(category.commandHandler),
    listCategories: vi.fn<CategoryServices["listCategories"]>().mockResolvedValue({ items: [row], total: 1 }),
    getCategoryDetail: vi.fn<CategoryServices["getCategoryDetail"]>().mockResolvedValue(row),
    getCategoryItemCounts: vi
      .fn<CategoryServices["getCategoryItemCounts"]>()
      .mockResolvedValue(new Map([[categoryId, 3]])),
    bulkLifecycle: {
      preview: vi.fn<CategoryServices["bulkLifecycle"]["preview"]>().mockResolvedValue({
        mode: "ids",
        action: "publish",
        ids: [categoryId],
        total: 1,
        ready_count: 1,
        blocked_count: 0,
        candidates: [{ id: categoryId, label: row.name, status: "draft", outcome: "ready", reason: null }],
      }),
      execute: vi.fn<CategoryServices["bulkLifecycle"]["execute"]>(),
    },
    projectors: [],
  } satisfies CategoryServices;
  const jobs = {
    enqueue: vi.fn<CatalogAuthoringBulkJobServices["enqueue"]>().mockResolvedValue(job),
    get: vi.fn<CatalogAuthoringBulkJobServices["get"]>().mockResolvedValue(job),
  };
  const { toolHandlers } = createCategoryMcpHandlers(services, jobs);
  const runtime = createCatalogServices({
    query: async () => {
      throw new Error("Unexpected database query in category MCP test.");
    },
    connect: async () => {
      throw new Error("Unexpected database connection in category MCP test.");
    },
  });
  const composition = buildMcpHandlersFromModules([
    {
      module: catalogModule,
      services: {
        ...runtime,
        categories: services,
        authoringBulkJobs: { ...runtime.authoringBulkJobs, ...jobs },
      },
    },
  ]);
  let currentActor: ResolvedActor | null = actor;
  let authority: OperatorAuthorityDecision = granted;
  const app = new Hono<{ Variables: { actor: ResolvedActor | null } }>();
  app.use("*", async (c, next) => {
    c.set("actor", currentActor);
    await next();
  });
  app.route(
    "/mcp",
    createMcpRoutes({
      toolHandlers: composition.toolHandlers,
      operatorAuthority: async () => authority,
      allowInMemoryIdempotencyStoreForTests: true,
      audit,
    }),
  );
  return {
    services,
    jobs,
    toolHandlers,
    eventStore,
    setActor: (value: ResolvedActor | null) => {
      currentActor = value;
    },
    setAuthority: (value: OperatorAuthorityDecision) => {
      authority = value;
    },
    async call(name: string, args: Record<string, unknown> = {}) {
      const response = await app.request("/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "request",
          method: "tools/call",
          params: { name: `catalog.${name}`, arguments: args },
        }),
      });
      const reply = (await response.json()) as {
        error?: unknown;
        result: { isError?: boolean; structuredContent?: unknown; content: { text: string }[] };
      };
      expect(reply.error, JSON.stringify(reply)).toBeUndefined();
      return reply.result;
    },
  };
}

describe("Category MCP", () => {
  it("MCP source-call contract coverage", async () => {
    const h = harness();
    const fullNames = (names: readonly string[]) => names.map((tool) => `catalog.${tool}`);
    const owned = fullNames([...listTools.filter((tool) => tool !== "get-authoring-job"), ...detailTools]).sort();
    expect(Object.keys(h.toolHandlers).sort()).toEqual(owned);
    expect(contextManifest.agentCoverage.categories.tools).toEqual(fullNames(listTools));
    expect(contextManifest.agentCoverage["categories-detail"].tools).toEqual(fullNames(detailTools));
    expect(
      contextManifest.mcpCapabilities.tools
        .filter(({ ownerSlice }) => ownerSlice === "categories")
        .map(({ name }) => name)
        .sort(),
    ).toEqual(owned);
    const writes = [
      ...writeCases.map(([slug, title, , , risk]) => [slug, title, risk] as const),
      ["confirm-bulk-category-lifecycle", bulkTitle, "destructive"] as const,
    ];
    for (const slug of [...listTools, ...detailTools]) {
      const matches = flattenMcpTools().filter((tool) => tool.name === `catalog.${slug}`);
      expect(matches).toHaveLength(1);
      const write = writes.find(([name]) => name === slug);
      const view = ["get-category", "list-categories", "get-authoring-job"].includes(slug);
      expect(matches[0]).toMatchObject({
        availability: "available",
        risk: write?.[2] ?? "read",
        permissionBoundary: {
          scope: "operator",
          accountScoped: false,
          requiredPermissions: [view ? "catalog.view" : "catalog.manage"],
          requiredScopes: [],
        },
        guardrails: {
          confirmation: write ? { required: true, matchInputField: "confirmationText" } : { required: false },
          idempotencyKey: write ? "required" : "not-applicable",
        },
        inputSchema: { additionalProperties: false },
      });
      if (write) expect(matches[0]?.title).toBe(write[1]);
    }

    const summary = {
      id: categoryId,
      key: metadata.key,
      name: row.name,
      description: row.description,
      status: row.status,
      itemCount: 3,
      parentCategoryId,
      displayOrder: metadata.displayOrder,
      nameI18n: name,
      descriptionI18n: description,
    };
    const list = await h.call("list-categories", {
      search: "prints",
      status: "draft",
      parentCategoryId,
      hierarchy: "child",
      limit: 10,
      offset: 0,
    });
    expect(list.structuredContent).toMatchObject({ items: [summary], total: 1, count: 1 });
    expect(h.services.listCategories).toHaveBeenCalledWith({
      search: "prints",
      status: "draft",
      parentCategoryId,
      hierarchy: "child",
      limit: 10,
      offset: undefined,
    });
    expect(h.services.getCategoryItemCounts).toHaveBeenCalledExactlyOnceWith([categoryId]);
    expect((await h.call("get-category", { categoryId })).structuredContent).toMatchObject(summary);
    expect(h.services.getCategoryDetail).toHaveBeenCalledExactlyOnceWith(categoryId);

    for (const [slug, title, args, type] of writeCases) {
      const result = await h.call(slug, { ...args, ...writeControls(title) });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(h.services.commandHandler).toHaveBeenLastCalledWith(
        expect.objectContaining({
          streamId,
          command: expect.objectContaining({ type }),
          context: expect.objectContaining({ audit: auditContext }),
        }),
      );
    }
    const events = await h.eventStore.readStream({ streamId });
    expect(events.map((event) => event.eventType)).toEqual(
      ["created", "revised", "published", "deprecated", "archived"].map((event) => `catalog.category.${event}`),
    );
    for (const event of events) expect(event).toMatchObject(auditContext);
    expect(events[1]?.payload).toMatchObject({ name: revisedName, description, parentCategoryId, displayOrder: 8 });

    const filteredQuery = { search: "prints", status: "draft", parentCategoryId, hierarchy: "child" };
    for (const selection of [
      explicitBulk.selection,
      { mode: "filter", query: { ...filteredQuery, search: " prints " } },
    ]) {
      const input = { action: "publish", selection };
      expect((await h.call("preview-bulk-category-lifecycle", input)).structuredContent).toMatchObject({
        mode: selection.mode,
        ready_count: 1,
        blocked_count: 0,
      });
      expect(h.services.bulkLifecycle.preview).toHaveBeenLastCalledWith(explicitBulk.selection, "publish");
      expect(
        (await h.call("confirm-bulk-category-lifecycle", { ...input, ...writeControls(bulkTitle, selection.mode) }))
          .structuredContent,
      ).toEqual(job);
      expect(h.jobs.enqueue).toHaveBeenLastCalledWith({
        kind: job.kind,
        action: "publish",
        selection: explicitBulk.selection,
        context: expect.objectContaining({ audit: auditContext }),
      });
    }
    expect(h.services.listCategories).toHaveBeenLastCalledWith({ ...filteredQuery, limit: 500, offset: 0 });
    expect(h.services.bulkLifecycle.preview).toHaveBeenCalledTimes(2);
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(2);
    expect(h.services.bulkLifecycle.execute).not.toHaveBeenCalled();
    expect((await h.call("get-authoring-job", { jobId: job.jobId })).structuredContent).toEqual(job);
    expect(h.jobs.get).toHaveBeenCalledExactlyOnceWith(job.jobId, expect.objectContaining({ audit: auditContext }));
  });

  it("requires replacement metadata in the revise descriptor but not in the create descriptor", () => {
    const create = findMcpTool("catalog.create-category")!.inputSchema;
    const revise = findMcpTool("catalog.revise-category")!.inputSchema;
    expect(create.required).not.toContain("description");
    expect(create.required).not.toContain("parentCategoryId");
    expect(revise.required).toEqual(expect.arrayContaining(["description", "parentCategoryId"]));
    expect(revise.required).not.toContain("displayOrder");
  });

  it.each(["description", "parentCategoryId"] as const)(
    "refuses to revise a child Category without %s",
    async (field) => {
      const h = harness();
      expect((await h.call("create-category", { ...metadata, ...writeControls("Create Category") })).isError).not.toBe(
        true,
      );
      const { [field]: _omitted, ...args } = { ...metadata, name: revisedName };
      expect((await h.call("revise-category", { ...args, ...writeControls("Revise Category") })).isError).toBe(true);
      expect(h.services.commandHandler).toHaveBeenCalledTimes(1);
      expect(await h.eventStore.readStream({ streamId })).toHaveLength(1);
    },
  );

  it("returns a revised name without changing the supplied metadata or item count", async () => {
    const h = harness();
    expect((await h.call("create-category", { ...metadata, ...writeControls("Create Category") })).isError).not.toBe(
      true,
    );
    expect((await h.call("publish-category", { categoryId, ...writeControls("Publish Category") })).isError).not.toBe(
      true,
    );
    const activeRow = { ...row, status: "active" };
    h.services.getCategoryDetail.mockResolvedValueOnce(activeRow);
    expect((await h.call("get-category", { categoryId })).structuredContent).toMatchObject({
      key: row.key,
      name: "Card Prints",
      status: "active",
      itemCount: 3,
    });
    expect(
      (await h.call("revise-category", { ...metadata, name: revisedName, ...writeControls("Revise Category") }))
        .isError,
    ).not.toBe(true);
    const events = await h.eventStore.readStream({ streamId });
    expect(events[2]?.payload).toMatchObject({ key: row.key, name: revisedName, description, parentCategoryId });
    const revisedRow = { ...activeRow, name: revisedName.values.en, name_i18n: revisedName };
    h.services.getCategoryDetail.mockResolvedValueOnce(revisedRow);
    h.services.listCategories.mockResolvedValueOnce({
      items: [revisedRow, { ...row, category_id: parentCategoryId }],
      total: 2,
    });
    expect((await h.call("get-category", { categoryId })).structuredContent).toMatchObject({
      key: row.key,
      name: "Singles",
      status: "active",
      itemCount: 3,
    });
    expect((await h.call("list-categories")).structuredContent).toMatchObject({
      items: [
        { id: categoryId, key: row.key, name: "Singles", itemCount: 3 },
        { id: parentCategoryId, itemCount: 0 },
      ],
      total: 2,
      count: 2,
    });
    expect(h.services.getCategoryItemCounts).toHaveBeenLastCalledWith([categoryId, parentCategoryId]);
  });

  it.each([
    ...writeCases.map(([slug, title, args]) => [slug, title, args] as const),
    ["confirm-bulk-category-lifecycle", bulkTitle, explicitBulk] as const,
  ])("requires title-bound confirmation and an idempotency key for %s", async (slug, title, args) => {
    const h = harness();
    const valid = writeControls(title);
    for (const invalid of [
      { idempotencyKey: "key", confirmationText: valid.confirmationText },
      { ...valid, confirmed: false },
      { ...valid, confirmationText: "Wrong category action." },
      { ...valid, idempotencyKey: " " },
    ]) {
      expect((await h.call(slug, { ...args, ...invalid })).isError).toBe(true);
    }
    expect(h.services.commandHandler).not.toHaveBeenCalled();
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
  });

  it.each([
    ["get-category", { categoryId: wrongId }],
    ["list-categories", { limit: "10" }],
    ["revise-category", { ...metadata, categoryId: wrongId }],
    ["revise-category", { ...metadata, parentCategoryId: wrongId }],
    ["revise-category", { ...metadata, displayOrder: 0.5 }],
    ["revise-category", { ...metadata, displayOrder: 2_147_483_648 }],
    ["revise-category", { ...metadata, name: { defaultLocale: "en", values: { en: 42 } } }],
    ["revise-category", { ...metadata, accountId: "wrong_account" }],
    ["preview-bulk-category-lifecycle", { ...explicitBulk, action: "erase" }],
    ["preview-bulk-category-lifecycle", { ...explicitBulk, selection: { mode: "ids", ids: [wrongId] } }],
    ["preview-bulk-category-lifecycle", { ...explicitBulk, selection: { mode: "ids", query: {} } }],
    ["confirm-bulk-category-lifecycle", { ...explicitBulk, selection: { mode: "filter" } }],
    [
      "confirm-bulk-category-lifecycle",
      { ...explicitBulk, selection: { mode: "filter", query: {}, ids: [categoryId] } },
    ],
  ] as const)("rejects invalid %s inputs and omitted or overlapping selection branches", async (slug, args) => {
    const h = harness();
    const tool = findMcpTool(`catalog.${slug}`)!;
    expect((await h.call(slug, { ...args, ...(tool.risk === "read" ? {} : writeControls(tool.title)) })).isError).toBe(
      true,
    );
    expect(h.services.commandHandler).not.toHaveBeenCalled();
    expect(h.services.listCategories).not.toHaveBeenCalled();
    expect(h.services.getCategoryDetail).not.toHaveBeenCalled();
    expect(h.services.bulkLifecycle.preview).not.toHaveBeenCalled();
    expect(h.jobs.enqueue).not.toHaveBeenCalled();
  });

  it("re-evaluates operator authority before replaying a confirmed revision or bulk enqueue", async () => {
    const audit = vi.fn<McpAuditSink>();
    const h = harness(audit);
    expect((await h.call("create-category", { ...metadata, ...writeControls("Create Category") })).isError).not.toBe(
      true,
    );
    const revise = { ...metadata, name: revisedName, parentCategoryId: null, ...writeControls("Revise Category") };
    const bulk = { ...explicitBulk, ...writeControls(bulkTitle) };
    for (const [slug, args, conflict] of [
      ["revise-category", revise, { ...revise, name }],
      ["confirm-bulk-category-lifecycle", bulk, { ...bulk, action: "archive" }],
    ] as const) {
      const first = await h.call(slug, args);
      expect(first.isError, JSON.stringify(first)).not.toBe(true);
      expect(await h.call(slug, args)).toEqual(first);
      expect((await h.call(slug, conflict)).isError).toBe(true);
      h.setAuthority({ kind: "denied", reason: "not-platform-admin" });
      expect((await h.call(slug, args)).isError).toBe(true);
      h.setAuthority(granted);
    }
    expect(h.services.commandHandler).toHaveBeenCalledTimes(2);
    const events = await h.eventStore.readStream({ streamId });
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toMatchObject({ parentCategoryId: null });
    expect(h.jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "denied",
        actorId: actor.userId,
        accountId: actor.accountId,
        agentGrantId: actor.agentGrant?.grantId,
        agentGrantScopes: ["operations:write"],
      }),
    );
  });

  it("denies wrong-account operators and grants without write scope before any effects", async () => {
    const h = harness();
    h.setActor({ ...actor, accountId: "wrong_account" });
    h.setAuthority({ kind: "denied", reason: "not-platform-admin" });
    expect((await h.call("get-category", { categoryId })).isError).toBe(true);
    expect(h.services.getCategoryDetail).not.toHaveBeenCalled();
    h.setAuthority(granted);
    h.setActor({ ...actor, agentGrant: { ...actor.agentGrant!, scopes: ["operations:read"] } });
    expect((await h.call("get-category", { categoryId })).isError).not.toBe(true);
    expect((await h.call("create-category", { ...metadata, ...writeControls("Create Category") })).isError).toBe(true);
    expect(h.services.commandHandler).not.toHaveBeenCalled();
  });

  it("resolves the decisive tail of a filtered selection without doing count enrichment", async () => {
    const h = harness();
    const head = Array.from({ length: 500 }, () => ({ ...row, category_id: createId("ctg") }));
    h.services.listCategories
      .mockResolvedValueOnce({ items: head, total: 501 })
      .mockResolvedValueOnce({ items: [row], total: 501 });
    const args = { action: "publish", selection: { mode: "filter", query: {} }, ...writeControls(bulkTitle) };
    expect((await h.call("confirm-bulk-category-lifecycle", args)).isError).not.toBe(true);
    expect(h.services.listCategories).toHaveBeenNthCalledWith(2, expect.objectContaining({ limit: 500, offset: 500 }));
    expect(h.jobs.enqueue).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        selection: { mode: "ids", ids: [...head.map((entry) => entry.category_id), categoryId] },
      }),
    );
    expect(h.services.getCategoryItemCounts).not.toHaveBeenCalled();
  });

  it.each(["short page", "duplicate", "changed total", "over limit"])(
    "fails visibly for a filtered selection with %s",
    async (failure) => {
      const h = harness();
      const head = Array.from({ length: 500 }, () => ({ ...row, category_id: createId("ctg") }));
      h.services.listCategories
        .mockResolvedValueOnce({ items: head, total: failure === "over limit" ? 10_501 : 501 })
        .mockResolvedValueOnce({
          items: failure === "short page" ? [] : failure === "duplicate" ? head.slice(0, 1) : [row],
          total: failure === "changed total" ? 502 : 501,
        });
      const result = await h.call("confirm-bulk-category-lifecycle", {
        action: "publish",
        selection: { mode: "filter", query: {} },
        ...writeControls(bulkTitle),
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("selection is incomplete or changed while paging");
      expect(h.jobs.enqueue).not.toHaveBeenCalled();
    },
  );

  it("preserves not-found readback and rejects a lifecycle change on a missing aggregate", async () => {
    const h = harness();
    h.services.getCategoryDetail.mockResolvedValue(null);
    expect((await h.call("get-category", { categoryId })).content[0]?.text).toContain("Category not found");
    expect(h.services.getCategoryItemCounts).not.toHaveBeenCalled();
    expect((await h.call("publish-category", { categoryId, ...writeControls("Publish Category") })).isError).toBe(true);
    expect(await h.eventStore.readStream({ streamId })).toHaveLength(0);
  });
});
