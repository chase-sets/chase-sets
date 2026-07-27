import {
  type McpServiceDescriptor,
  mutationInput,
  objectSchema,
  readTool,
  resource,
  service,
  stringProperty,
  writeTool,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

export const catalogService = {
  ...service(
    "catalog",
    "Catalog",
    "bounded-contexts/catalog",
    "Categories, dimensions, fields, components, blueprints, and catalog items.",
    "catalog.view",
    ["catalog-item"],
    {
      packageName: "@chase-sets/catalog",
    },
  ),
  tools: [
    readTool(
      "catalog",
      "search-items",
      "Search Catalog Items",
      "Search published and administrative catalog item read models.",
      "catalog.view",
      objectSchema({
        query: stringProperty("Catalog search term."),
        blueprintId: stringProperty("Optional blueprint filter."),
      }),
      "catalog-item",
      ["Use before mapping inventory, listings, or pricing to a canonical catalog item."],
    ),
    readTool(
      "catalog",
      "get-blueprint",
      "Get Blueprint",
      "Read blueprint dimensions, components, and product resolution rules.",
      "catalog.view",
      objectSchema({ blueprintId: stringProperty("Blueprint identifier.") }, ["blueprintId"]),
      "blueprint",
      ["Use to understand valid product metadata and dimensions."],
    ),
    writeTool(
      "catalog",
      "publish-item",
      "Publish Catalog Item",
      "Publish a catalog item for marketplace use.",
      "catalog.manage",
      mutationInput("catalogItemId", "Catalog item to publish."),
      "catalog-item",
      ["Use after validating dimensions, fields, and merchandising readiness."],
    ),
  ],
  resources: [
    resource(
      "catalog",
      "chase-sets://catalog/items/{catalogItemId}",
      "Catalog Item",
      "Canonical item facts and public merchandising state.",
      "catalog.view",
      ["Use as the source of truth for product identity."],
    ),
  ],
} as const satisfies McpServiceDescriptor;
