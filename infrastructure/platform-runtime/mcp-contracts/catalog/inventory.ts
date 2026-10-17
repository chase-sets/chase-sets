import {
  type McpJsonSchema,
  type McpJsonSchemaProperty,
  type McpServiceDescriptor,
  accountScopedListOutputSchema,
  arrayProperty,
  booleanProperty,
  guardrails,
  idempotencyKeyProperty,
  integerProperty,
  mutationInput,
  objectSchema,
  readTool,
  resource,
  service,
  stringProperty,
  writeTool,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";
import { inventoryCallerSelectableAdjustmentReasons } from "@chase-sets/event-core/public-event-payloads/inventory";

const importSourceProfileOutputProperty: McpJsonSchemaProperty = {
  type: "object",
  description: "Inventory import source profile.",
  additionalProperties: true,
  required: [
    "sourceKey",
    "label",
    "kind",
    "adapterVersion",
    "displayNameValueKeys",
    "values",
    "externalReferenceCandidates",
    "selectedOptionInference",
  ],
  properties: {
    sourceKey: stringProperty("Configured import source key."),
    label: stringProperty("Human-readable import source label."),
    kind: stringProperty("Import source transport kind.", ["csv", "api"]),
    adapterVersion: integerProperty("Version of the import adapter contract."),
    nativePassthrough: booleanProperty("Whether rows pass through native Chase Sets CSV fields."),
    displayNameValueKeys: arrayProperty("Value keys that make a row display name.", stringProperty("Value key.")),
    rowNoteValueKeys: arrayProperty("Value keys used to build review notes.", stringProperty("Value key.")),
    values: arrayProperty("Value mappings accepted by this source.", {
      type: "object",
      description: "Import value mapping.",
      additionalProperties: true,
      required: ["targetKey"],
      properties: {
        targetKey: stringProperty("Normalized target value key."),
      },
    }),
    externalReferenceCandidates: arrayProperty("External reference candidates inferred from source rows.", {
      type: "object",
      description: "External reference candidate rule.",
      additionalProperties: true,
      required: ["providerKey", "externalKeyPrefix", "targetIntent"],
      properties: {
        providerKey: stringProperty("External provider key."),
        externalKeyPrefix: stringProperty("Prefix used for external reference keys."),
        targetIntent: stringProperty("How this external reference should be resolved."),
      },
    }),
    selectedOptionInference: arrayProperty("Catalog option inference rules for source rows.", {
      type: "object",
      description: "Selected option inference rule.",
      additionalProperties: true,
      required: ["dimensionKey", "headers"],
      properties: {
        dimensionKey: stringProperty("Catalog dimension key."),
        headers: arrayProperty("Source headers used for the dimension.", stringProperty("Source header.")),
      },
    }),
  },
};

const inventoryImportSourcesOutputSchema = objectSchema(
  {
    items: arrayProperty("Supported inventory import source profiles.", importSourceProfileOutputProperty),
    total: integerProperty("Total supported source profile count."),
  },
  ["items", "total"],
);

const importBatchRowOutputProperty: McpJsonSchemaProperty = {
  type: "object",
  description: "Inventory import batch row.",
  additionalProperties: true,
  required: [
    "row_id",
    "batch_id",
    "row_number",
    "status",
    "quantity_mode",
    "resolution_status",
    "validation_errors",
    "created_at",
    "updated_at",
  ],
  properties: {
    row_id: stringProperty("Import batch row identifier."),
    batch_id: stringProperty("Import batch identifier."),
    row_number: integerProperty("Source row number."),
    status: stringProperty("Import row status.", ["accepted", "rejected", "committed"]),
    quantity_mode: stringProperty("How row quantities affect stock.", ["add", "replace"]),
    resolution_status: stringProperty("Catalog resolution status.", ["native", "resolved", "unresolved"]),
    validation_errors: arrayProperty("Validation errors for the row.", stringProperty("Validation error.")),
    created_at: stringProperty("Creation timestamp."),
    updated_at: stringProperty("Last update timestamp."),
  },
};

const inventoryImportBatchDetailOutputSchema: McpJsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    batch_id: stringProperty("Import batch identifier."),
    account_id: stringProperty("Account that owns the import batch."),
    status: stringProperty("Import batch status.", ["uploaded", "committed"]),
    source_key: stringProperty("Configured import source key."),
    adapter_version: integerProperty("Version of the import adapter contract."),
    quantity_mode: stringProperty("How row quantities affect stock.", ["add", "replace"]),
    total_count: integerProperty("Total row count."),
    accepted_count: integerProperty("Accepted row count."),
    rejected_count: integerProperty("Rejected row count."),
    committed_count: integerProperty("Committed row count."),
    created_at: stringProperty("Creation timestamp."),
    updated_at: stringProperty("Last update timestamp."),
    rows: arrayProperty("Import batch rows.", importBatchRowOutputProperty),
  },
  required: [
    "batch_id",
    "account_id",
    "status",
    "source_key",
    "adapter_version",
    "quantity_mode",
    "total_count",
    "accepted_count",
    "rejected_count",
    "committed_count",
    "created_at",
    "updated_at",
    "rows",
  ],
};

const recoveredItemInputEnums: Readonly<Record<string, readonly string[]>> = {
  outcome: ["authentic", "not-authentic", "inconclusive"],
  legalOwner: ["platform", "original-seller", "buyer", "unknown"],
  authorityKind: ["terms-acceptance", "explicit-consent", "abandoned-property", "carrier-settlement", "legal-review"],
  disposition: [
    "return-to-original-seller",
    "return-to-buyer",
    "platform-resale",
    "liquidation",
    "donation",
    "destruction",
    "carrier-claim",
    "lost-unresolved",
  ],
  recoveryType: ["resale-proceeds", "liquidation-proceeds", "carrier-claim", "postage-refund", "disposition-cost"],
};

export const inventoryService = {
  ...service(
    "inventory",
    "Inventory",
    "bounded-contexts/inventory",
    "Inventory items, holds, reservations, and storage locations.",
    "inventory.view",
    ["inventory-item"],
    {
      packageName: "@chase-sets/inventory",
    },
  ),
  tools: [
    {
      ...readTool(
        "inventory",
        "list-items",
        "List Inventory Items",
        "List inventory items, hold-derived availability, and sale readiness for an account.",
        "inventory.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            catalogItemId: stringProperty("Optional Catalog Item natural key filter."),
            productId: stringProperty("Optional resolved Product natural key filter."),
            storageLocationId: stringProperty(
              "Optional storage location filter (ULID). Alternative to storageLocationName.",
            ),
            storageLocationName: stringProperty(
              "Optional storage location filter by exact name (case-insensitive). Alternative to storageLocationId; if the name matches more than one location, the tool returns a disambiguation error listing the candidate ids.",
            ),
            status: stringProperty("Deprecated alias for availability.", ["available", "held", "out-of-stock"]),
            availability: stringProperty("Optional hold-derived availability filter.", [
              "available",
              "held",
              "out-of-stock",
            ]),
            limit: integerProperty("Maximum items to return."),
            offset: integerProperty("Result offset."),
          },
          ["accountId"],
        ),
        "inventory-item",
        ["Use before creating or updating listings, pricing recommendations, or stock holds."],
      ),
      availability: "available",
      outputSchema: accountScopedListOutputSchema("Inventory item rows visible to the actor."),
    },
    {
      ...readTool(
        "inventory",
        "list-import-sources",
        "List Inventory Import Sources",
        "List supported inventory import source profiles, field mappings, external reference candidates, and option inference rules.",
        "inventory.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
          },
          ["accountId"],
        ),
        "import-source-profile",
        ["Use before creating an import batch so agents can choose the right sourceKey and row shape."],
      ),
      availability: "available",
      outputSchema: inventoryImportSourcesOutputSchema,
    },
    {
      ...writeTool(
        "inventory",
        "create-import-batch",
        "Create Inventory Import Batch",
        "Accept a recoverable import validation job from CSV text or pre-parsed provider rows. Read the exact attempt receipt after a possible send; acceptance is not validation or stock commit.",
        "inventory.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            sourceKey: stringProperty("Configured import source key."),
            quantityMode: stringProperty("How row quantities should affect stock.", ["add", "replace"]),
            csvText: stringProperty("CSV text to parse through the configured source profile."),
            parsedRows: arrayProperty("Pre-parsed rows to normalize through the configured source profile.", {
              type: "object",
              description: "Parsed row with rowNumber and string values.",
              additionalProperties: false,
              required: ["rowNumber", "values"],
              properties: {
                rowNumber: integerProperty("Distinct positive source row identity."),
                values: {
                  type: "object",
                  description:
                    "Text cells normalized by the selected source adapter; unknown upload fields are not retained.",
                  additionalProperties: true,
                },
              },
            }),
            defaultStorageLocationId: stringProperty(
              "Default Inventory Storage Location (ULID) for rows that omit one. Alternative to defaultStorageLocationName.",
            ),
            defaultStorageLocationName: stringProperty(
              "Default Inventory Storage Location name (case-insensitive, active locations only) for rows that omit one. Alternative to defaultStorageLocationId; if the name matches more than one active location, the tool returns a disambiguation error listing the candidate ids.",
            ),
            sourceFilename: stringProperty("Optional display hint, discarded and never retained with the import."),
            idempotencyKey: idempotencyKeyProperty(),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate the action without committing it."),
          },
          ["accountId", "sourceKey", "quantityMode", "idempotencyKey", "confirmationText"],
        ),
        "import-batch",
        ["Use after source rows are fetched and before committing stock or draft listings."],
      ),
      availability: "available",
      guardrails: guardrails("sensitive", { idempotencyAuthority: "owner", dryRunSupported: false }),
      outputSchema: objectSchema(
        {
          receiptVersion: integerProperty("Durable import acceptance receipt version (1)."),
          jobId: stringProperty("Durable validation job identity."),
          batchId: stringProperty("Recoverable import batch identity."),
          status: stringProperty("Acceptance does not assert validation or stock commit.", ["accepted"]),
        },
        ["receiptVersion", "jobId", "batchId", "status"],
      ),
    },
    {
      ...readTool(
        "inventory",
        "get-import-batch",
        "Get Inventory Import Batch",
        "Read import batch match results, validation errors, and committed inventory/listing ids.",
        "inventory.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            batchId: stringProperty("Import batch identifier."),
          },
          ["accountId", "batchId"],
        ),
        "import-batch",
        ["Use after creating a batch to inspect accepted, rejected, unresolved, and committed rows."],
      ),
      availability: "available",
      outputSchema: inventoryImportBatchDetailOutputSchema,
    },
    {
      ...writeTool(
        "inventory",
        "commit-import-batch",
        "Commit Inventory Import Batch",
        "Accept a durable job to commit reviewed import rows into Inventory Items and draft Listings; read the job for its outcome.",
        "inventory.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            batchId: stringProperty("Import batch identifier."),
            reason: stringProperty("Business reason for the action."),
            idempotencyKey: idempotencyKeyProperty(),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate the action without committing it."),
          },
          ["accountId", "batchId", "reason", "idempotencyKey", "confirmationText"],
        ),
        "import-batch",
        ["Use only after reviewing match outcomes and confirming rejected rows should remain in review."],
      ),
      availability: "available",
      outputSchema: objectSchema(
        {
          receiptVersion: integerProperty("Durable import acceptance receipt version (1)."),
          jobId: stringProperty("Durable commit job identity."),
          batchId: stringProperty("Inventory import batch identity."),
          status: stringProperty("accepted; read the durable job for its terminal outcome."),
        },
        ["receiptVersion", "jobId", "batchId", "status"],
      ),
    },
    {
      ...writeTool(
        "inventory",
        "adjust-item",
        "Adjust Inventory Item",
        "Adjust inventory item quantity through the stock ledger while preserving active hold constraints.",
        "inventory.manage",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            inventoryItemId: stringProperty("Inventory item to adjust."),
            quantityDelta: integerProperty("Signed quantity adjustment. Positive adds stock; negative removes stock."),
            reason: stringProperty("Business reason for the stock adjustment."),
            reasonCode: stringProperty("Typed reason for the stock adjustment.", [
              ...inventoryCallerSelectableAdjustmentReasons,
            ]),
            note: stringProperty("Optional operator note for the stock adjustment."),
            acquisitionOccurredAt: stringProperty(
              "Optional timezone-bearing acquisition occurrence for positive stock intake. Omit when unknown; forbidden for reductions.",
            ),
            idempotencyKey: stringProperty(
              "Caller-created Inventory mutation attempt UUIDv4. Reuse only for the same normalized intent; after response loss read the original result.",
            ),
            collisionMode: stringProperty("Stock reduction collision policy.", ["protect-orders", "honor-offline"]),
            confirmSellerCannotFulfill: booleanProperty("Explicit Honor Offline confirmation."),
            confirmationText: stringProperty("Exact user or policy confirmation text."),
            dryRun: booleanProperty("Validate the action without committing it."),
          },
          ["accountId", "inventoryItemId", "quantityDelta", "reason", "idempotencyKey", "confirmationText"],
        ),
        "inventory-item",
        ["Use for explicit stock corrections after checking active holds and ledger history."],
      ),
      availability: "available",
      guardrails: guardrails("sensitive", { idempotencyAuthority: "owner", dryRunSupported: false }),
    },
    {
      ...readTool(
        "inventory",
        "get-mutation-attempt",
        "Get Inventory Mutation Result",
        "Read the exact original Inventory result without resubmitting a change.",
        "inventory.view",
        objectSchema(
          {
            accountId: stringProperty("Authenticated account scope."),
            attemptId: stringProperty("Original caller-created attempt UUIDv4."),
          },
          ["accountId", "attemptId"],
        ),
        "inventory-mutation-attempt",
        ["Use after an uncertain response; an unavailable result does not authorize a second write."],
      ),
      availability: "available",
    },
    writeTool(
      "inventory",
      "archive-location",
      "Archive Storage Location",
      "Archive a storage location no longer in use.",
      "inventory.manage",
      mutationInput("storageLocationId", "Storage location to archive."),
      "storage-location",
      ["Use only after confirming no active inventory depends on the location."],
      "destructive",
    ),
    {
      ...readTool(
        "inventory",
        "list-recovered-items",
        "List Recovered Items",
        "List recovered inventory items awaiting operator recovery workflow actions.",
        "recovered-inventory.view",
        objectSchema(
          {
            status: stringProperty("Optional recovered item status."),
            limit: integerProperty("Maximum records to return."),
            offset: integerProperty("Zero-based record offset."),
          },
          [],
        ),
        "recovered-item",
        ["Use to locate recovered items before an operator action."],
        "operator",
      ),
      availability: "available",
      outputSchema: objectSchema(
        {
          items: arrayProperty("Recovered item rows.", {
            type: "object",
            description: "Recovered item.",
            additionalProperties: true,
            properties: {},
          }),
          total: integerProperty("Total matching records."),
          count: integerProperty("Returned record count."),
        },
        ["items", "total", "count"],
      ),
    },
    {
      ...readTool(
        "inventory",
        "get-recovered-item-metrics",
        "Get Recovered Item Metrics",
        "Read aggregate recovered inventory recovery and value metrics.",
        "recovered-inventory.view",
        objectSchema({}, []),
        "recovered-item-metrics",
        ["Use for recovery operations monitoring."],
        "operator",
      ),
      availability: "available",
    },
    ...(
      [
        [
          "identify-recovered-item",
          "Identify Recovered Item",
          "Identify a recovered item with catalog identity and evidence.",
          "sensitive",
          ["id", "catalogItemId", "productId", "selectedOptions", "evidenceReferences", "occurredAt"],
        ],
        [
          "inspect-recovered-item",
          "Inspect Recovered Item",
          "Complete condition inspection for a recovered item.",
          "sensitive",
          ["id", "conditionGrade", "evidenceReferences", "occurredAt"],
        ],
        [
          "require-recovered-item-authenticity-review",
          "Require Recovered Item Authenticity Review",
          "Require authenticity review under the applicable policy.",
          "sensitive",
          ["id", "policyVersion", "reasonCode", "evidenceReferences", "occurredAt"],
        ],
        [
          "complete-recovered-item-authenticity-review",
          "Complete Recovered Item Authenticity Review",
          "Record the outcome of a recovered item authenticity review.",
          "sensitive",
          ["id", "outcome", "reviewReference", "evidenceReferences", "occurredAt"],
        ],
        [
          "record-recovered-item-disposition-authority",
          "Record Recovered Item Disposition Authority",
          "Record ownership authority and allowed dispositions for a recovered item.",
          "sensitive",
          [
            "id",
            "legalOwner",
            "authorityKind",
            "allowedDispositions",
            "policyVersion",
            "evidenceReferences",
            "occurredAt",
          ],
        ],
        [
          "decide-recovered-item-disposition",
          "Decide Recovered Item Disposition",
          "Choose and persist the authorized disposition for a recovered item.",
          "destructive",
          [
            "id",
            "disposition",
            "targetAccountId",
            "storageLocationId",
            "policyVersion",
            "evidenceReferences",
            "reasonCode",
            "occurredAt",
          ],
        ],
        [
          "record-recovered-item-value",
          "Record Recovered Item Value",
          "Record recovered proceeds or costs for a recovered item.",
          "sensitive",
          [
            "id",
            "recoveryId",
            "recoveryType",
            "grossAmount",
            "costAmount",
            "currencyCode",
            "policyVersion",
            "evidenceReferences",
            "occurredAt",
          ],
        ],
        [
          "correct-recovered-item-source",
          "Correct Recovered Item Source",
          "Correct the return shipment source for a recovered item with evidence.",
          "sensitive",
          ["id", "correctedReturnShipmentId", "reason", "evidenceReferences", "occurredAt"],
        ],
        [
          "merge-recovered-item",
          "Merge Recovered Item",
          "Merge a duplicate recovered item into a canonical item.",
          "destructive",
          ["id", "canonicalRecoveredItemId", "reason", "evidenceReferences", "occurredAt"],
        ],
      ] as const
    ).map(([name, title, description, risk, fields]) => ({
      ...writeTool(
        "inventory",
        name,
        title,
        description,
        "recovered-inventory.manage",
        objectSchema(
          Object.fromEntries([
            ["id", stringProperty("Recovered item identifier.")],
            ...(fields as readonly string[])
              .filter((field) => field !== "id")
              .map((field) => [
                field,
                field === "evidenceReferences" || field === "allowedDispositions"
                  ? arrayProperty(
                      `${field} values.`,
                      stringProperty(
                        `${field} value.`,
                        field === "allowedDispositions" ? recoveredItemInputEnums.disposition : undefined,
                      ),
                    )
                  : field === "selectedOptions"
                    ? arrayProperty("Selected catalog options.", {
                        type: "object",
                        description: "Selected catalog option.",
                        additionalProperties: false,
                        required: ["dimensionId", "optionId"],
                        properties: {
                          dimensionId: stringProperty("Catalog option dimension."),
                          optionId: stringProperty("Catalog option value."),
                        },
                      })
                    : stringProperty(`${field} value.`, recoveredItemInputEnums[field]),
              ]),
            ["idempotencyKey", idempotencyKeyProperty()],
            ["confirmed", booleanProperty("Explicit confirmation of this action.")],
            ["confirmationText", stringProperty("Exact tool title confirmation text.")],
          ]),
          [
            "id",
            ...(fields as readonly string[]).filter(
              (field) =>
                !["id", "targetAccountId", "storageLocationId", "occurredAt", "selectedOptions"].includes(field),
            ),
            "idempotencyKey",
            "confirmed",
            "confirmationText",
          ],
        ),
        "recovered-item",
        ["Use only after reviewing the current recovered item state and required evidence."],
        risk,
        "operator",
      ),
      availability: "available" as const,
      guardrails: guardrails(risk, { dryRunSupported: false }),
    })),
  ],
  resources: [
    {
      ...resource(
        "inventory",
        "chase-sets://inventory/{accountId}/items/{inventoryItemId}",
        "Inventory Item",
        "Seller-owned inventory item state, hold-derived availability, and stock ledger.",
        "inventory.view",
        ["Use before pricing, listing, stock holds, or adjustment actions."],
      ),
      availability: "available",
    },
    {
      ...resource(
        "inventory",
        "chase-sets://inventory/{accountId}/import-batches/{batchId}",
        "Inventory Import Batch",
        "Review-first inventory import batch with product match and draft listing outcomes.",
        "inventory.view",
        ["Use after an agent creates or commits an import batch."],
      ),
      availability: "available",
    },
  ],
} as const satisfies McpServiceDescriptor;
