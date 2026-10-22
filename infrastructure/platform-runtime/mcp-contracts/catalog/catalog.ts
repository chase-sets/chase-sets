import {
  arrayProperty,
  booleanProperty,
  idempotencyKeyProperty,
  integerProperty,
  mutationInput,
  type McpToolDescriptor,
  type McpServiceDescriptor,
  objectSchema,
  readTool,
  resource,
  service,
  stringProperty,
  writeTool,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

const opRead = (
  name: string,
  title: string,
  permission: string,
  properties: Parameters<typeof objectSchema>[0] = {},
  required: readonly string[] = [],
  target = name,
) => ({
  ...readTool(
    "catalog",
    name,
    title,
    `Operator ${title.toLowerCase()}.`,
    permission,
    objectSchema(properties, required),
    target,
    [`Use ${title.toLowerCase()} before the next Catalog workflow step.`],
    "operator",
  ),
  availability: "available" as const,
});
const writeFields = {
  idempotencyKey: idempotencyKeyProperty(),
  confirmationText: stringProperty("Confirmation text."),
};
const writeRequired = ["idempotencyKey", "confirmationText"] as const;
const opWrite = (
  name: string,
  title: string,
  permission: string,
  properties: Parameters<typeof objectSchema>[0],
  required: readonly string[],
  target = name,
) => ({
  ...writeTool(
    "catalog",
    name,
    title,
    `Operator ${title.toLowerCase()}.`,
    permission,
    objectSchema(properties, required),
    target,
    [`Use ${title.toLowerCase()} after inspecting the current Catalog state.`],
    "sensitive",
    "operator",
  ),
  availability: "available" as const,
});
const unknownObject = (description: string) => ({
  type: "object" as const,
  description,
  additionalProperties: true,
  properties: {},
});
const idempotent = (properties: Parameters<typeof objectSchema>[0]) => ({
  ...properties,
  ...writeFields,
});

const baseCatalogService = service(
  "catalog",
  "Catalog",
  "bounded-contexts/catalog",
  "Categories, dimensions, fields, components, blueprints, and catalog items.",
  "catalog.view",
  ["catalog-item"],
  { packageName: "@chase-sets/catalog" },
);

const plannedCatalogTools: readonly McpToolDescriptor[] = [
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
];

const tools: readonly McpToolDescriptor[] = [
  opRead(
    "list-provider-refresh-schedules",
    "List Provider Refresh Schedules",
    "catalog.view",
    {},
    [],
    "provider-refresh-schedule",
  ),
  opWrite(
    "run-provider-refresh",
    "Run Provider Refresh",
    "catalog.manage",
    { providerKey: stringProperty("Provider key."), ...writeFields },
    ["providerKey", ...writeRequired],
    "provider-refresh",
  ),
  opWrite(
    "pause-provider-refresh",
    "Pause Provider Refresh",
    "catalog.manage",
    { providerKey: stringProperty("Provider key."), reason: stringProperty("Reason for pausing."), ...writeFields },
    ["providerKey", ...writeRequired],
    "provider-refresh-schedule",
  ),
  opWrite(
    "resume-provider-refresh",
    "Resume Provider Refresh",
    "catalog.manage",
    { providerKey: stringProperty("Provider key."), ...writeFields },
    ["providerKey", ...writeRequired],
    "provider-refresh-schedule",
  ),
  opRead(
    "list-scope-observations",
    "List Scope Observations",
    "catalog.view",
    {
      providerKey: stringProperty("Provider key."),
      unitKey: stringProperty("Provider unit key."),
      scopeKind: stringProperty("Scope kind."),
      limit: integerProperty("Result limit."),
    },
    [],
    "provider-scope-observation",
  ),
  opRead(
    "list-scope-record-proposals",
    "List Scope Record Proposals",
    "catalog.view",
    {
      reviewStatus: stringProperty("Proposal review status."),
      productDomain: stringProperty("Product domain."),
      limit: integerProperty("Result limit."),
    },
    [],
    "scope-record-proposal",
  ),
  opWrite(
    "create-reference-record",
    "Create Reference Record",
    "catalog.manage",
    {
      referenceRecordId: stringProperty("Reference Record identifier."),
      typeKey: stringProperty("Reference Type key."),
      key: stringProperty("Stable Reference Record key."),
      name: unknownObject("Localized name map."),
      description: unknownObject("Localized description map."),
      attributes: unknownObject("Reference attributes."),
      relationships: arrayProperty("Relationships.", unknownObject("Relationship.")),
      ...writeFields,
    },
    ["referenceRecordId", "typeKey", "key", "name", ...writeRequired],
    "reference-record",
  ),
  opWrite(
    "publish-reference-record",
    "Publish Reference Record",
    "catalog.manage",
    { referenceRecordId: stringProperty("Reference Record identifier."), ...writeFields },
    ["referenceRecordId", ...writeRequired],
    "reference-record",
  ),
  opRead(
    "list-scope-records",
    "List Scope Records",
    "catalog.view",
    {
      search: stringProperty("Name search."),
      productDomain: stringProperty("Product domain."),
      scopeKind: stringProperty("Scope kind."),
      status: stringProperty("Lifecycle status."),
      referenceRecordId: stringProperty("Reference Record identifier."),
      limit: integerProperty("Page size."),
      offset: integerProperty("Page offset."),
    },
    [],
    "scope-record",
  ),
  opRead(
    "get-scope-record",
    "Get Scope Record",
    "catalog.view",
    { scopeRecordId: stringProperty("Scope Record identifier.") },
    ["scopeRecordId"],
    "scope-record",
  ),
  opRead(
    "get-scope-mapping-inbox",
    "Get Scope Mapping Inbox",
    "catalog.view",
    { productDomain: stringProperty("Product domain."), limit: integerProperty("Result limit.") },
    [],
    "provider-scope-mapping",
  ),
  opRead(
    "get-scope-coverage",
    "Get Scope Coverage",
    "catalog.view",
    { scopeRecordId: stringProperty("Scope Record identifier.") },
    ["scopeRecordId"],
    "scope-coverage",
  ),
  opWrite(
    "propose-scope-mapping",
    "Propose Scope Mapping",
    "catalog.manage",
    {
      scopeRecordId: stringProperty("Scope Record identifier."),
      providerKey: stringProperty("Provider key."),
      unitKey: stringProperty("Provider unit key."),
      coordinates: unknownObject("Provider coordinates."),
      confidence: stringProperty("Confidence tier."),
      autoAccept: booleanProperty("Accept after proposing."),
      reason: stringProperty("Acceptance reason."),
      ...writeFields,
    },
    ["scopeRecordId", "providerKey", "unitKey", ...writeRequired],
    "provider-scope-mapping",
  ),
  opWrite(
    "review-scope-mappings",
    "Review Scope Mappings",
    "catalog.manage",
    {
      intent: stringProperty("accept, reject, or revoke."),
      mappingIds: arrayProperty("Mapping identifiers.", stringProperty("Mapping identifier.")),
      reason: stringProperty("Required for reject and revoke."),
      ...writeFields,
    },
    ["intent", "mappingIds", ...writeRequired],
    "provider-scope-mapping",
  ),
  opRead(
    "preview-scope-sync-batch",
    "Preview Scope Sync Batch",
    "catalog.manage",
    { selection: unknownObject("Scope Sync selection."), budget: unknownObject("Scope Sync budget.") },
    ["selection"],
    "scope-sync-batch-preview",
  ),
  {
    ...opWrite(
      "confirm-scope-sync-batch",
      "Confirm Scope Sync Batch",
      "catalog.manage",
      {
        selection: unknownObject("Scope Sync selection."),
        budget: unknownObject("Scope Sync budget."),
        planFingerprint: stringProperty("Exact preview plan fingerprint."),
        ...writeFields,
        confirmationText: stringProperty("Must equal planFingerprint."),
      },
      ["selection", "planFingerprint", ...writeRequired],
      "scope-sync-batch",
    ),
    guardrails: {
      confirmation: {
        required: true,
        prompt: "Confirm the exact plan fingerprint.",
        matchInputValue: "planFingerprint",
      },
      idempotencyKey: "required",
      idempotencyAuthority: "platform",
      dryRunSupported: true,
      notes: ["Confirm only a fresh preview fingerprint."],
    },
  },
  opRead(
    "get-scope-sync-batch",
    "Get Scope Sync Batch",
    "catalog.view",
    { batchId: stringProperty("Scope Sync Batch identifier.") },
    ["batchId"],
    "scope-sync-batch",
  ),
  opRead(
    "list-source-observations",
    "List Source Observations",
    "catalog.view",
    {
      search: stringProperty("Search."),
      status: stringProperty("Review status."),
      provider: stringProperty("Provider."),
      language: stringProperty("Language."),
      productLineId: stringProperty("Product line id."),
      seriesId: stringProperty("Series id."),
      setId: stringProperty("Set id."),
      expansionId: stringProperty("Expansion id."),
      limit: integerProperty("Page size."),
      offset: integerProperty("Page offset."),
    },
    [],
    "source-observation",
  ),
  opWrite(
    "cancel-scope-sync-batch",
    "Cancel Scope Sync Batch",
    "catalog.manage",
    idempotent({ batchId: stringProperty("Scope Sync Batch identifier.") }),
    ["batchId", ...writeRequired],
    "scope-sync-batch",
  ),
  opWrite(
    "resume-scope-sync-batch",
    "Resume Scope Sync Batch",
    "catalog.manage",
    idempotent({ batchId: stringProperty("Scope Sync Batch identifier.") }),
    ["batchId", ...writeRequired],
    "scope-sync-batch",
  ),
  opWrite(
    "retry-scope-sync-unit",
    "Retry Scope Sync Unit",
    "catalog.manage",
    idempotent({
      batchId: stringProperty("Scope Sync Batch identifier."),
      scopeRecordId: stringProperty("Scope Record identifier."),
    }),
    ["batchId", "scopeRecordId", ...writeRequired],
    "scope-sync-batch-unit",
  ),
];

const toolsWithWorkflowGuidance = tools.map((tool) =>
  tool.name === "catalog.publish-reference-record"
    ? {
        ...tool,
        description:
          "Publish a Reference Record. The Catalog Scope Record appears after projection; poll catalog.get-scope-record before mapping it.",
      }
    : tool.name === "catalog.propose-scope-mapping"
      ? {
          ...tool,
          description:
            "Propose a Provider Scope Mapping. The mapping projection may lag; poll catalog.get-scope-coverage before previewing the Scope Sync Batch.",
        }
      : tool,
);

export const catalogService = {
  ...baseCatalogService,
  tools: [...plannedCatalogTools, ...toolsWithWorkflowGuidance],
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
