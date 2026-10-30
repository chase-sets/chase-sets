import { describe, expect, it } from "vitest";
import type { AgentOAuthScope } from "@chase-sets/auth-context";
import { buildAgentConnectorPackaging } from "./agent-connector-packaging";
import {
  CORE_MCP_SERVICE_IDS,
  EXTERNAL_MCP_SERVICE_IDS,
  authorizeMcpToolInvocation,
  findMcpTool,
  flattenAvailableMcpResources,
  flattenAvailableMcpTools,
  flattenMcpTools,
  getMcpToolConfirmationExpectedValue,
  isOperatorToolAllowed,
  mcpServiceCatalog,
  validateMcpServiceCatalog,
  type McpActor,
  type McpJsonSchema,
  type McpJsonSchemaProperty,
  type McpServiceDescriptor,
  type McpToolDescriptor,
} from "./mcp-contracts";

const accountActor: McpActor = {
  actorId: "actor_1",
  accountId: "acct_1",
  permissions: [
    "accounts.view",
    "fulfillment.manage",
    "fulfillment.view",
    "inventory.manage",
    "inventory.view",
    "listings.manage",
    "listings.view",
    "offers.manage",
    "orders.manage",
    "orders.view",
    "payouts.request",
    "payouts.view",
  ],
};

function actualType(value: unknown) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function matchesType(value: unknown, expected: McpJsonSchemaProperty["type"]): boolean {
  if (Array.isArray(expected)) {
    return value === null || matchesType(value, expected[0]);
  }
  switch (expected) {
    case "array":
      return Array.isArray(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "boolean":
    case "string":
      return typeof value === expected;
  }
  return false;
}

function validateProperty(value: unknown, schema: McpJsonSchemaProperty, path: string): string[] {
  if (!matchesType(value, schema.type)) {
    return [`${path} expected ${schema.type} but received ${actualType(value)}.`];
  }

  const errors: string[] = [];
  if (schema.enum && typeof value === "string" && !schema.enum.includes(value)) {
    errors.push(`${path} expected one of ${schema.enum.join(", ")} but received ${value}.`);
  }
  if (schema.type === "array" && schema.items) {
    (value as readonly unknown[]).forEach((item, index) => {
      errors.push(...validateProperty(item, schema.items as McpJsonSchemaProperty, `${path}[${index}]`));
    });
  }
  if (schema.type === "object" && schema.properties) {
    errors.push(
      ...validateObject(value as Readonly<Record<string, unknown>>, {
        additionalProperties: schema.additionalProperties,
        properties: schema.properties,
        required: schema.required,
      }),
    );
  }
  return errors;
}

function validateObject(
  value: Readonly<Record<string, unknown>>,
  schema: Pick<McpJsonSchema, "additionalProperties" | "properties" | "required">,
) {
  const errors: string[] = [];
  for (const field of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      errors.push(`${field} is required.`);
    }
  }
  if (schema.additionalProperties === false) {
    for (const field of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties, field)) {
        errors.push(`${field} is not allowed.`);
      }
    }
  }
  for (const [field, propertySchema] of Object.entries(schema.properties)) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      continue;
    }
    errors.push(...validateProperty(value[field], propertySchema, field));
  }
  return errors;
}

function validateOutputSchema(schema: McpJsonSchema | undefined, value: Readonly<Record<string, unknown>>) {
  expect(schema).toBeDefined();
  return validateObject(value, schema as McpJsonSchema);
}

function publishedNonOperatorToolNames(services: readonly McpServiceDescriptor[] = mcpServiceCatalog) {
  return flattenAvailableMcpTools(services)
    .filter((tool) => tool.permissionBoundary.scope !== "operator")
    .map((tool) => tool.name)
    .sort();
}

function publishedNonOperatorResourceTemplates(services: readonly McpServiceDescriptor[] = mcpServiceCatalog) {
  return flattenAvailableMcpResources(services)
    .filter((resource) => resource.permissionBoundary.scope !== "operator")
    .map((resource) => resource.uriTemplate)
    .sort();
}

function availableOperatorBoundaryErrors(services: readonly McpServiceDescriptor[] = mcpServiceCatalog) {
  return [
    ...flattenAvailableMcpTools(services).map((tool) => ({ name: tool.name, boundary: tool.permissionBoundary })),
    ...flattenAvailableMcpResources(services).map((resource) => ({
      name: resource.uriTemplate,
      boundary: resource.permissionBoundary,
    })),
  ]
    .filter(({ boundary }) => boundary.scope === "operator")
    .flatMap(({ name, boundary }) => [
      ...(boundary.requiredPermissions.length === 0 ? [`${name} must declare a required permission.`] : []),
      ...(boundary.accountScoped ? [`${name} must not be account-scoped.`] : []),
    ]);
}

describe("MCP service catalog", () => {
  it("covers every core context and external provider that needs agent access", () => {
    expect(validateMcpServiceCatalog()).toEqual([]);
    expect(mcpServiceCatalog.map((service) => service.serviceId).sort()).toEqual(
      [...CORE_MCP_SERVICE_IDS, ...EXTERNAL_MCP_SERVICE_IDS].sort(),
    );
  });

  it("defines auditable schemas for all tools", () => {
    expect(flattenMcpTools().length).toBeGreaterThan(mcpServiceCatalog.length);

    for (const tool of flattenMcpTools()) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.audit.eventName).toMatch(/^mcp\./);
      expect(tool.audit.targetType.length).toBeGreaterThan(0);
      expect(tool.expectedUsage.length).toBeGreaterThan(0);
    }
  });

  it("marks only registered native MCP v1 capabilities as available", () => {
    // The published non-operator surface stays an exact literal that operator slices are fenced from widening;
    // operator availability is selected by descriptor scope and proven by registration validation and the
    // composition guard.
    const publishedToolNames = [
      "authenticity.get-case-status",
      "checkout.add-cart-line",
      "checkout.cancel-session",
      "checkout.get-cart",
      "checkout.remove-cart-line",
      "checkout.select-saved-address",
      "checkout.update-cart-line",
      "discovery.get-chatgpt-product-feed",
      "discovery.get-item-detail",
      "discovery.search-market",
      "fulfillment.advance-shipment",
      "fulfillment.cancel-shipment",
      "fulfillment.dispatch-shipment",
      "fulfillment.get-tracking",
      "fulfillment.list-shipments",
      "fulfillment.purchase-label",
      "fulfillment.raise-shipment-exception",
      "fulfillment.void-label",
      "identity.get-account",
      "inventory.adjust-item",
      "inventory.commit-import-batch",
      "inventory.create-import-batch",
      "inventory.get-import-batch",
      "inventory.get-mutation-attempt",
      "inventory.list-import-sources",
      "inventory.list-items",
      "marketplace.accept-offer",
      "marketplace.counter-offer",
      "marketplace.create-listing",
      "marketplace.decline-offer",
      "marketplace.get-reputation-summary",
      "marketplace.get-seller-attention-queue",
      "marketplace.get-seller-insights",
      "marketplace.list-listings",
      "marketplace.list-offers",
      "marketplace.list-reviews",
      "marketplace.publish-listing",
      "marketplace.submit-offer",
      "marketplace.unpublish-listing",
      "marketplace.update-listing-price",
      "marketplace.update-offer-price",
      "ordering.get-order",
      "ordering.list-orders",
      "payments.confirm-payment-method-setup",
      "payments.get-payment",
      "payments.get-refund-status",
      "payments.start-payment-method-setup",
      "platform-operations.get-seller-insight-summary",
      "platform-operations.get-support-request",
      "platform-operations.list-support-requests",
      "pricing.explain-signals",
      "pricing.recommend-price",
      "settlement.create-payout-onboarding-link",
      "settlement.get-payout",
      "settlement.get-wallet",
      "settlement.list-ledger-entries",
      "settlement.list-payouts",
      "settlement.refresh-readiness",
      "settlement.request-payout",
    ];
    const publishedResourceTemplates = [
      "chase-sets://authenticity/cases/{caseId}",
      "chase-sets://checkout/{accountId}/cart",
      "chase-sets://discovery/items/{itemSlug}",
      "chase-sets://fulfillment/{accountId}/shipments/{shipmentId}",
      "chase-sets://identity/{accountId}/account",
      "chase-sets://inventory/{accountId}/import-batches/{batchId}",
      "chase-sets://inventory/{accountId}/items/{inventoryItemId}",
      "chase-sets://marketplace/{accountId}/listings/{listingId}",
      "chase-sets://marketplace/{accountId}/offers/{offerId}",
      "chase-sets://marketplace/{accountId}/reputation/summaries/{subjectAccountId}",
      "chase-sets://marketplace/{accountId}/reviews/{reviewId}",
      "chase-sets://ordering/{accountId}/orders/{orderId}",
      "chase-sets://payments/{accountId}/payments/{paymentId}",
      "chase-sets://platform-operations/{accountId}/insights/summary",
      "chase-sets://platform-operations/{accountId}/support-requests/{supportRequestId}",
      "chase-sets://pricing/catalog-items/{catalogItemId}/recommendations",
      "chase-sets://settlement/{accountId}/payouts/{payoutId}",
      "chase-sets://settlement/{accountId}/wallet",
    ];
    expect(publishedNonOperatorToolNames()).toEqual(publishedToolNames);
    expect(publishedNonOperatorResourceTemplates()).toEqual(publishedResourceTemplates);
    expect(availableOperatorBoundaryErrors()).toEqual([]);
    expect(flattenMcpTools().find((tool) => tool.name === "inventory.archive-location")?.availability).toBe("planned");

    const accountTool: McpToolDescriptor = {
      ...findMcpTool("identity.get-account")!,
      name: "identity.synthetic-account-read",
    };
    const operatorTool: McpToolDescriptor = {
      ...accountTool,
      name: "platform-operations.synthetic-operator-read",
      serviceId: "platform-operations",
      permissionBoundary: {
        scope: "operator",
        requiredPermissions: ["insights-dashboards.view"],
        requiredScopes: [],
        accountScoped: false,
        auditPrincipal: "actor",
      },
    };
    const withTool = (tool: McpToolDescriptor) => [...mcpServiceCatalog, ...catalogWith(tool)];

    expect(publishedNonOperatorToolNames(withTool(accountTool))).toEqual(
      [...publishedToolNames, accountTool.name].sort(),
    );
    expect(publishedNonOperatorToolNames(withTool(operatorTool))).toEqual(publishedToolNames);
    expect(availableOperatorBoundaryErrors(withTool(operatorTool))).toEqual([]);
    expect(
      availableOperatorBoundaryErrors(
        withTool({
          ...operatorTool,
          permissionBoundary: { ...operatorTool.permissionBoundary, requiredPermissions: [] },
        }),
      ),
    ).toEqual([`${operatorTool.name} must declare a required permission.`]);
    expect(
      availableOperatorBoundaryErrors(
        withTool({ ...operatorTool, permissionBoundary: { ...operatorTool.permissionBoundary, accountScoped: true } }),
      ),
    ).toEqual([`${operatorTool.name} must not be account-scoped.`]);
  });

  it("widens inventory.adjust-item with optional closed reason fields", () => {
    const schema = findMcpTool("inventory.adjust-item")?.inputSchema;
    expect(schema).toBeDefined();
    expect(schema?.required).toEqual([
      "accountId",
      "inventoryItemId",
      "quantityDelta",
      "reason",
      "idempotencyKey",
      "confirmationText",
    ]);
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.properties.reasonCode).toMatchObject({
      type: "string",
      enum: ["sold-offline", "damaged", "lost", "found", "correction", "intake", "return-restocked"],
    });
    expect(schema?.properties.note).toMatchObject({ type: "string" });
    expect(schema?.properties.acquisitionOccurredAt).toMatchObject({ type: "string" });

    const required = {
      accountId: "acc_1",
      inventoryItemId: "inv_1",
      quantityDelta: 1,
      reason: "Cycle count",
      idempotencyKey: "adjust-1",
      confirmationText: "Confirm adjustment",
    };
    expect(validateObject(required, schema!)).toEqual([]);
    expect(validateObject({ ...required, acquisitionOccurredAt: "2026-09-07T05:00:00Z" }, schema!)).toEqual([]);
    expect(validateObject({ ...required, reasonCode: "correction", note: "Counted twice" }, schema!)).toEqual([]);
    expect(validateObject({ ...required, reasonCode: "other" }, schema!)).toContain(
      "reasonCode expected one of sold-offline, damaged, lost, found, correction, intake, return-restocked but received other.",
    );
    expect(validateObject({ ...required, unexpected: true }, schema!)).toContain("unexpected is not allowed.");
  });

  it("keeps payment-method setup dryRun a closed boolean while the source and connector contracts declare it unsupported", () => {
    const tool = findMcpTool("payments.start-payment-method-setup");
    const schema = tool?.inputSchema;
    expect(tool?.guardrails.dryRunSupported).toBe(false);
    expect(schema?.additionalProperties).toBe(false);
    expect(schema?.properties.dryRun).toMatchObject({ type: "boolean" });
    expect(schema?.required).not.toContain("dryRun");

    const required = {
      accountId: "acc_1",
      returnUrl: "https://app.chasesets.test/account/payment-methods",
      idempotencyKey: "setup-1",
      confirmationText: "Start Payment Method Setup.",
    };
    expect(validateObject(required, schema!)).toEqual([]);
    expect(validateObject({ ...required, dryRun: false }, schema!)).toEqual([]);
    expect(validateObject({ ...required, dryRun: "true" }, schema!)).toEqual([
      "dryRun expected boolean but received string.",
    ]);
    expect(validateObject({ ...required, unexpected: true }, schema!)).toEqual(["unexpected is not allowed."]);

    const registration = buildAgentConnectorPackaging().registration.tools.find(
      (entry) => entry.name === "payments.start-payment-method-setup",
    );
    expect(registration?.dry_run_supported).toBe(false);
    expect(registration?.input_schema).toEqual(schema);
  });

  it("requires the complete price pair in closed Marketplace listing write schemas", () => {
    const createSchema = findMcpTool("marketplace.create-listing")?.inputSchema;
    const updateSchema = findMcpTool("marketplace.update-listing-price")?.inputSchema;

    expect(createSchema?.additionalProperties).toBe(false);
    expect(createSchema?.required).toContain("priceAmount");
    expect(createSchema?.required).toContain("priceCurrencyCode");
    expect(createSchema?.properties.purchaseLimits).toMatchObject({ additionalProperties: false });
    expect(updateSchema?.additionalProperties).toBe(false);
    expect(updateSchema?.required).toContain("priceAmount");
    expect(updateSchema?.required).toContain("priceCurrencyCode");
  });

  it("carries selected Listing currency and source version through both closed Checkout write schemas", () => {
    const inputs = {
      "checkout.add-cart-line": {
        accountId: "acc_1",
        catalogItemId: "cat_1",
        productId: "cat_1::form:raw",
        itemTitle: "Charizard",
        quantity: 1,
        idempotencyKey: "idem_add",
        confirmationText: "Add Cart Line.",
      },
      "checkout.update-cart-line": {
        accountId: "acc_1",
        cartLineId: "cli_1",
        idempotencyKey: "idem_update",
        confirmationText: "Update Cart Line.",
      },
    } as const;

    for (const [toolName, requiredInput] of Object.entries(inputs)) {
      const schema = findMcpTool(toolName)?.inputSchema;
      const selectedListingSnapshot = schema?.properties.selectedListingSnapshot;
      expect(selectedListingSnapshot).toMatchObject({
        type: "object",
        additionalProperties: false,
        properties: {
          priceAmount: { type: "string" },
          priceCurrencyCode: { type: "string" },
          listingStreamVersion: { type: "integer" },
        },
      });

      const completeSnapshot = {
        listingId: "lst_1",
        priceAmount: "20.00",
        priceCurrencyCode: "EUR",
        listingStreamVersion: 11,
      };
      expect(validateObject({ ...requiredInput, selectedListingSnapshot: completeSnapshot }, schema!)).toEqual([]);
      expect(
        validateObject(
          { ...requiredInput, selectedListingSnapshot: { ...completeSnapshot, inferredCurrency: "USD" } },
          schema!,
        ),
      ).toContain("inferredCurrency is not allowed.");
    }
  });

  it("publishes output schemas for available MCP handler outputs", () => {
    const listSourcesOutput = {
      items: [
        {
          sourceKey: "tcgplayer-csv",
          label: "TCGplayer CSV",
          kind: "csv",
          adapterVersion: 1,
          displayNameValueKeys: ["title"],
          values: [{ targetKey: "sellerSku" }],
          externalReferenceCandidates: [
            {
              providerKey: "tcgplayer",
              externalKeyPrefix: "sku:",
              targetIntent: "product-reference",
            },
          ],
          selectedOptionInference: [{ dimensionKey: "condition", headers: ["Condition"] }],
        },
      ],
      total: 1,
    };
    const importBatchOutput = {
      batch_id: "imb_1",
      account_id: "acct_1",
      status: "uploaded",
      source_key: "tcgplayer-csv",
      adapter_version: 1,
      quantity_mode: "add",
      default_storage_location_id: null,
      total_count: 1,
      accepted_count: 1,
      rejected_count: 0,
      committed_count: 0,
      created_at: "2026-05-28T00:00:00.000Z",
      updated_at: "2026-05-28T00:00:00.000Z",
      rows: [],
    };
    const importAcceptanceOutput = {
      receiptVersion: 1,
      jobId: "job_1",
      batchId: "imb_1",
      status: "accepted",
    };

    expect(validateOutputSchema(findMcpTool("inventory.list-import-sources")?.outputSchema, listSourcesOutput)).toEqual(
      [],
    );
    for (const toolName of ["inventory.get-import-batch"]) {
      expect(validateOutputSchema(findMcpTool(toolName)?.outputSchema, importBatchOutput)).toEqual([]);
    }
    for (const toolName of ["inventory.create-import-batch", "inventory.commit-import-batch"]) {
      expect(validateOutputSchema(findMcpTool(toolName)?.outputSchema, importAcceptanceOutput)).toEqual([]);
    }
    expect(
      validateOutputSchema(findMcpTool("checkout.get-cart")?.outputSchema, {
        accountId: "acct_1",
        items: [
          {
            line_id: "cli_1",
            buyer_account_id: "acct_1",
            catalog_item_id: "cat_1",
            quantity: 1,
            product_id: "cat_1::condition:near-mint",
            item_title: "Charizard",
            updated_at: "2026-07-07T00:00:00.000Z",
          },
        ],
        total: 1,
      }),
    ).toEqual([]);
    for (const toolName of ["checkout.add-cart-line", "checkout.update-cart-line", "checkout.remove-cart-line"]) {
      expect(
        validateOutputSchema(findMcpTool(toolName)?.outputSchema, {
          accountId: "acct_1",
          id: "cli_1",
          cartLineId: "cli_1",
          version: 2,
          status: toolName === "checkout.remove-cart-line" ? "removed" : "updated",
          resourceUri: "chase-sets://checkout/acct_1/cart",
        }),
      ).toEqual([]);
    }
    expect(
      validateOutputSchema(findMcpTool("checkout.select-saved-address")?.outputSchema, {
        accountId: "acct_1",
        id: "chk_1",
        sessionId: "chk_1",
        shippingAddressId: "adr_home",
        status: "shipping-address-selected",
        resourceUri: "chase-sets://checkout/acct_1/sessions/chk_1",
        commitPosition: "42",
        commitEventIds: ["evt_shipping_address"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "42",
            eventIds: ["evt_shipping_address"],
          },
        ],
      }),
    ).toEqual([]);
    expect(
      validateOutputSchema(findMcpTool("checkout.cancel-session")?.outputSchema, {
        accountId: "acct_1",
        id: "chk_1",
        sessionId: "chk_1",
        status: "cancelled",
        cancelledAt: "2026-07-08T00:00:00.000Z",
        releasedReservationIds: ["hld_1"],
        resourceUri: "chase-sets://checkout/acct_1/sessions/chk_1",
        commitPosition: "43",
        commitEventIds: ["evt_cancelled"],
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "43",
            eventIds: ["evt_cancelled"],
          },
        ],
      }),
    ).toEqual([]);
    expect(
      validateOutputSchema(findMcpTool("discovery.search-market")?.outputSchema, {
        items: [
          {
            catalog_item_id: "cat_1",
            slug: "charizard-cat_1",
            title: "Charizard",
            status: "active",
          },
        ],
        facets: [],
        total: 1,
        count: 1,
        nextCursor: "cursor_1",
      }),
    ).toEqual([]);
    expect(
      validateOutputSchema(findMcpTool("discovery.get-item-detail")?.outputSchema, {
        catalog_item_id: "cat_1",
        slug: "charizard-cat_1",
        title: "Charizard",
        status: "active",
        market_listings: [
          {
            listing_id: "lst_1",
            product_id: "cat_1::condition:near-mint",
            price_amount: "12.34",
            visible_quantity: 1,
            status: "active",
          },
        ],
      }),
    ).toEqual([]);
    expect(
      validateOutputSchema(findMcpTool("discovery.get-chatgpt-product-feed")?.outputSchema, {
        feedFormat: "chatgpt-product-feed/v1",
        products: [
          {
            id: "cat_1",
            title: "Charizard",
            url: "https://marketplace.example/items/charizard-cat_1",
            availability: { status: "in_stock", quantity: 1 },
            price: { currency: "USD", amount: "12.34", display: "$12.34" },
            variants: [
              {
                id: "cat_1::condition:near-mint",
                listing_id: "lst_1",
                url: "https://marketplace.example/listings/charizard-near-mint-lst_1",
                price: { currency: "USD", amount: "12.34", display: "$12.34" },
                availability: { status: "in_stock", quantity: 1 },
              },
            ],
          },
        ],
        total: 1,
        count: 1,
        nextCursor: "cursor_1",
      }),
    ).toEqual([]);
    for (const toolName of [
      "marketplace.create-listing",
      "marketplace.update-listing-price",
      "marketplace.publish-listing",
      "marketplace.unpublish-listing",
    ]) {
      expect(
        validateOutputSchema(findMcpTool(toolName)?.outputSchema, {
          accountId: "acct_1",
          id: "lst_1",
          listingId: "lst_1",
          version: 2,
          status: "published",
          resourceUri: "chase-sets://marketplace/acct_1/listings/lst_1",
        }),
      ).toEqual([]);
    }
    for (const toolName of [
      "marketplace.submit-offer",
      "marketplace.update-offer-price",
      "marketplace.counter-offer",
      "marketplace.accept-offer",
      "marketplace.decline-offer",
    ]) {
      expect(
        validateOutputSchema(findMcpTool(toolName)?.outputSchema, {
          accountId: "acct_1",
          id: "off_1",
          offerId: "off_1",
          version: 2,
          status: "accepted",
          resourceUri: "chase-sets://marketplace/acct_1/offers/off_1",
        }),
      ).toEqual([]);
    }
    expect(
      validateOutputSchema(findMcpTool("marketplace.list-offers")?.outputSchema, {
        accountId: "acct_1",
        side: "submitted",
        items: [
          {
            offer_id: "off_1",
            buyer_account_id: "acct_1",
            product_id: "cat_1::condition:near-mint",
            price_amount: "20.00",
            quantity_requested: 1,
            status: "submitted",
          },
        ],
        total: 1,
        count: 1,
      }),
    ).toEqual([]);
    expect(
      validateOutputSchema(findMcpTool("marketplace.get-seller-attention-queue")?.outputSchema, {
        items: [
          {
            id: "listing-action:lst_1",
            source: "listing-action",
            entity: "listing",
            severity: "info",
            summary: { code: "listing-needs-action", params: { action: "paused" } },
            deepLink: { surface: "listing", href: "/account/desk/listings/lst_1" },
            dueAt: null,
            observedAt: "2026-07-15T00:00:00.000Z",
          },
        ],
        rollup: { total: 1, bySeverity: { critical: 0, warning: 0, info: 1 }, bySource: {} },
        sources: [{ id: "listing-action", status: "available", itemCount: 1 }],
        degraded: false,
      }),
    ).toEqual([]);
    expect(
      validateOutputSchema(findMcpTool("settlement.get-wallet")?.outputSchema, {
        accountId: "acct_1",
        wallet: {
          account_id: "acct_1",
          currency_code: "usd",
          pending_balance_amount: "10.00",
          available_balance_amount: "25.00",
        },
      }),
    ).toEqual([]);
    expect(
      validateOutputSchema(findMcpTool("settlement.list-ledger-entries")?.outputSchema, {
        accountId: "acct_1",
        items: [
          {
            ledger_entry_id: "led_1",
            account_id: "acct_1",
            kind: "sale-proceeds",
            direction: "credit",
            amount: "25.00",
            currency_code: "usd",
            funds_status: "available",
          },
        ],
        total: 1,
        count: 1,
      }),
    ).toEqual([]);
    const settlementPayout = {
      payout_id: "pyo_1",
      account_id: "acct_1",
      amount: "25.00",
      currency_code: "usd",
      status: "in-transit",
      requested_at: "2026-07-08T00:00:00.000Z",
      updated_at: "2026-07-08T00:00:00.000Z",
    };
    expect(
      validateOutputSchema(findMcpTool("settlement.list-payouts")?.outputSchema, {
        accountId: "acct_1",
        items: [settlementPayout],
        total: 1,
        count: 1,
        completeness: { kind: "complete", total: 1 },
        next_payout: null,
        blocked_payouts: [],
        availability: {
          can_request: false,
          unavailable_reasons: ["payout-request-permission-required"],
          unavailable_reason_details: [
            { code: "payout-request-permission-required", message: "Request permission is required." },
          ],
        },
      }),
    ).toEqual([]);
    expect(
      validateOutputSchema(findMcpTool("settlement.get-payout")?.outputSchema, {
        accountId: "acct_1",
        payout: settlementPayout,
      }),
    ).toEqual([]);
    expect(
      validateOutputSchema(findMcpTool("settlement.request-payout")?.outputSchema, {
        accountId: "acct_1",
        id: "pyo_1",
        payoutId: "pyo_1",
        version: 2,
        status: "in-transit",
        resourceUri: "chase-sets://settlement/acct_1/payouts/pyo_1",
        payout: settlementPayout,
      }),
    ).toEqual([]);
    const settlementReadiness = {
      account_id: "acct_1",
      status: "pending",
      missing_requirements: ["provider-onboarding"],
      onboarding_status: "pending",
      updated_at: "2026-07-08T00:00:00.000Z",
    };
    expect(
      validateOutputSchema(findMcpTool("settlement.refresh-readiness")?.outputSchema, {
        accountId: "acct_1",
        id: "acct_1",
        status: "pending",
        readiness: settlementReadiness,
        resourceUri: "chase-sets://settlement/acct_1/wallet",
      }),
    ).toEqual([]);
    expect(
      validateOutputSchema(findMcpTool("settlement.create-payout-onboarding-link")?.outputSchema, {
        accountId: "acct_1",
        id: "acct_provider_1",
        providerReference: "acct_provider_1",
        status: "pending",
        url: "https://connect.stripe.test/setup/acct_provider_1",
        readiness: settlementReadiness,
      }),
    ).toEqual([]);
    expect(
      validateOutputSchema(findMcpTool("payments.start-payment-method-setup")?.outputSchema, {
        accountId: "acct_1",
        id: "scs_1",
        setupReferenceId: "scs_1",
        status: "requires-action",
        url: "https://checkout.stripe.test/setup/scs_1",
        consentText: "Save this card for future purchases.",
      }),
    ).toEqual([]);
    expect(
      validateOutputSchema(findMcpTool("payments.confirm-payment-method-setup")?.outputSchema, {
        accountId: "acct_1",
        setupReferenceId: "scs_1",
        attached: true,
        status: "attached",
        paymentMethod: {
          instrumentId: "sci_1",
          displayLabel: "Visa ····4242",
          paymentMethodCategory: "card",
          isDefault: true,
          readiness: "ready",
        },
      }),
    ).toEqual([]);
  });

  it("requires confirmation and idempotency for sensitive and destructive tools", () => {
    const writeTools = flattenMcpTools().filter((tool) => tool.risk !== "read");

    expect(writeTools.length).toBeGreaterThan(0);
    expect(
      writeTools.every(
        (tool) =>
          tool.guardrails.confirmation.required &&
          tool.guardrails.idempotencyKey === "required" &&
          tool.permissionBoundary.requiredPermissions.length > 0,
      ),
    ).toBe(true);
  });

  it("classifies PII and financial write inputs as sensitive for redaction", () => {
    expect(findMcpTool("identity.create-invitation")?.audit.sensitiveInputFields).toEqual([
      "confirmationText",
      "email",
      "idempotencyKey",
    ]);
    expect(findMcpTool("payments.request-refund")?.audit.sensitiveInputFields).toEqual([
      "amount",
      "confirmationText",
      "reason",
      "idempotencyKey",
    ]);
    expect(findMcpTool("settlement.request-payout")?.audit.sensitiveInputFields).toEqual([
      "amount",
      "confirmationText",
      "reason",
      "idempotencyKey",
    ]);
    expect(findMcpTool("fulfillment.void-label")?.audit.sensitiveInputFields).toEqual([
      "confirmationText",
      "reason",
      "idempotencyKey",
    ]);
  });
});

describe("MCP tool authorization", () => {
  it("allows a read tool when the actor has the required permission", () => {
    const tool = findMcpTool("inventory.list-items");

    expect(tool).not.toBeNull();
    expect(authorizeMcpToolInvocation(tool!, accountActor)).toEqual({
      allowed: true,
    });
  });

  it("rejects missing permissions", () => {
    const tool = findMcpTool("marketplace.accept-offer");

    expect(tool).not.toBeNull();
    expect(
      authorizeMcpToolInvocation(tool!, {
        actorId: "actor_2",
        accountId: "acct_1",
        permissions: ["offers.view"],
      }),
    ).toEqual({
      allowed: false,
      reason: "Missing required permission: offers.manage, listings.view.",
    });
  });

  it("rejects sensitive tools without confirmation", () => {
    const tool = findMcpTool("settlement.request-payout");

    expect(tool).not.toBeNull();
    expect(authorizeMcpToolInvocation(tool!, accountActor)).toEqual({
      allowed: false,
      reason: "Confirmation is required for this MCP tool.",
    });
  });

  it.each([
    {
      toolName: "settlement.request-payout",
      expectedValue: "Request Payout.",
      input: {
        accountId: "acct_1",
        amount: "25.00",
        reason: "Seller requested payout.",
        idempotencyKey: "idem_payout_1",
      },
    },
    {
      toolName: "fulfillment.void-label",
      expectedValue: "Void Label.",
      input: {
        accountId: "acct_1",
        shipmentId: "ship_1",
        reason: "Unused label should be voided.",
        idempotencyKey: "idem_void_1",
      },
    },
  ])("requires $toolName confirmation text to match the expected value", ({ toolName, expectedValue, input }) => {
    const tool = findMcpTool(toolName);

    expect(tool).not.toBeNull();
    expect(getMcpToolConfirmationExpectedValue(tool!)).toBe(expectedValue);

    expect(
      authorizeMcpToolInvocation(
        tool!,
        accountActor,
        {
          confirmed: true,
          text: null,
        },
        input,
      ),
    ).toEqual({
      allowed: false,
      reason: "Confirmation text is required for this MCP tool.",
    });

    expect(
      authorizeMcpToolInvocation(
        tool!,
        accountActor,
        {
          confirmed: true,
          text: "Confirmed by policy.",
        },
        {
          ...input,
          confirmationText: "Confirmed by policy.",
        },
      ),
    ).toEqual({
      allowed: false,
      reason: `Confirmation text must exactly match '${expectedValue}'.`,
    });

    expect(
      authorizeMcpToolInvocation(
        tool!,
        accountActor,
        {
          confirmed: true,
          text: expectedValue,
        },
        {
          ...input,
          confirmationText: expectedValue,
        },
      ),
    ).toEqual({
      allowed: true,
    });
  });

  it("rejects account-scoped tools when the actor lacks an account scope", () => {
    const tool = findMcpTool("checkout.get-cart");

    expect(tool).not.toBeNull();
    expect(
      authorizeMcpToolInvocation(tool!, {
        actorId: "actor_3",
        accountId: null,
        permissions: ["orders.view"],
      }),
    ).toEqual({
      allowed: false,
      reason: "An account-scoped actor is required.",
    });
  });

  it("reports invalid catalogs for missing services and unguarded writes", () => {
    const invalidCatalog: readonly McpServiceDescriptor[] = [
      {
        serviceId: "inventory",
        serviceName: "Inventory",
        kind: "bounded-context",
        owner: "bounded-contexts/inventory",
        serviceBoundary: "Invalid test descriptor.",
        tools: [
          {
            name: "inventory.adjust-item",
            title: "Adjust Item",
            description: "Invalid test tool.",
            serviceId: "inventory",
            risk: "sensitive",
            inputSchema: {
              type: "object",
              additionalProperties: false,
              properties: {},
            },
            permissionBoundary: {
              scope: "account",
              requiredPermissions: [],
              accountScoped: true,
              auditPrincipal: "actor",
            },
            guardrails: {
              confirmation: {
                required: false,
              },
              idempotencyKey: "recommended",
              dryRunSupported: false,
              notes: [],
            },
            audit: {
              eventName: "mcp.inventory.adjust-item",
              targetType: "inventory-item",
              sensitiveInputFields: [],
            },
            expectedUsage: ["Invalid test usage."],
          },
        ],
        resources: [],
      },
    ];

    expect(validateMcpServiceCatalog(invalidCatalog, ["inventory", "payments"])).toEqual([
      "Missing MCP service descriptor for 'payments'.",
      "inventory.adjust-item must declare at least one required permission.",
      "inventory.adjust-item must require confirmation.",
      "inventory.adjust-item must require an idempotency key.",
    ]);
  });

  it("issue-7171-key-hash-and-mcp-boundary marks every Fulfillment writer owner-authoritative and redacted", () => {
    const tools = flattenMcpTools().filter((tool) => tool.serviceId === "fulfillment" && tool.risk !== "read");
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.guardrails.idempotencyAuthority).toBe("owner");
      expect(tool.guardrails.idempotencyKey).toBe("required");
      expect(tool.audit.sensitiveInputFields).toContain("idempotencyKey");
    }
  });
});

const inputBoundTool: McpToolDescriptor = {
  name: "platform-operations.apply-plan",
  title: "Apply Plan",
  description: "Apply one reviewed plan.",
  serviceId: "platform-operations",
  risk: "sensitive",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["planFingerprint", "idempotencyKey"],
    properties: {
      planFingerprint: { type: "string", description: "Fingerprint of the reviewed plan." },
      idempotencyKey: { type: "string", description: "Idempotency key." },
    },
  },
  permissionBoundary: {
    scope: "operator",
    requiredPermissions: ["catalog.manage"],
    requiredScopes: [],
    accountScoped: false,
    auditPrincipal: "actor",
  },
  guardrails: {
    confirmation: { required: true, prompt: "Confirm the plan fingerprint.", matchInputValue: "planFingerprint" },
    idempotencyKey: "required",
    idempotencyAuthority: "platform",
    dryRunSupported: false,
    notes: [],
  },
  audit: { eventName: "mcp.platform-operations.apply-plan", targetType: "plan", sensitiveInputFields: [] },
  expectedUsage: ["Use after reviewing the plan."],
};

const operatorActor: McpActor = { actorId: "usr_op", accountId: "acc_op", permissions: ["catalog.manage"] };

function catalogWith(tool: McpToolDescriptor): readonly McpServiceDescriptor[] {
  return [
    {
      serviceId: "platform-operations",
      serviceName: "Platform Operations",
      kind: "bounded-context",
      owner: "bounded-contexts/platform-operations",
      serviceBoundary: "Synthetic operator service.",
      tools: [tool],
      resources: [],
    },
  ];
}

describe("MCP input-bound confirmation", () => {
  const input = { planFingerprint: "plan-7f3a", idempotencyKey: "idem_1" };

  it("accepts confirmation text equal to the bound input value", () => {
    expect(
      authorizeMcpToolInvocation(inputBoundTool, operatorActor, { confirmed: true, text: "plan-7f3a" }, input),
    ).toEqual({ allowed: true });
    expect(getMcpToolConfirmationExpectedValue(inputBoundTool)).toBeNull();
  });

  it.each([
    { label: "a mismatched value", text: "plan-0000" },
    { label: "the tool title", text: "Apply Plan." },
    { label: "a whitespace-padded value", text: " plan-7f3a" },
    { label: "no confirmation text", text: null },
  ])("rejects $label", ({ text }) => {
    expect(authorizeMcpToolInvocation(inputBoundTool, operatorActor, { confirmed: true, text }, input)).toEqual({
      allowed: false,
      reason: "Confirmation text must exactly match the 'planFingerprint' input value.",
    });
  });

  it.each([
    { label: "missing", value: undefined },
    { label: "empty", value: "" },
    { label: "blank", value: "   " },
    { label: "non-string", value: 7 },
  ])("rejects a $label bound input even when the text matches it", ({ value }) => {
    expect(
      authorizeMcpToolInvocation(
        inputBoundTool,
        operatorActor,
        { confirmed: true, text: typeof value === "string" ? value : "" },
        { idempotencyKey: "idem_1", ...(value === undefined ? {} : { planFingerprint: value }) },
      ),
    ).toEqual({ allowed: false, reason: "Confirmation input field 'planFingerprint' is required for this MCP tool." });
  });

  it("still requires confirmed: true", () => {
    expect(
      authorizeMcpToolInvocation(inputBoundTool, operatorActor, { confirmed: false, text: "plan-7f3a" }, input),
    ).toEqual({ allowed: false, reason: "Confirmation is required for this MCP tool." });
  });

  it("leaves title-bound tools unchanged", () => {
    const tool = findMcpTool("settlement.request-payout")!;
    expect(tool.guardrails.confirmation.matchInputValue).toBeUndefined();
    expect(getMcpToolConfirmationExpectedValue(tool)).toBe("Request Payout.");
    // Operator adopters are held to the catalog-validation rule below; only non-operator tools stay title-bound.
    const nonOperatorInputBoundToolNames = (services: readonly McpServiceDescriptor[] = mcpServiceCatalog) =>
      flattenMcpTools(services)
        .filter(
          (candidate) =>
            candidate.permissionBoundary.scope !== "operator" && candidate.guardrails.confirmation.matchInputValue,
        )
        .map((candidate) => candidate.name);
    expect(nonOperatorInputBoundToolNames()).toEqual([]);
    expect(nonOperatorInputBoundToolNames(catalogWith(inputBoundTool))).toEqual([]);
    expect(
      nonOperatorInputBoundToolNames(
        catalogWith({
          ...inputBoundTool,
          permissionBoundary: { ...inputBoundTool.permissionBoundary, scope: "account", accountScoped: true },
        }),
      ),
    ).toEqual([inputBoundTool.name]);
  });

  it("rejects a tool that sets both confirmation modes or binds a field that is not a required string input", () => {
    const both = {
      ...inputBoundTool,
      guardrails: {
        ...inputBoundTool.guardrails,
        confirmation: { ...inputBoundTool.guardrails.confirmation, matchInputField: "planFingerprint" },
      },
    };
    const unknownField = {
      ...inputBoundTool,
      guardrails: {
        ...inputBoundTool.guardrails,
        confirmation: { ...inputBoundTool.guardrails.confirmation, matchInputValue: "missing" },
      },
    };
    const optionalField = {
      ...inputBoundTool,
      inputSchema: { ...inputBoundTool.inputSchema, required: ["idempotencyKey"] },
    };
    const nonStringField = {
      ...inputBoundTool,
      inputSchema: {
        ...inputBoundTool.inputSchema,
        properties: {
          ...inputBoundTool.inputSchema.properties,
          planFingerprint: { type: "integer" as const, description: "Numeric fingerprint." },
        },
      },
    };

    expect(validateMcpServiceCatalog(catalogWith(inputBoundTool), ["platform-operations"])).toEqual([]);
    expect(validateMcpServiceCatalog(catalogWith(both), ["platform-operations"])).toEqual([
      "platform-operations.apply-plan cannot set both confirmation matchInputField and matchInputValue.",
    ]);
    for (const tool of [unknownField, optionalField, nonStringField]) {
      expect(validateMcpServiceCatalog(catalogWith(tool), ["platform-operations"])).toEqual([
        `platform-operations.apply-plan confirmation matchInputValue '${tool.guardrails.confirmation.matchInputValue}' must name a required string input.`,
      ]);
    }
  });
});

describe("MCP operator capability registry", () => {
  it("gives every cataloged operator capability empty required scopes", () => {
    const operatorCapabilities = mcpServiceCatalog.flatMap((service) =>
      [...service.tools, ...service.resources].filter(
        (capability) => capability.permissionBoundary.scope === "operator",
      ),
    );
    expect(operatorCapabilities.length).toBeGreaterThan(0);
    for (const capability of operatorCapabilities) {
      expect(capability.permissionBoundary.requiredScopes).toEqual([]);
    }
  });

  it("rejects an operator tool or resource that declares required scopes (rule 2a)", () => {
    const scopedTool = {
      ...inputBoundTool,
      permissionBoundary: { ...inputBoundTool.permissionBoundary, requiredScopes: ["listings:write" as const] },
    };
    const [service] = catalogWith(inputBoundTool);
    const scopedResource = {
      ...service!,
      resources: [
        {
          uriTemplate: "chase-sets://platform-operations/plans",
          title: "Plans",
          description: "Synthetic operator resource.",
          serviceId: "platform-operations",
          permissionBoundary: { ...inputBoundTool.permissionBoundary, requiredScopes: ["catalog:read" as const] },
          expectedUsage: ["Synthetic."],
        },
      ],
    };

    expect(validateMcpServiceCatalog(catalogWith(scopedTool), ["platform-operations"])).toEqual([
      "platform-operations.apply-plan is an operator capability and must declare requiredScopes: [].",
    ]);
    expect(validateMcpServiceCatalog([scopedResource], ["platform-operations"])).toEqual([
      "chase-sets://platform-operations/plans is an operator capability and must declare requiredScopes: [].",
    ]);
  });
});

describe("isOperatorToolAllowed", () => {
  const readTool = { ...inputBoundTool, risk: "read" as const };
  const writeTool = inputBoundTool;
  const granted = {
    kind: "granted",
    membershipId: "mem_op",
    roleKey: "platform-admin",
    rolePermissions: ["catalog.manage"],
  } as const;
  const grantActor = (scopes: readonly AgentOAuthScope[]): McpActor => ({
    ...operatorActor,
    permissions: [],
    agentGrant: {
      grantId: "lpa_op",
      platformProfileUrl: "https://agent.example/.well-known/ucp",
      scopes,
      rolePermissions: ["catalog.manage"],
    },
  });

  it.each([
    { label: "session actor, read tool", actor: operatorActor, tool: readTool, allowed: true },
    { label: "session actor, write tool", actor: operatorActor, tool: writeTool, allowed: true },
    {
      label: "operations:read grant, read tool",
      actor: grantActor(["operations:read"]),
      tool: readTool,
      allowed: true,
    },
    {
      label: "operations:read grant, write tool",
      actor: grantActor(["operations:read"]),
      tool: writeTool,
      allowed: false,
    },
    {
      label: "operations:write grant, read tool",
      actor: grantActor(["operations:write"]),
      tool: readTool,
      allowed: true,
    },
    {
      label: "operations:write grant, write tool",
      actor: grantActor(["operations:write"]),
      tool: writeTool,
      allowed: true,
    },
    {
      label: "commerce-only grant, read tool",
      actor: grantActor(["catalog:read", "listings:write"]),
      tool: readTool,
      allowed: false,
    },
    { label: "no actor", actor: null, tool: readTool, allowed: false },
  ])("$label: allowed=$allowed with a granted authority", async ({ actor, tool, allowed }) => {
    const admission = await isOperatorToolAllowed(tool, actor, async () => granted);
    expect(admission.allowed).toBe(allowed);
  });

  it.each(["no-membership", "inactive", "not-platform-admin", "membership-mismatch", "authority-unavailable"] as const)(
    "denies a %s authority for every actor",
    async (reason) => {
      for (const actor of [operatorActor, grantActor(["operations:write"])]) {
        await expect(isOperatorToolAllowed(readTool, actor, async () => ({ kind: "denied", reason }))).resolves.toEqual(
          { allowed: false, reason: `operator-authority-${reason}` },
        );
      }
    },
  );

  it("denies when the authority's role permissions lack the tool's required permission", async () => {
    await expect(
      isOperatorToolAllowed(readTool, operatorActor, async () => ({ ...granted, rolePermissions: ["catalog.view"] })),
    ).resolves.toEqual({ allowed: false, reason: "operator-role-permission-missing" });
  });

  it("checks the grant's scopes before reading the authority and names no scope in the reason", async () => {
    let reads = 0;
    const admission = await isOperatorToolAllowed(
      writeTool,
      grantActor(["operations:read", "catalog:read"]),
      async () => {
        reads += 1;
        return granted;
      },
    );
    expect(admission).toEqual({ allowed: false, reason: "operator-grant-scope-missing" });
    expect(reads).toBe(0);
  });
});
