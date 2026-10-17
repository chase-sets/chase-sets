import { describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";
import type { McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
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

describe("ordering postage policy MCP handlers", () => {
  it("MCP source-call contract coverage executes every mapped tool through the owning runtime", async () => {
    const fakeServices = services();
    const handlers = createOrderingPostagePolicyMcpHandlers(fakeServices);
    const commandArgs = {
      label: "Synthetic policy",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      ...payload,
      idempotencyKey: "idem-policy-1",
      confirmationText: "Create Postage Policy.",
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
