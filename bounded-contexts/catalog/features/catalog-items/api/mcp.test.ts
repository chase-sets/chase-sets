import { resolveRolePermissions, type OperatorAuthorityDecision, type ResolvedActor } from "@chase-sets/auth-context";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import { buildMcpHandlersFromModules, createMcpRoutes } from "@chase-sets/platform-runtime/mcp";
import { flattenMcpTools } from "@chase-sets/platform-runtime/mcp-contracts";
import { createId } from "@chase-sets/primitives/typed-ids";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { contextManifest, module as catalogModule } from "../../../index";
import type { CatalogAuthoringBulkJobServices } from "../../../support/authoring-support/bulk-authoring-jobs";
import { createCatalogServices } from "../../../support/authoring-support/services";
import { decideCatalogItem, evolveCatalogItem, initialCatalogItemState, type CatalogItemEvent } from "../domain/domain";
import { CatalogItemPublicationPreconditionError, createCatalogItemRuntime, type CatalogItemServices } from "./runtime";

const catalogItemId = createId("cat");
const blueprintId = createId("bpr");
const categoryId = createId("ctg");
const fieldId = createId("fld");
const streamId = `catalog.item-${catalogItemId}`;
const title = { defaultLocale: "en", values: { en: "Card", fr: "Carte" } };
const subtitle = { defaultLocale: "en", values: { en: "Foil" } };
const description = { defaultLocale: "en", values: { en: "Collector edition" } };
const ref = { providerKey: "fixture-provider", externalKey: "external-key" };
const selectedOptions = [{ dimensionId: createId("dim"), optionId: createId("chc") }];
const ids = { mode: "ids", ids: [catalogItemId] };
const filter = { mode: "filter", query: { search: "Card", status: "draft", missingRequiredFields: "true" } };
const listTools = [
  "search-items",
  "create-item",
  "preview-bulk-publish-catalog-items",
  "confirm-bulk-publish-catalog-items",
  "remove-draft-item",
  "preview-bulk-catalog-item-edit",
  "confirm-bulk-catalog-item-edit",
  "preview-bulk-catalog-item-lifecycle",
  "confirm-bulk-catalog-item-lifecycle",
  "get-authoring-job",
];
const detailTools = [
  "get-item",
  "list-fields",
  "list-reference-records",
  "list-product-content-types",
  "list-product-content-inclusion-policies",
  "search-items",
  "list-product-contents-for-container",
  "list-product-containers-for-contained",
  "archive-item",
  "publish-item",
  "assign-blueprint",
  "set-field-value",
  "clear-field-value",
  "assign-category",
  "remove-category",
  "revise-item-metadata",
  "set-tags",
  "set-image-urls",
  "set-image-fallback",
  "clear-image-fallback",
  "link-external-product-reference",
  "link-external-catalog-item-reference",
  "unlink-external-product-reference",
  "unlink-external-catalog-item-reference",
  "replace-product-contents",
];
const writes = [
  [
    "create-item",
    "Create Catalog Item",
    { title, subtitle, description },
    { type: "CreateCatalogItem", itemId: catalogItemId, title, subtitle, description },
    "sensitive",
  ],
  [
    "revise-item-metadata",
    "Revise Catalog Item Metadata",
    { title, subtitle: null },
    { type: "ReviseCatalogItemMetadata", title, subtitle: null },
    "sensitive",
  ],
  [
    "assign-blueprint",
    "Assign Blueprint",
    { blueprintId },
    { type: "AssignBlueprintToCatalogItem", blueprintId },
    "sensitive",
  ],
  [
    "assign-category",
    "Assign Category",
    { categoryId },
    { type: "AssignCatalogItemToCategory", categoryId },
    "sensitive",
  ],
  [
    "remove-category",
    "Remove Category",
    { categoryId },
    { type: "RemoveCatalogItemFromCategory", categoryId },
    "destructive",
  ],
  [
    "set-field-value",
    "Set Field Value",
    { fieldId, value: [true, 2, null] },
    { type: "SetCatalogItemFieldValue", fieldId, value: [true, 2, null] },
    "sensitive",
  ],
  [
    "clear-field-value",
    "Clear Field Value",
    { fieldId, requiredFieldIds: [] },
    { type: "ClearCatalogItemFieldValue", fieldId, requiredFieldIds: [] },
    "destructive",
  ],
  ["set-tags", "Set Tags", { tags: ["foil"] }, { type: "SetCatalogItemTags", tags: ["foil"] }, "sensitive"],
  [
    "set-image-urls",
    "Set Image Urls",
    { imageUrls: ["https://example.test/front.png"] },
    { type: "SetCatalogItemImageUrls", imageUrls: ["https://example.test/front.png"] },
    "sensitive",
  ],
  [
    "set-image-fallback",
    "Set Image Fallback",
    {
      imageFallback: {
        url: "https://example.test/front.png",
        alt: "",
        usage: "permanent",
        variants: { small: { twoX: "https://example.test/2x.png" } },
      },
    },
    {
      type: "SetCatalogItemImageFallback",
      imageFallback: {
        url: "https://example.test/front.png",
        alt: "",
        usage: "permanent",
        variants: { small: { twoX: "https://example.test/2x.png" } },
      },
    },
    "sensitive",
  ],
  ["clear-image-fallback", "Clear Image Fallback", {}, { type: "ClearCatalogItemImageFallback" }, "destructive"],
  [
    "link-external-catalog-item-reference",
    "Link External Catalog Item Reference",
    ref,
    { type: "LinkExternalCatalogItemReference", ...ref },
    "sensitive",
  ],
  [
    "unlink-external-catalog-item-reference",
    "Unlink External Catalog Item Reference",
    ref,
    { type: "UnlinkExternalCatalogItemReference", ...ref },
    "destructive",
  ],
  [
    "link-external-product-reference",
    "Link External Product Reference",
    { ...ref, selectedOptions },
    { type: "LinkExternalProductReference", ...ref, selectedOptions },
    "sensitive",
  ],
  [
    "unlink-external-product-reference",
    "Unlink External Product Reference",
    ref,
    { type: "UnlinkExternalProductReference", ...ref },
    "destructive",
  ],
  [
    "publish-item",
    "Publish Catalog Item",
    { expectedVersion: 3, blueprintIsActive: true, requiredFieldIds: [] },
    { type: "PublishCatalogItem" },
    "sensitive",
  ],
  ["archive-item", "Archive Catalog Item", {}, { type: "ArchiveCatalogItem" }, "destructive"],
  ["remove-draft-item", "Remove Draft Catalog Item", {}, { type: "RemoveDraftCatalogItem" }, "destructive"],
] as const;
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
const audit = { performedByUserId: actor.userId, forAccountId: actor.accountId };
const fullName = (name: string) => `catalog.${name}`;
const controls = (name: string, key = name) => ({ confirmed: true, confirmationText: `${name}.`, idempotencyKey: key });

function harness() {
  const { eventStore } = createInMemoryEventStore();
  const aggregate = createAggregateCommandHandler({
    eventStore,
    codec: createPassthroughDomainEventCodec<CatalogItemEvent>(),
    initialState: () => initialCatalogItemState,
    decide: decideCatalogItem,
    evolve: evolveCatalogItem,
  });
  const services = createCatalogServices({
    query: async () => {
      throw new Error("Unexpected database query in Catalog Item MCP test.");
    },
    connect: async () => {
      throw new Error("Unexpected database connection in Catalog Item MCP test.");
    },
  });
  const items = {
    ...services.items,
    commandHandler: vi
      .fn<CatalogItemServices["commandHandler"]>()
      .mockResolvedValue({ state: initialCatalogItemState, version: 1, newEvents: [], storedEvents: [] }),
    listCatalogItems: vi.fn<CatalogItemServices["listCatalogItems"]>().mockResolvedValue({ items: [], total: 11 }),
    getCatalogItemDetail: vi.fn<CatalogItemServices["getCatalogItemDetail"]>().mockResolvedValue(null),
    previewBulkPublish: vi.fn<CatalogItemServices["previewBulkPublish"]>(),
    previewBulkEdit: vi.fn<CatalogItemServices["previewBulkEdit"]>(),
    bulkLifecycle: {
      ...services.items.bulkLifecycle,
      preview: vi.fn<CatalogItemServices["bulkLifecycle"]["preview"]>(),
    },
  };
  const enqueue = vi.fn<CatalogAuthoringBulkJobServices["enqueue"]>();
  const get = vi.fn<CatalogAuthoringBulkJobServices["get"]>();
  const { toolHandlers } = buildMcpHandlersFromModules([
    {
      module: catalogModule,
      services: { ...services, items, authoringBulkJobs: { ...services.authoringBulkJobs, enqueue, get } },
    },
  ]);
  const authority = vi.fn<() => Promise<OperatorAuthorityDecision>>().mockResolvedValue(granted);
  const app = new Hono<{ Variables: { actor: ResolvedActor } }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route(
    "/mcp",
    createMcpRoutes({ toolHandlers, operatorAuthority: authority, allowInMemoryIdempotencyStoreForTests: true }),
  );
  return {
    items,
    enqueue,
    get,
    toolHandlers,
    aggregate,
    eventStore,
    authority,
    async call(name: string, args: Record<string, unknown>) {
      const response = await app.request("/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "req",
          method: "tools/call",
          params: { name: fullName(name), arguments: args },
        }),
      });
      const body = (await response.json()) as {
        error?: unknown;
        result: { isError?: boolean; structuredContent?: unknown; content: { text: string }[] };
      };
      expect(body.error, JSON.stringify(body)).toBeUndefined();
      return body.result;
    },
  };
}

describe("Catalog Item MCP", () => {
  it("MCP source-call contract coverage", async () => {
    const h = harness();
    expect(contextManifest.agentCoverage["catalog-items"].tools).toEqual(listTools.map(fullName));
    expect(contextManifest.agentCoverage["catalog-items-detail"].tools).toEqual(detailTools.map(fullName));
    for (const name of new Set([...listTools, ...detailTools])) {
      const descriptors = flattenMcpTools().filter((tool) => tool.name === fullName(name));
      expect(descriptors, name).toHaveLength(1);
      const writeCase = writes.find(([tool]) => tool === name);
      const isConfirm = name.startsWith("confirm-") || name === "replace-product-contents";
      const permission = writeCase || isConfirm || name.startsWith("preview-") ? "catalog.manage" : "catalog.view";
      expect(descriptors[0]).toMatchObject({
        availability: "available",
        risk:
          writeCase?.[4] ??
          (name === "confirm-bulk-catalog-item-lifecycle" ? "destructive" : isConfirm ? "sensitive" : "read"),
        permissionBoundary: {
          scope: "operator",
          requiredScopes: [],
          requiredPermissions: [permission],
          accountScoped: false,
        },
        guardrails: {
          confirmation: { required: Boolean(writeCase || isConfirm) },
          idempotencyKey: writeCase || isConfirm ? "required" : "not-applicable",
        },
      });
      expect(h.toolHandlers[fullName(name)], name).toBeTypeOf("function");
    }
    for (const [name, confirmationTitle, args, command] of writes) {
      const result = await h.call(name, { catalogItemId, ...args, ...controls(confirmationTitle) });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(h.items.commandHandler).toHaveBeenLastCalledWith(
        expect.objectContaining({
          streamId,
          command: expect.objectContaining(command),
          context: expect.objectContaining({ audit }),
        }),
      );
    }
    expect(
      h.items.commandHandler.mock.calls.find(([input]) => input.command.type === "PublishCatalogItem")?.[0],
    ).toMatchObject({ expectedVersion: 3, command: { type: "PublishCatalogItem" } });
    expect(
      h.items.commandHandler.mock.calls.find(([input]) => input.command.type === "PublishCatalogItem")?.[0].command,
    ).toEqual({ type: "PublishCatalogItem" });
    const search = {
      search: "Card",
      status: "draft",
      limit: 10,
      offset: 2,
      blueprintId,
      tag: "foil",
      language: "en",
      source: "fixture-provider",
      blueprintState: "assigned",
      hasImages: "true",
      hasSourceReferences: "true",
      missingRequiredFields: "false",
    };
    expect((await h.call("search-items", search)).structuredContent).toEqual({ items: [], total: 11, count: 0 });
    expect(h.items.listCatalogItems).toHaveBeenCalledWith(search);
    expect((await h.call("get-item", { catalogItemId })).content[0]?.text).toContain("Catalog Item not found");
    expect(h.items.getCatalogItemDetail).toHaveBeenCalledWith(catalogItemId);
    expect((await h.call("get-authoring-job", { jobId: "fixture-job" })).isError).toBe(true);
    expect(h.get).toHaveBeenCalledWith("fixture-job", expect.objectContaining({ audit }));

    const actions = [
      { action: "assignBlueprint", blueprintId },
      { action: "assignCategory", categoryId },
      { action: "removeCategory", categoryId },
      { action: "setTags", tags: ["foil"] },
      { action: "mergeTags", tags: ["foil"] },
      { action: "clearTags" },
    ];
    for (const operation of actions) {
      expect((await h.call("preview-bulk-catalog-item-edit", { selection: ids, operation })).isError).not.toBe(true);
      expect(h.items.previewBulkEdit).toHaveBeenLastCalledWith(ids, operation);
      const args = { selection: filter, operation, ...controls("Confirm Bulk Catalog Item Edit", operation.action) };
      expect((await h.call("confirm-bulk-catalog-item-edit", args)).isError).not.toBe(true);
      expect(h.enqueue).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: "catalog.authoring.items.edit",
          selection: filter,
          operation,
          context: expect.objectContaining({ audit }),
        }),
      );
    }
    expect(
      (await h.call("preview-bulk-catalog-item-lifecycle", { selection: filter, action: "archive" })).isError,
    ).not.toBe(true);
    expect(h.items.bulkLifecycle.preview).toHaveBeenCalledWith(filter, "archive");
    expect(
      (
        await h.call("confirm-bulk-catalog-item-lifecycle", {
          selection: ids,
          action: "archive",
          ...controls("Confirm Bulk Catalog Item Lifecycle"),
        })
      ).isError,
    ).not.toBe(true);
    expect(h.enqueue).toHaveBeenLastCalledWith({
      kind: "catalog.authoring.items.lifecycle",
      action: "archive",
      selection: ids,
      context: expect.objectContaining({ audit }),
    });
    expect((await h.call("preview-bulk-publish-catalog-items", { selection: filter })).isError).not.toBe(true);
    expect(h.items.previewBulkPublish).toHaveBeenCalledWith(filter);
    const publishArgs = { itemIds: [catalogItemId], ...controls("Confirm Bulk Publish Catalog Items") };
    const publish = await h.call("confirm-bulk-publish-catalog-items", publishArgs);
    expect(publish.isError).not.toBe(true);
    expect(h.enqueue).toHaveBeenLastCalledWith({
      kind: "catalog.authoring.items.publish",
      action: "publish",
      itemIds: [catalogItemId],
      context: expect.objectContaining({ audit }),
    });
    const enqueueCount = h.enqueue.mock.calls.length;
    expect(await h.call("confirm-bulk-publish-catalog-items", publishArgs)).toEqual(publish);
    expect(h.enqueue).toHaveBeenCalledTimes(enqueueCount);

    h.items.previewBulkEdit.mockClear();
    expect(
      (await h.call("preview-bulk-catalog-item-edit", { selection: ids, operation: { action: "setTags" } })).isError,
    ).toBe(true);
    expect(
      (
        await h.call("preview-bulk-catalog-item-edit", {
          selection: { mode: "filter" },
          operation: { action: "clearTags" },
        })
      ).isError,
    ).toBe(true);
    expect(h.items.previewBulkEdit).not.toHaveBeenCalled();
  });

  it("preserves omitted metadata and persists the operator on the event; retries cannot bypass the current gate", async () => {
    const h = harness();
    h.items.commandHandler.mockImplementation(h.aggregate.commandHandler);
    const create = {
      catalogItemId,
      title,
      subtitle,
      description,
      languageCode: "en",
      ...controls("Create Catalog Item"),
    };
    const first = await h.call("create-item", create);
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    expect(await h.call("create-item", create)).toEqual(first);
    expect((await h.call("create-item", { ...create, title: subtitle })).isError).toBe(true);
    h.authority.mockResolvedValueOnce({ kind: "denied", reason: "inactive" });
    expect((await h.call("create-item", create)).isError).toBe(true);

    const revise = {
      catalogItemId,
      title: { ...title, values: { ...title.values, en: "New title" } },
      ...controls("Revise Catalog Item Metadata"),
    };
    expect((await h.call("revise-item-metadata", revise)).isError).toBe(true);
    expect(h.items.commandHandler).toHaveBeenCalledTimes(1);
    expect((await h.call("revise-item-metadata", { ...revise, subtitle })).isError).not.toBe(true);
    const events = await h.eventStore.readStream({ streamId });
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toMatchObject({ title: revise.title, subtitle, description, languageCode: "en" });
    expect(
      events.every((event) => event.performedByUserId === actor.userId && event.forAccountId === actor.accountId),
    ).toBe(true);
  });

  it("refuses incorrect confirmation, target type and invalid inputs before command or job effects", async () => {
    const h = harness();
    const write = { catalogItemId, ...controls("Archive Catalog Item") };
    for (const args of [
      { ...write, confirmed: false },
      { ...write, confirmationText: "Archive Catalog Item" },
      { ...write, idempotencyKey: " " },
      { ...write, catalogItemId: blueprintId },
      { ...write, accountId: "other" },
    ]) {
      expect((await h.call("archive-item", args)).isError).toBe(true);
    }
    expect((await h.call("confirm-bulk-publish-catalog-items", { itemIds: [catalogItemId] })).isError).toBe(true);
    expect(
      (await h.call("publish-item", { catalogItemId, expectedVersion: -1, ...controls("Publish Catalog Item") }))
        .isError,
    ).toBe(true);
    expect((await h.call("set-field-value", { catalogItemId, fieldId, ...controls("Set Field Value") })).isError).toBe(
      true,
    );
    expect(
      (
        await h.call("set-image-fallback", {
          catalogItemId,
          imageFallback: { url: "https://example.test/front.png", alt: "", usage: "permanent" },
          ...controls("Set Image Fallback"),
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await h.call("link-external-product-reference", {
          catalogItemId,
          ...ref,
          ...controls("Link External Product Reference"),
        })
      ).isError,
    ).toBe(true);
    expect(h.items.commandHandler).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("retains the publication precondition classification without trusting client hints", async () => {
    const h = harness();
    h.items.commandHandler.mockRejectedValue(
      new CatalogItemPublicationPreconditionError("Required fields are missing.", [fieldId]),
    );
    const result = await h.call("publish-item", {
      catalogItemId,
      expectedVersion: "any",
      blueprintIsActive: true,
      requiredFieldIds: [],
      ...controls("Publish Catalog Item"),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("publication-precondition");
    expect(result.content[0]?.text).toContain(fieldId);
    expect(h.items.commandHandler).toHaveBeenCalledWith(
      expect.objectContaining({ command: { type: "PublishCatalogItem" }, expectedVersion: "any" }),
    );
  });

  it("checks the owning Blueprint before clearing an active item's Field value", async () => {
    const h = harness();
    const optionalFieldId = createId("fld");
    const context = createActorEventStoreContext(actor);
    await h.eventStore.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      context,
      events: [
        {
          eventType: "catalog.catalog-item.created",
          payload: { itemId: catalogItemId, languageCode: "en", title, subtitle: null, description },
        },
        { eventType: "catalog.catalog-item.blueprint-assigned", payload: { blueprintId } },
        { eventType: "catalog.catalog-item.field-value-set", payload: { fieldId, value: "required" } },
        { eventType: "catalog.catalog-item.field-value-set", payload: { fieldId: optionalFieldId, value: "optional" } },
        { eventType: "catalog.catalog-item.published", payload: { blueprintId } },
      ],
    });
    const runtime = createCatalogItemRuntime({
      eventStore: h.eventStore,
      db: {
        async query<Row>(sql: string, values: readonly unknown[] = []) {
          expect(sql).toContain("FROM catalog_blueprints");
          expect(values).toEqual([blueprintId]);
          return {
            rows: [{ blueprint_status: "active", blueprint_field_rules: [{ fieldId, required: true }] }] as Row[],
          };
        },
      },
      checkpointStore: { loadCheckpoint: async () => ZERO_GLOBAL_POSITION, saveCheckpoint: async () => undefined },
    });
    h.items.commandHandler.mockImplementation(runtime.commandHandler);
    const args = { catalogItemId, requiredFieldIds: [], ...controls("Clear Field Value") };
    const denied = await h.call("clear-field-value", { ...args, fieldId });
    expect(denied.content[0]?.text).toContain("Required field values cannot be cleared");
    expect(await h.eventStore.readStream({ streamId })).toHaveLength(5);
    const cleared = await h.call("clear-field-value", {
      ...args,
      fieldId: optionalFieldId,
      idempotencyKey: "clear-optional",
    });
    expect(cleared.isError, JSON.stringify(cleared)).not.toBe(true);
    expect((await h.eventStore.readStream({ streamId })).at(-1)).toMatchObject({
      eventType: "catalog.catalog-item.field-value-cleared",
      performedByUserId: actor.userId,
      forAccountId: actor.accountId,
      payload: { fieldId: optionalFieldId },
    });
  });
});
