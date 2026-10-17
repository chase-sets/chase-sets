import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { createMcpRoutes, type McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { orderingService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/ordering";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { PostagePolicy } from "@chase-sets/product-measures";
import { createOrderingPostagePolicyMcpHandlers } from "./mcp";
import type { PostagePolicyServices } from "./runtime";

const policyId = createId("opp");
const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "platform-admin",
  permissions: ["postage-policies.view", "postage-policies.manage"],
} satisfies ResolvedActor;

const protocol = {
  protocolVersion: "2025-06-18",
  stateless: false,
  clientInfo: null,
  clientCapabilities: null,
} satisfies McpRequestProtocolContext;

function request(arguments_: Record<string, unknown>, requestActor: ResolvedActor | null = actor) {
  return {
    actor: requestActor,
    tool: null as never,
    arguments: arguments_,
    request: new Request("https://api.test/mcp"),
    protocol,
  };
}

const payload: Partial<PostagePolicy> = {
  policyVersion: "v1",
  maxLetterUnits: 1,
  maxLetterWeightOunces: 1,
  maxLetterThicknessInches: 0.25,
  maxLetterDeclaredValueAmount: 20,
  letterEnvelopeWeightOunces: 0.1,
  parcelPackagingWeightOunces: 2,
  parcelRequiredShippingOptions: [],
  letterRequiredPhysicalFlags: [],
  parcelRequiredPhysicalFlags: [],
  signatureRequiredShippingOptions: [],
  signatureRequiredDeclaredValueAmount: null,
  signatureRequiredPhysicalFlags: [],
  insuranceRequiredDeclaredValueAmount: null,
};

function services(): PostagePolicyServices {
  return {
    commandHandler: vi.fn(),
    createPolicy: vi.fn(async () => ({ policyId, version: 1 })),
    revisePolicy: vi.fn(async () => ({ policyId, version: 2 })),
    activatePolicy: vi.fn(async () => ({ policyId, version: 3 })),
    retirePolicy: vi.fn(async () => ({ policyId, version: 4 })),
    clonePolicy: vi.fn(async () => ({ policyId, version: 1 })),
    previewPolicy: vi.fn(() => ({ packagePlan: "preview" }) as never),
    listPolicies: vi.fn(async () => ({ items: [], total: 0 })),
    getPolicy: vi.fn(async () => ({ policy_id: policyId }) as never),
    getActivePolicy: vi.fn(async () => payload as PostagePolicy),
    projectors: [],
  } as unknown as PostagePolicyServices;
}

function native(fakeServices: PostagePolicyServices) {
  const app = new Hono<{ Variables: { actor: ResolvedActor } }>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route(
    "/",
    createMcpRoutes({
      services: [{ ...orderingService, tools: orderingService.tools.filter((tool) => tool.name.includes("postage")) }],
      ...createOrderingPostagePolicyMcpHandlers(fakeServices),
      operatorAuthority: async () => ({
        kind: "granted",
        membershipId: actor.membershipId,
        roleKey: actor.roleKey,
        rolePermissions: actor.permissions,
      }),
      allowInMemoryIdempotencyStoreForTests: true,
    }),
  );
  const call = async (name: string, arguments_: Record<string, unknown>) => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "request_1",
        method: "tools/call",
        params: { name, arguments: arguments_ },
      }),
    });
    return (await response.json()) as {
      result: { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
    };
  };
  return { app, call };
}

const createArguments = {
  label: "Synthetic policy",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  ...payload,
  idempotencyKey: "idem-native-create",
  confirmationText: "Create Postage Policy.",
  confirmed: true,
};

describe("ordering postage policy MCP handlers", () => {
  it("publishes every mapped tool once with its exact operator contract and guardrails", () => {
    const expectedNames = [
      "ordering.activate-postage-policy",
      "ordering.clone-postage-policy",
      "ordering.create-postage-policy",
      "ordering.get-postage-policy",
      "ordering.list-postage-policies",
      "ordering.preview-postage-policy",
      "ordering.retire-postage-policy",
      "ordering.revise-postage-policy",
    ];
    expect(Object.keys(createOrderingPostagePolicyMcpHandlers(services()).toolHandlers).sort()).toEqual(expectedNames);
    expect(
      orderingService.tools.filter((tool) => tool.name.includes("postage")).map((tool) => tool.name).sort(),
    ).toEqual(expectedNames);
    for (const tool of orderingService.tools.filter((entry) => entry.name.includes("postage"))) {
      expect(tool.availability).toBe("available");
      expect(tool.permissionBoundary).toMatchObject({
        scope: "operator",
        requiredScopes: [],
        accountScoped: false,
        auditPrincipal: "actor",
      });
      expect(tool.permissionBoundary.requiredPermissions).toEqual([
        tool.name === "ordering.list-postage-policies" || tool.name === "ordering.get-postage-policy"
          ? "postage-policies.view"
          : "postage-policies.manage",
      ]);
      expect(tool.guardrails.dryRunSupported).toBe(tool.risk !== "read");
      expect(tool.guardrails.confirmation.required).toBe(
        [
          "ordering.create-postage-policy",
          "ordering.revise-postage-policy",
          "ordering.activate-postage-policy",
          "ordering.retire-postage-policy",
          "ordering.clone-postage-policy",
        ].includes(tool.name),
      );
      expect(tool.guardrails.idempotencyKey).toBe(
        tool.guardrails.confirmation.required ? "required" : "not-applicable",
      );
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("exposes the named handlers, route keys, and every owning source call", async () => {
    const fakeServices = services();
    const handlers = createOrderingPostagePolicyMcpHandlers(fakeServices);
    const names = Object.keys(handlers.toolHandlers).sort();
    for (const omitted of names) expect(names.filter((name) => name !== omitted)).not.toEqual(names);
    await handlers.toolHandlers["ordering.list-postage-policies"]?.(request({ limit: 10, offset: 0 }));
    await handlers.toolHandlers["ordering.get-postage-policy"]?.(request({ id: policyId }));
    await handlers.toolHandlers["ordering.preview-postage-policy"]?.(
      request({
        policy: payload,
        shippingOption: "standard",
        itemSubtotalAmount: "10.00",
        quantity: 1,
        unitLengthInches: 3,
        unitWidthInches: 2,
        unitHeightInches: 0.1,
        unitWeightOunces: 1,
        physicalFlags: ["raw-card"],
      }),
    );
    await handlers.toolHandlers["ordering.create-postage-policy"]?.(request(createArguments));
    await handlers.toolHandlers["ordering.revise-postage-policy"]?.(request({ id: policyId, ...createArguments }));
    await handlers.toolHandlers["ordering.activate-postage-policy"]?.(
      request({ id: policyId, activationReason: "publish" }),
    );
    await handlers.toolHandlers["ordering.retire-postage-policy"]?.(request({ id: policyId, retirementReason: "replace" }));
    await handlers.toolHandlers["ordering.clone-postage-policy"]?.(
      request({ id: policyId, label: "Clone", effectiveFrom: createArguments.effectiveFrom }),
    );
    expect(fakeServices.listPolicies).toHaveBeenCalledOnce();
    expect(fakeServices.getPolicy).toHaveBeenCalled();
    expect(fakeServices.previewPolicy).toHaveBeenCalledOnce();
    expect(fakeServices.createPolicy).toHaveBeenCalledOnce();
    expect(fakeServices.revisePolicy).toHaveBeenCalledOnce();
    expect(fakeServices.activatePolicy).toHaveBeenCalledOnce();
    expect(fakeServices.retirePolicy).toHaveBeenCalledOnce();
    expect(fakeServices.clonePolicy).toHaveBeenCalledOnce();
  });

  it("rejects confirmation, target, input, permission and replay bypass mutants before effects", async () => {
    const fakeServices = services();
    const boundary = native(fakeServices);
    const invalidInputs = [
      { ...createArguments, confirmed: false, idempotencyKey: "bad-confirmed" },
      { ...createArguments, confirmationText: "Wrong title.", idempotencyKey: "bad-title" },
      { ...createArguments, idempotencyKey: "", confirmationText: "Create Postage Policy." },
      { ...createArguments, maxLetterUnits: "not-a-number", idempotencyKey: "bad-input" },
      { ...createArguments, id: "opp_other", idempotencyKey: "bad-target" },
    ];
    for (const input of invalidInputs) {
      expect((await boundary.call("ordering.create-postage-policy", input)).result.isError).toBe(true);
    }
    expect(fakeServices.createPolicy).not.toHaveBeenCalled();
    const first = await boundary.call("ordering.create-postage-policy", createArguments);
    expect(first.result.isError).not.toBe(true);
    expect(await boundary.call("ordering.create-postage-policy", createArguments)).toEqual(first);
    expect(fakeServices.createPolicy).toHaveBeenCalledOnce();
  });

  it("MCP source-call contract coverage executes every mapped tool through the owning runtime", async () => {
    const fakeServices = services();
    const handlers = createOrderingPostagePolicyMcpHandlers(fakeServices);
    const commandArgs = {
      label: "Synthetic policy",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      ...payload,
      idempotencyKey: "idem-policy-1",
      confirmationText: "Create Postage Policy.",
      confirmed: true,
    };

    await handlers.toolHandlers["ordering.list-postage-policies"]?.(request({ limit: 10, offset: 0 }));
    await handlers.toolHandlers["ordering.get-postage-policy"]?.(request({ id: policyId }));
    await handlers.toolHandlers["ordering.preview-postage-policy"]?.(
      request({
        policy: payload,
        shippingOption: "standard",
        itemSubtotalAmount: "10.00",
        quantity: 1,
        unitLengthInches: 3,
        unitWidthInches: 2,
        unitHeightInches: 0.1,
        unitWeightOunces: 1,
        physicalFlags: ["raw-card"],
      }),
    );
    await handlers.toolHandlers["ordering.create-postage-policy"]?.(request(commandArgs));
    await handlers.toolHandlers["ordering.revise-postage-policy"]?.(request({ id: policyId, ...commandArgs }));
    await handlers.toolHandlers["ordering.activate-postage-policy"]?.(
      request({
        id: policyId,
        activationReason: "publish",
        idempotencyKey: "idem-activate",
        confirmationText: "Activate Postage Policy.",
      }),
    );
    await handlers.toolHandlers["ordering.retire-postage-policy"]?.(
      request({
        id: policyId,
        retirementReason: "replace",
        idempotencyKey: "idem-retire",
        confirmationText: "Retire Postage Policy.",
      }),
    );
    await handlers.toolHandlers["ordering.clone-postage-policy"]?.(
      request({
        id: policyId,
        label: "Clone",
        effectiveFrom: commandArgs.effectiveFrom,
        idempotencyKey: "idem-clone",
        confirmationText: "Clone Postage Policy.",
      }),
    );

    expect(fakeServices.listPolicies).toHaveBeenCalledWith({ limit: 10, offset: 0 });
    expect(fakeServices.getPolicy).toHaveBeenCalledWith(policyId);
    expect(fakeServices.previewPolicy).toHaveBeenCalledOnce();
    expect(fakeServices.createPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ createdByUserId: actor.userId }),
      expect.objectContaining({ audit: expect.objectContaining({ performedByUserId: actor.userId }) }),
    );
    expect(fakeServices.revisePolicy).toHaveBeenCalledWith(
      policyId,
      expect.objectContaining({ revisedByUserId: actor.userId }),
      expect.anything(),
    );
    expect(fakeServices.activatePolicy).toHaveBeenCalledOnce();
    expect(fakeServices.retirePolicy).toHaveBeenCalledOnce();
    expect(fakeServices.clonePolicy).toHaveBeenCalledOnce();
  });

  it("rejects an omitted conditional clone source before issuing a command", async () => {
    const fakeServices = { ...services(), getPolicy: vi.fn(async () => null) } as unknown as PostagePolicyServices;
    const handlers = createOrderingPostagePolicyMcpHandlers(fakeServices);

    await expect(
      handlers.toolHandlers["ordering.clone-postage-policy"]?.(
        request({
          id: policyId,
          label: "Clone",
          effectiveFrom: "2026-01-01T00:00:00.000Z",
          idempotencyKey: "idem-clone-missing",
          confirmed: true,
          confirmationText: "Clone Postage Policy.",
        }),
      ),
    ).rejects.toThrow("Postage policy not found.");
    expect(fakeServices.commandHandler).not.toHaveBeenCalled();
    expect(fakeServices.clonePolicy).not.toHaveBeenCalled();
  });

  it("preserves an active lifecycle status when revising an active policy", async () => {
    const fakeServices = {
      ...services(),
      getPolicy: vi.fn(async () => ({ status: "active" })),
    } as unknown as PostagePolicyServices;
    const handlers = createOrderingPostagePolicyMcpHandlers(fakeServices);

    const result = await handlers.toolHandlers["ordering.revise-postage-policy"]?.(
      request({
        id: policyId,
        label: "Revised",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        ...payload,
        idempotencyKey: "idem-revise-active",
        confirmed: true,
        confirmationText: "Revise Postage Policy.",
      }),
    );

    expect(result).toMatchObject({ status: "active" });
  });

  it("rejects unauthorised actors before reading or writing", async () => {
    const fakeServices = services();
    const handlers = createOrderingPostagePolicyMcpHandlers(fakeServices);
    await expect(
      handlers.toolHandlers["ordering.list-postage-policies"]?.(request({}, { ...actor, permissions: [] })),
    ).rejects.toThrow("Missing required permission: postage-policies.view.");
    await expect(handlers.toolHandlers["ordering.create-postage-policy"]?.(request({}, null))).rejects.toThrow(
      "Missing required permission: postage-policies.manage.",
    );
    expect(fakeServices.listPolicies).not.toHaveBeenCalled();
    expect(fakeServices.createPolicy).not.toHaveBeenCalled();
  });
});
