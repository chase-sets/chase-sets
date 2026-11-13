import type { ResolvedActor } from "@chase-sets/auth-context";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import { coerceLocalizedTextMap } from "@chase-sets/localization";
import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import type { McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import { z } from "zod";
import type { CatalogAuthoringBulkJobServices } from "../../../support/authoring-support/bulk-authoring-jobs";
import { commandSnapshotResponse } from "../../../support/authoring-support/api-command-response";
import { normalizeBulkSelection, toOptionalString } from "../../../support/runtime-support/bulk-lifecycle";
import type { BlueprintCommand } from "../domain/domain";
import type { BlueprintServices } from "./runtime";

const blueprintId = z.string().transform((value) => parseTypedIdBoundary(value, "bpr", "blueprintId"));
const componentId = z.string().transform((value) => parseTypedIdBoundary(value, "cmp", "componentId"));
const dimensionId = z.string().transform((value) => parseTypedIdBoundary(value, "dim", "dimensionId"));
const fieldId = z.string().transform((value) => parseTypedIdBoundary(value, "fld", "fieldId"));
const optionId = z.string().transform((value) => parseTypedIdBoundary(value, "chc", "optionId"));
const localizedText = z.strictObject({ defaultLocale: z.string(), values: z.record(z.string(), z.string()) });
const metadata = {
  key: z.string(),
  name: localizedText,
  description: localizedText.optional(),
};
const query = z.strictObject({
  search: z.string().optional(),
  status: z.string().optional(),
  hasComponents: z.string().optional(),
  hasFieldRules: z.string().optional(),
  hasDimensionRules: z.string().optional(),
});
const selection = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("ids"), ids: z.array(blueprintId) }),
  z.strictObject({ mode: z.literal("filter"), query }),
]);
const bulk = { action: z.enum(["publish", "deprecate", "archive"]), selection };
const write = {
  idempotencyKey: z.string().trim().min(1),
  confirmed: z.boolean().optional(),
  confirmationText: z.string(),
};

function operator(actor: ResolvedActor | null, permission: string): ResolvedActor {
  if (!actor || actor.roleKey !== "platform-admin" || !actor.permissions.includes(permission)) {
    throw new Error(`Missing required operator permission: ${permission}.`);
  }
  return actor;
}

export function createBlueprintMcpHandlers(
  services: BlueprintServices,
  authoringJobs: Pick<CatalogAuthoringBulkJobServices, "enqueue" | "get">,
): Readonly<{ toolHandlers: Readonly<Record<string, McpToolHandler>> }> {
  const handlers: Record<string, McpToolHandler> = {};
  function command<S extends z.ZodRawShape>(
    name: string,
    shape: S,
    build: (input: z.output<z.ZodObject<S>>) => BlueprintCommand,
  ) {
    const schema = z.strictObject({ ...shape, blueprintId, ...write });
    handlers[`catalog.${name}`] = async ({ actor, arguments: args }) => {
      const scoped = operator(actor, "catalog.manage");
      schema.parse(args);
      const targetId = blueprintId.parse(args.blueprintId);
      const result = await services.commandHandler({
        streamId: `catalog.blueprint-${targetId}`,
        command: build(z.object(shape).parse(args)),
        context: createActorEventStoreContext(scoped),
      });
      return commandSnapshotResponse(targetId, result);
    };
  }

  command("create-blueprint", { blueprintId, ...metadata }, (input) => ({
    type: "CreateBlueprint",
    blueprintId: input.blueprintId,
    key: input.key,
    name: coerceLocalizedTextMap(input.name),
    description: coerceLocalizedTextMap(input.description ?? ""),
  }));
  command("revise-blueprint", metadata, (input) => ({
    type: "ReviseBlueprint",
    key: input.key,
    name: coerceLocalizedTextMap(input.name),
    description: coerceLocalizedTextMap(input.description ?? ""),
  }));
  command("attach-component", { componentId }, (input) => ({
    type: "AttachComponentToBlueprint",
    componentId: input.componentId,
  }));
  command("detach-component", { componentId }, (input) => ({
    type: "DetachComponentFromBlueprint",
    componentId: input.componentId,
  }));
  command(
    "set-blueprint-fields",
    {
      fieldRules: z.array(z.strictObject({ fieldId, required: z.boolean() })),
    },
    (input) => ({ type: "SetBlueprintFields", fieldRules: input.fieldRules }),
  );
  command(
    "set-blueprint-dimensions",
    {
      dimensionRules: z.array(
        z.strictObject({
          dimensionId,
          required: z.boolean(),
          allowedOptionIds: z.array(optionId),
          appliesWhen: z.array(z.strictObject({ dimensionId, optionIds: z.array(optionId) })).optional(),
        }),
      ),
    },
    (input) => ({ type: "SetBlueprintDimensions", dimensionRules: input.dimensionRules }),
  );
  command("set-blueprint-product-resolution-rules", { canonicalDimensionOrder: z.array(dimensionId) }, (input) => ({
    type: "SetBlueprintProductResolutionRules",
    canonicalDimensionOrder: input.canonicalDimensionOrder,
  }));
  command("publish-blueprint", {}, () => ({ type: "PublishBlueprint" }));
  command("deprecate-blueprint", {}, () => ({ type: "DeprecateBlueprint" }));
  command("archive-blueprint", {}, () => ({ type: "ArchiveBlueprint" }));

  handlers["catalog.list-blueprints"] = async ({ actor, arguments: args }) => {
    operator(actor, "catalog.view");
    const input = query.extend({ limit: z.number().optional(), offset: z.number().optional() }).parse(args);
    const result = await services.listBlueprints({
      ...input,
      limit: input.limit || undefined,
      offset: input.offset || undefined,
    });
    return { items: result.items, total: result.total, count: result.items.length };
  };
  handlers["catalog.get-blueprint"] = async ({ actor, arguments: args }) => {
    operator(actor, "catalog.view");
    const input = z.strictObject({ blueprintId }).parse(args);
    const result = await services.getBlueprintDetail(input.blueprintId);
    if (!result) throw new Error("Blueprint not found.");
    return result;
  };
  handlers["catalog.preview-bulk-blueprint-lifecycle"] = async ({ actor, arguments: args }) => {
    operator(actor, "catalog.manage");
    const input = z.strictObject(bulk).parse(args);
    const preview = await services.bulkLifecycle.preview(await resolveSelection(input.selection), input.action);
    return { ...preview, mode: input.selection.mode };
  };
  handlers["catalog.confirm-bulk-blueprint-lifecycle"] = async ({ actor, arguments: args }) => {
    const scoped = operator(actor, "catalog.manage");
    const input = z.strictObject({ ...bulk, ...write }).parse(args);
    return authoringJobs.enqueue({
      kind: "catalog.authoring.blueprints.lifecycle",
      action: input.action,
      selection: await resolveSelection(input.selection),
      context: createActorEventStoreContext(scoped),
    });
  };
  handlers["catalog.get-authoring-job"] = async ({ actor, arguments: args }) => {
    const scoped = operator(actor, "catalog.view");
    const { jobId } = z.strictObject({ jobId: z.string().trim().min(1) }).parse(args);
    const job = await authoringJobs.get(jobId, createActorEventStoreContext(scoped));
    if (!job) throw new Error("Catalog authoring job not found.");
    return job;
  };
  return { toolHandlers: handlers };

  async function resolveSelection(value: z.output<typeof selection>) {
    const normalized = normalizeSelection(value);
    if (normalized.mode === "ids") return normalized;
    // The HTTP filter resolver uses a single default page. MCP must not silently select that prefix.
    const ids: string[] = [];
    let expectedTotal: number | undefined;
    for (let offset = 0; offset <= 10_000; offset += 500) {
      const page = await services.listBlueprints({ ...normalized.query, limit: 500, offset });
      expectedTotal ??= page.total;
      if (expectedTotal > 10_500) break;
      if (page.total !== expectedTotal || (page.items.length === 0 && ids.length < expectedTotal)) break;
      ids.push(...page.items.map((row) => row.blueprint_id));
      if (ids.length === expectedTotal && new Set(ids).size === expectedTotal) {
        return { mode: "ids" as const, ids };
      }
      if (ids.length >= expectedTotal) break;
    }
    throw new Error(
      "Blueprint selection is incomplete or changed while paging; use explicit ids or a narrower filter.",
    );
  }
}

function normalizeSelection(value: z.output<typeof selection>) {
  return normalizeBulkSelection(value, (record) => ({
    search: toOptionalString(record.search),
    status: toOptionalString(record.status),
    hasComponents: toOptionalString(record.hasComponents),
    hasFieldRules: toOptionalString(record.hasFieldRules),
    hasDimensionRules: toOptionalString(record.hasDimensionRules),
  }));
}
