import { describe, expect, it } from "vitest";

import {
  flattenMcpTools,
  validateMcpServiceCatalog,
  type McpJsonSchema,
  type McpJsonSchemaProperty,
  type McpServiceDescriptor,
  type McpToolDescriptor,
} from "@chase-sets/platform-runtime/mcp-contracts";
import {
  guardrails,
  idempotencyKeyProperty,
  nullableProperty,
  objectSchema,
  stringProperty,
  writeTool,
} from "@chase-sets/platform-runtime/mcp-contracts/builders";

describe("nullable MCP input schema vocabulary", () => {
  it("publishes standard JSON Schema [<T>, null] for every primitive", () => {
    const nested = {
      kind: stringProperty("Reference kind.", ["support-request"]),
      supportRequestId: stringProperty("Support request identifier."),
    };

    expect(
      [
        nullableProperty({ type: "string", description: "Optional note." }),
        nullableProperty({ type: "number", description: "Declared-value threshold." }),
        nullableProperty({ type: "integer", description: "Optional count." }),
        nullableProperty({ type: "boolean", description: "Optional flag." }),
        nullableProperty({
          type: "object",
          description: "Optional reference.",
          additionalProperties: false,
          required: ["kind", "supportRequestId"],
          properties: nested,
        }),
        nullableProperty({ type: "array", description: "Optional tags.", items: stringProperty("Tag.") }),
      ].map((property) => JSON.stringify(property)),
    ).toEqual([
      '{"type":["string","null"],"description":"Optional note."}',
      '{"type":["number","null"],"description":"Declared-value threshold."}',
      '{"type":["integer","null"],"description":"Optional count."}',
      '{"type":["boolean","null"],"description":"Optional flag."}',
      `{"type":["object","null"],"description":"Optional reference.","additionalProperties":false,"required":["kind","supportRequestId"],"properties":${JSON.stringify(nested)}}`,
      '{"type":["array","null"],"description":"Optional tags.","items":{"type":"string","description":"Tag."}}',
    ]);
  });

  it("authors the tuple only through nullableProperty", () => {
    // @ts-expect-error A hand-written tuple lacks the builder brand.
    const handWritten: McpJsonSchemaProperty = { type: ["string", "null"], description: "Note." };
    // @ts-expect-error enum is excluded: a JSON Schema client would refuse the null the server accepts.
    nullableProperty({ type: "string", description: "Mode.", enum: ["a"] });
    // @ts-expect-error An already nullable property cannot be wrapped again.
    nullableProperty(nullableProperty({ type: "string", description: "Note." }));

    expect(handWritten.type).toEqual(["string", "null"]);
  });

  it("is adopted only by the exact nullable inputs", () => {
    const nullablePaths = flattenMcpTools().flatMap((tool) => [
      ...nullableSchemaPaths(tool.inputSchema, `${tool.name}.input`),
      ...(tool.outputSchema ? nullableSchemaPaths(tool.outputSchema, `${tool.name}.output`) : []),
    ]);

    expect(nullablePaths.sort()).toEqual([
      "identity.close-account.input.reference",
      "identity.reactivate-account.input.reference",
      "identity.suspend-account.input.reference",
      "ordering.clone-postage-policy.input.effectiveUntil",
      "ordering.create-postage-policy.input.effectiveUntil",
      "ordering.create-postage-policy.input.insuranceRequiredDeclaredValueAmount",
      "ordering.create-postage-policy.input.signatureRequiredDeclaredValueAmount",
      "ordering.preview-postage-policy.input.policy.insuranceRequiredDeclaredValueAmount",
      "ordering.preview-postage-policy.input.policy.signatureRequiredDeclaredValueAmount",
      "ordering.revise-postage-policy.input.effectiveUntil",
      "ordering.revise-postage-policy.input.insuranceRequiredDeclaredValueAmount",
      "ordering.revise-postage-policy.input.signatureRequiredDeclaredValueAmount",
      "settlement.list-payouts.output.next_payout",
    ]);
  });
});

describe("nullable confirmation bindings", () => {
  const titleBound = writeTool(
    "synthetic",
    "apply-thing",
    "Apply Thing",
    "Synthetic title-bound write tool.",
    "inventory.manage",
    objectSchema(
      {
        reason: stringProperty("Business reason for the action."),
        idempotencyKey: idempotencyKeyProperty(),
        confirmationText: stringProperty("Exact user or policy confirmation text."),
        note: nullableProperty({ type: "string", description: "Optional note." }),
      },
      ["reason", "idempotencyKey", "confirmationText", "note"],
    ),
    "thing",
    ["Synthetic write."],
  );

  const inputBound: McpToolDescriptor = {
    ...titleBound,
    name: "synthetic.apply-plan",
    title: "Apply Plan",
    inputSchema: objectSchema(
      {
        planFingerprint: stringProperty("Reviewed plan fingerprint."),
        idempotencyKey: idempotencyKeyProperty(),
      },
      ["planFingerprint", "idempotencyKey"],
    ),
    guardrails: guardrails("sensitive", {
      confirmation: { required: true, prompt: "Confirm the plan fingerprint.", matchInputValue: "planFingerprint" },
    }),
  };

  const validate = (...tools: McpToolDescriptor[]) => {
    const service: McpServiceDescriptor = {
      serviceId: "synthetic",
      serviceName: "Synthetic",
      kind: "infrastructure",
      owner: "infrastructure/platform-runtime",
      serviceBoundary: "Synthetic nullable confirmation-binding catalog.",
      tools,
      resources: [],
    };
    return validateMcpServiceCatalog([service], ["synthetic"]);
  };

  const withNullable = (tool: McpToolDescriptor, field: string): McpToolDescriptor => ({
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...tool.inputSchema.properties,
        [field]: nullableProperty({ type: "string", description: `Nullable ${field}.` }),
      },
    },
  });

  it("accepts nullable inputs that no confirmation binds", () => {
    expect(validate(titleBound, inputBound)).toEqual([]);
  });

  it("rejects a nullable property named by matchInputField", () => {
    expect(validate(withNullable(titleBound, "confirmationText"))).toEqual([
      "synthetic.apply-thing confirmation input 'confirmationText' cannot be nullable.",
    ]);
  });

  it("rejects a nullable property named by matchInputValue", () => {
    expect(validate(withNullable(inputBound, "planFingerprint"))).toEqual([
      "synthetic.apply-plan confirmation input 'planFingerprint' cannot be nullable.",
    ]);
  });
});

function nullableSchemaPaths(schema: Pick<McpJsonSchema, "properties">, path: string): string[] {
  return Object.entries(schema.properties).flatMap(([field, property]) => propertyPaths(property, `${path}.${field}`));
}

function propertyPaths(property: McpJsonSchemaProperty, path: string): string[] {
  return [
    ...(typeof property.type === "string" ? [] : [path]),
    ...(property.items ? propertyPaths(property.items, `${path}[]`) : []),
    ...(property.properties ? nullableSchemaPaths({ properties: property.properties }, path) : []),
  ];
}
