import type { ResolvedActor } from "@chase-sets/auth-context";
import { parseTypedIdBoundary } from "@chase-sets/http/typed-id";
import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import type { McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import { z } from "zod";
import { toReplaceProductContentsInput } from "./route";
import type { ProductContentServices } from "./runtime";

const container = z.strictObject({
  containerCatalogItemId: z.string().transform((value) => parseTypedIdBoundary(value, "cat", "containerCatalogItemId")),
});
const contained = z.strictObject({
  containedCatalogItemId: z.string().transform((value) => parseTypedIdBoundary(value, "cat", "containedCatalogItemId")),
});
const selectedOptions = z.array(z.strictObject({ dimensionId: z.string(), optionId: z.string() })).optional();
const containerRead = container.extend({ containerSelectedOptions: selectedOptions });
const replace = containerRead.extend({
  expectedVersion: z.int().nonnegative(),
  lines: z.array(
    z.strictObject({
      containedCatalogItemId: z.string().nullable().optional(),
      containedSelectedOptions: selectedOptions,
      quantity: z.number().nullable().optional(),
      contentTypeId: z.string(),
      inclusionPolicyId: z.string().nullable().optional(),
      provenance: z.record(z.string(), z.json()).optional(),
    }),
  ),
  idempotencyKey: z.string().trim().min(1),
  confirmed: z.literal(true),
  confirmationText: z.string(),
});

function operator(actor: ResolvedActor | null, permission: "catalog.view" | "catalog.manage"): ResolvedActor {
  if (actor?.roleKey !== "platform-admin" || !actor.permissions.includes(permission)) {
    throw new Error(`Missing required operator permission: ${permission}.`);
  }
  return actor;
}

function listResponse<T>(items: readonly T[]) {
  return { items, total: items.length, count: items.length };
}

export function createProductContentsMcpHandlers(services: ProductContentServices): Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
}> {
  return {
    toolHandlers: {
      "catalog.list-product-content-types": async ({ actor, arguments: args }) => {
        operator(actor, "catalog.view");
        z.strictObject({}).parse(args);
        return listResponse(await services.listProductContentTypes());
      },
      "catalog.list-product-content-inclusion-policies": async ({ actor, arguments: args }) => {
        operator(actor, "catalog.view");
        z.strictObject({}).parse(args);
        return listResponse(await services.listProductContentInclusionPolicies());
      },
      "catalog.list-product-contents-for-container": async ({ actor, arguments: args }) => {
        operator(actor, "catalog.view");
        const { containerCatalogItemId, containerSelectedOptions } = containerRead.parse(args);
        if (containerSelectedOptions !== undefined) {
          return services.readProductContentsAuthoringState(containerCatalogItemId, containerSelectedOptions);
        }
        return listResponse(await services.listProductContentsForContainer(containerCatalogItemId));
      },
      "catalog.list-product-containers-for-contained": async ({ actor, arguments: args }) => {
        operator(actor, "catalog.view");
        const { containedCatalogItemId } = contained.parse(args);
        return listResponse(await services.listProductContainersForContained(containedCatalogItemId));
      },
      "catalog.replace-product-contents": async ({ actor, arguments: args }) => {
        const scoped = operator(actor, "catalog.manage");
        const input = replace.parse(args);
        return services.replaceProductContents(
          toReplaceProductContentsInput(input.containerCatalogItemId, input),
          createActorEventStoreContext(scoped),
        );
      },
    },
  };
}
