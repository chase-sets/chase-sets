import type { McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import { z } from "zod";
import type { FieldServices } from "./runtime";

const query = z.strictObject({
  search: z.string().optional(),
  status: z.string().optional(),
  valueType: z.string().optional(),
  filterable: z.string().optional(),
  searchable: z.string().optional(),
  sortable: z.string().optional(),
  limit: z.int().optional(),
  offset: z.int().optional(),
});

export function createFieldMcpHandlers(services: Pick<FieldServices, "listFields">) {
  const listFields: McpToolHandler = async ({ actor, arguments: args }) => {
    if (actor?.roleKey !== "platform-admin" || !actor.permissions.includes("catalog.view")) {
      throw new Error("Missing required operator permission: catalog.view.");
    }
    const input = query.parse(args);
    const result = await services.listFields({
      ...input,
      limit: input.limit || undefined,
      offset: input.offset || undefined,
    });
    return { ...result, count: result.items.length };
  };
  return { toolHandlers: { "catalog.list-fields": listFields } };
}
