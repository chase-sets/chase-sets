import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { OperatorAuthorityDecision } from "@chase-sets/auth-context";
import { createActorEventStoreContext, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { createMcpRoutes, type McpAuditRecord, type McpRequestProtocolContext } from "@chase-sets/platform-runtime/mcp";
import { orderingService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/ordering";
import type { McpToolDescriptor } from "@chase-sets/platform-runtime/mcp-contracts";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { PostagePolicy } from "@chase-sets/product-measures";
import { createOrderingPostagePolicyMcpHandlers } from "./mcp";
import { createPostagePolicyRuntime, type PostagePolicyServices } from "./runtime";
import { evolvePostagePolicy, initialPostagePolicyState, type PostagePolicyEvent } from "../domain/domain";

const manifest = JSON.parse(readFileSync(new URL("../../../context.json", import.meta.url), "utf8"));
const postageTools = orderingService.tools.filter((tool) => tool.name.includes("postage"));

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
  const state: { actor: ResolvedActor | null; authority: OperatorAuthorityDecision } = {
    actor,
    authority: {
      kind: "granted",
      membershipId: actor.membershipId,
      roleKey: "platform-admin",
      rolePermissions: actor.permissions,
    },
  };
  const audits: McpAuditRecord[] = [];
  const app = new Hono<{ Variables: { actor: ResolvedActor | null } }>();
  app.use("*", async (c, next) => {
    c.set("actor", state.actor);
    await next();
  });
  app.route(
    "/",
    createMcpRoutes({
      services: [{ ...orderingService, tools: postageTools, resources: [] }],
      ...createOrderingPostagePolicyMcpHandlers(fakeServices),
      operatorAuthority: async () => state.authority,
      allowInMemoryIdempotencyStoreForTests: true,
      audit: async (record) => {
        audits.push(record);
      },
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
      error?: unknown;
    };
  };
  return { app, call, state, audits };
}

function storedRuntime(projectedEventCount = Number.POSITIVE_INFINITY) {
  const { eventStore, allEvents } = createInMemoryEventStore();
  const db: PgQueryable = {
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      const states = new Map<string, typeof initialPostagePolicyState>();
      for (const event of allEvents.slice(0, projectedEventCount)) {
        const id = String(event.payload.policyId);
        states.set(
          id,
          evolvePostagePolicy(states.get(id) ?? initialPostagePolicyState, {
            type: event.eventType,
            data: event.payload,
          } as PostagePolicyEvent),
        );
      }
      let rows: unknown[] = [...states.values()].map((state) => ({
        policy_id: state.policyId,
        status: state.status,
        label: state.label,
        payload: state.payload,
        effective_from: state.effectiveFrom,
        effective_until: state.effectiveUntil,
      }));
      if (sql.includes("ordering_postage_policy_history")) rows = [];
      else if (sql.includes("WHERE policy_id = $1"))
        rows = rows.filter((row) => (row as { policy_id: string }).policy_id === values[0]);
      else if (sql.includes("WHERE status = 'active'"))
        rows = rows.filter((row) => (row as { status: string }).status === "active").slice(0, 1);
      else if (sql.includes("COUNT(*)")) rows = [{ count: String(rows.length) }];
      return { rows: rows as Row[], rowCount: rows.length };
    },
  };
  return {
    allEvents,
    runtime: createPostagePolicyRuntime({ eventStore, checkpointStore: { get: vi.fn(), set: vi.fn() } as never, db }),
  };
}

const createArguments = {
  label: "Synthetic policy",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  ...payload,
  idempotencyKey: "idem-native-create",
  confirmationText: "Create Postage Policy.",
  confirmed: true,
};

const writeFields = ["idempotencyKey", "confirmed", "confirmationText"];
const policyFields = ["label", "effectiveFrom", "effectiveUntil", ...Object.keys(payload)];
const inputFields: Record<string, string[]> = {
  "ordering.list-postage-policies": ["limit", "offset"],
  "ordering.get-postage-policy": ["id"],
  "ordering.preview-postage-policy": [
    "policy",
    "shippingOption",
    "itemSubtotalAmount",
    "quantity",
    "unitLengthInches",
    "unitWidthInches",
    "unitHeightInches",
    "unitWeightOunces",
    "physicalFlags",
  ],
  "ordering.create-postage-policy": [...policyFields, ...writeFields],
  "ordering.revise-postage-policy": ["id", ...policyFields, ...writeFields],
  "ordering.activate-postage-policy": ["id", "activationReason", ...writeFields],
  "ordering.retire-postage-policy": ["id", "retirementReason", ...writeFields],
  "ordering.clone-postage-policy": ["id", "label", "effectiveFrom", "effectiveUntil", ...writeFields],
};

function assertContract(tool: McpToolDescriptor) {
  const read = [
    "ordering.list-postage-policies",
    "ordering.get-postage-policy",
    "ordering.preview-postage-policy",
  ].includes(tool.name);
  expect(tool.risk).toBe(read ? "read" : tool.name === "ordering.retire-postage-policy" ? "destructive" : "sensitive");
  expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(inputFields[tool.name]!.slice().sort());
  expect(tool.inputSchema.additionalProperties).toBe(false);
  expect(tool.permissionBoundary).toEqual({
    scope: "operator",
    accountScoped: false,
    auditPrincipal: "actor",
    requiredScopes: [],
    requiredPermissions: [
      tool.name === "ordering.list-postage-policies" || tool.name === "ordering.get-postage-policy"
        ? "postage-policies.view"
        : "postage-policies.manage",
    ],
  });
  expect(tool.guardrails.confirmation.required).toBe(!read);
  expect(tool.guardrails.idempotencyKey).toBe(read ? "not-applicable" : "required");
  expect(tool.guardrails.idempotencyAuthority).toBe("platform");
  if (!read) {
    expect(tool.guardrails.confirmation.matchInputField).toBe("confirmationText");
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(writeFields));
  }
}

describe("ordering postage policy MCP handlers", () => {
  it("detects a bypass mutant for every schema, authority, confirmation and replay contract guard", () => {
    for (const tool of postageTools) assertContract(tool);
    const tool = postageTools.find((entry) => entry.name === "ordering.create-postage-policy")!;
    const mutants: McpToolDescriptor[] = [
      { ...tool, inputSchema: { ...tool.inputSchema, additionalProperties: true } },
      {
        ...tool,
        inputSchema: {
          ...tool.inputSchema,
          properties: {
            ...tool.inputSchema.properties,
            accountId: { type: "string", description: "Bypass target override." },
          },
        },
      },
      { ...tool, permissionBoundary: { ...tool.permissionBoundary, scope: "account" } },
      { ...tool, permissionBoundary: { ...tool.permissionBoundary, requiredPermissions: [] } },
      { ...tool, guardrails: { ...tool.guardrails, confirmation: { required: false } } },
      { ...tool, guardrails: { ...tool.guardrails, confirmation: { required: true } } },
      { ...tool, guardrails: { ...tool.guardrails, idempotencyKey: "not-applicable" } },
      { ...tool, guardrails: { ...tool.guardrails, idempotencyAuthority: "owner" } },
    ];
    for (const mutant of mutants) expect(() => assertContract(mutant)).toThrow();
  });

  it("keeps read confirmation-free snapshots, pagination, nullable inputs and source defaults", async () => {
    const fake = services();
    const boundary = native(fake);
    expect(
      (await boundary.call("ordering.list-postage-policies", { limit: 250, offset: 250 })).result.isError,
    ).not.toBe(true);
    expect(fake.listPolicies).toHaveBeenLastCalledWith({ limit: 250, offset: 250 });
    expect((await boundary.call("ordering.preview-postage-policy", { policy: payload })).result.isError).not.toBe(true);
    expect(fake.previewPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ quantity: 1, unitLengthInches: 3.5, physicalFlags: ["raw-card"] }),
    );
    expect(
      (await boundary.call("ordering.create-postage-policy", { ...createArguments, effectiveUntil: null })).result
        .isError,
    ).not.toBe(true);
    expect(fake.createPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveUntil: null,
        payload: expect.objectContaining({
          signatureRequiredDeclaredValueAmount: null,
          insuranceRequiredDeclaredValueAmount: null,
        }),
      }),
      expect.anything(),
    );
    const failed = native({
      ...fake,
      listPolicies: vi.fn(async () => {
        throw new Error("Synthetic query unavailable.");
      }),
    });
    const result = await failed.call("ordering.list-postage-policies", {});
    expect(result.result.isError).toBe(true);
    expect(failed.audits.at(-1)?.outcome).toBe("failed");
  });
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
      orderingService.tools
        .filter((tool) => tool.name.includes("postage"))
        .map((tool) => tool.name)
        .sort(),
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

  it("MCP source-call contract coverage", async () => {
    const fakeServices = services();
    const handlers = createOrderingPostagePolicyMcpHandlers(fakeServices);
    const names = Object.keys(handlers.toolHandlers).sort();
    const coverage = manifest.agentCoverage["ordering-postage-policies"].tools.slice().sort();
    const assertComplete = (available: string[]) => expect(available.slice().sort()).toEqual(coverage);
    assertComplete(names);
    for (const omitted of names) expect(() => assertComplete(names.filter((name) => name !== omitted))).toThrow();
    expect(manifest.agentCoverage["ordering-postage-policies-detail"].exempt).toBe("navigation-only");
    expect(
      manifest.mcpCapabilities.tools
        .filter((tool: { ownerSlice: string }) => tool.ownerSlice === "postage-policies")
        .map((tool: { name: string }) => tool.name)
        .sort(),
    ).toEqual(names);
    const source = readFileSync(new URL("../../../routes/admin/postage-policies.tsx", import.meta.url), "utf8");
    const calls = [...source.matchAll(/\.(\w+PostagePolic\w*)\(/g)].map((match) => match[1]).sort();
    expect(calls).toEqual(
      [
        "activatePostagePolicy",
        "clonePostagePolicy",
        "createPostagePolicy",
        "getPostagePolicy",
        "listPostagePolicies",
        "previewPostagePolicy",
        "retirePostagePolicy",
        "revisePostagePolicy",
      ].sort(),
    );
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
    await handlers.toolHandlers["ordering.retire-postage-policy"]?.(
      request({ id: policyId, retirementReason: "replace" }),
    );
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

  it("rejects confirmation, target and input bypasses before effects and deduplicates retries", async () => {
    const fakeServices = services();
    const boundary = native(fakeServices);
    const invalidInputs = [
      { ...createArguments, confirmed: false, idempotencyKey: "bad-confirmed" },
      { ...createArguments, confirmationText: "Wrong title.", idempotencyKey: "bad-title" },
      { ...createArguments, idempotencyKey: "", confirmationText: "Create Postage Policy." },
      { ...createArguments, maxLetterUnits: "not-a-number", idempotencyKey: "bad-input" },
      { ...createArguments, id: "opp_other", idempotencyKey: "bad-target" },
      { ...createArguments, accountId: "acc_other", idempotencyKey: "bad-account" },
      { ...createArguments, parcelRequiredShippingOptions: [42], idempotencyKey: "bad-nested" },
    ];
    for (const input of invalidInputs) {
      expect((await boundary.call("ordering.create-postage-policy", input)).result.isError).toBe(true);
    }
    expect(fakeServices.createPolicy).not.toHaveBeenCalled();
    const first = await boundary.call("ordering.create-postage-policy", createArguments);
    expect(first.result.isError).not.toBe(true);
    expect(await boundary.call("ordering.create-postage-policy", createArguments)).toEqual(first);
    expect(
      (await boundary.call("ordering.create-postage-policy", { ...createArguments, label: "Conflicting" })).result
        .isError,
    ).toBe(true);
    boundary.state.authority = { kind: "denied", reason: "inactive" };
    expect((await boundary.call("ordering.create-postage-policy", createArguments)).result.isError).toBe(true);
    expect(fakeServices.createPolicy).toHaveBeenCalledOnce();
    expect(boundary.audits.at(-1)).toMatchObject({ outcome: "denied", actorId: actor.userId });
  });

  it("denies absent actors, stale authority, insufficient permissions and commerce-only grants", async () => {
    const fake = services();
    const boundary = native(fake);
    boundary.state.actor = null;
    expect((await boundary.call("ordering.create-postage-policy", createArguments)).error).toBeDefined();
    boundary.state.actor = { ...actor, roleKey: "owner" };
    boundary.state.authority = { kind: "denied", reason: "not-platform-admin" };
    expect((await boundary.call("ordering.create-postage-policy", createArguments)).result.isError).toBe(true);
    boundary.state.authority = {
      kind: "granted",
      membershipId: actor.membershipId,
      roleKey: "platform-admin",
      rolePermissions: ["postage-policies.view"],
    };
    expect((await boundary.call("ordering.create-postage-policy", createArguments)).result.isError).toBe(true);
    boundary.state.actor = {
      ...actor,
      agentGrant: {
        grantId: "synthetic-commerce-grant",
        platformProfileUrl: "https://synthetic.invalid/profile",
        scopes: ["fulfillment:read"],
        rolePermissions: actor.permissions,
      },
    };
    const refused = await boundary.call("ordering.create-postage-policy", createArguments);
    expect(refused.result?.isError === true || refused.error !== undefined).toBe(true);
    expect(fake.createPolicy).not.toHaveBeenCalled();
  });

  it("persists operator attribution for every lifecycle write and preserves owning domain failures", async () => {
    const { allEvents, runtime } = storedRuntime();
    const boundary = native(runtime);
    const blankTimestamp = await boundary.call("ordering.create-postage-policy", {
      ...createArguments,
      effectiveFrom: "",
      idempotencyKey: "invalid-blank-timestamp",
    });
    expect(blankTimestamp.result.isError).toBe(true);
    expect(allEvents).toHaveLength(0);
    const created = await boundary.call("ordering.create-postage-policy", createArguments);
    expect(created.result.isError).not.toBe(true);
    const id = created.result.structuredContent!.policyId;
    expect(await boundary.call("ordering.create-postage-policy", createArguments)).toEqual(created);
    expect(allEvents).toHaveLength(1);
    for (const [name, args] of [
      ["revise", { ...createArguments, id, label: "Revised" }],
      ["activate", { id, activationReason: "publish" }],
      ["clone", { id, label: "Clone", effectiveFrom: createArguments.effectiveFrom, effectiveUntil: null }],
      ["retire", { id, retirementReason: "replace" }],
    ] as const) {
      const tool = postageTools.find((entry) => entry.name === `ordering.${name}-postage-policy`)!;
      const input = { ...args, confirmed: true, confirmationText: `${tool.title}.`, idempotencyKey: `stored-${name}` };
      const result = await boundary.call(tool.name, input);
      expect(result.result.isError, JSON.stringify(result)).not.toBe(true);
      const count = allEvents.length;
      expect(await boundary.call(tool.name, input)).toEqual(result);
      expect(allEvents).toHaveLength(count);
    }
    expect(allEvents).toHaveLength(5);
    for (const event of allEvents) {
      expect(event.performedByUserId).toBe(actor.userId);
      expect(event.forAccountId).toBe(actor.accountId);
      expect(Object.entries(event.payload).find(([key]) => key.endsWith("ByUserId"))?.[1]).toBe(actor.userId);
    }
    const invalid = await boundary.call("ordering.revise-postage-policy", {
      ...createArguments,
      id,
      idempotencyKey: "retired-revision",
      confirmationText: "Revise Postage Policy.",
    });
    expect(invalid.result.isError).toBe(true);
    expect(allEvents).toHaveLength(5);
    expect(boundary.audits.at(-1)?.outcome).toBe("failed");
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

  it("kills permission and conditional-source bypass mutants with the same effect oracle", async () => {
    const fake = { ...services(), getPolicy: vi.fn(async () => null) };
    const handlers = createOrderingPostagePolicyMcpHandlers(fake);
    const assertRefused = async (run: () => unknown) => {
      await expect(Promise.resolve().then(run)).rejects.toThrow();
      expect(fake.createPolicy).not.toHaveBeenCalled();
      expect(fake.clonePolicy).not.toHaveBeenCalled();
    };
    await assertRefused(() => handlers.toolHandlers["ordering.create-postage-policy"]!(request(createArguments, null)));
    await assertRefused(() =>
      handlers.toolHandlers["ordering.clone-postage-policy"]!(
        request({ id: policyId, label: "Clone", effectiveFrom: createArguments.effectiveFrom }),
      ),
    );
    const context = createActorEventStoreContext(actor);
    const permissionBypass = () =>
      fake.createPolicy(
        {
          label: createArguments.label,
          payload,
          effectiveFrom: createArguments.effectiveFrom,
          effectiveUntil: null,
          createdByUserId: actor.userId,
        },
        context,
      );
    await expect(assertRefused(permissionBypass)).rejects.toThrow();
    expect(fake.createPolicy).toHaveBeenCalledOnce();
    vi.mocked(fake.createPolicy).mockClear();
    const sourceBypass = () =>
      fake.clonePolicy(
        policyId,
        {
          label: "Clone",
          effectiveFrom: createArguments.effectiveFrom,
          effectiveUntil: null,
          createdByUserId: actor.userId,
        },
        context,
      );
    await expect(assertRefused(sourceBypass)).rejects.toThrow();
    expect(fake.clonePolicy).toHaveBeenCalledOnce();
  });

  it("returns a revise write result without consulting the lifecycle projection", async () => {
    const fakeServices = {
      ...services(),
      getPolicy: vi.fn(async () => null),
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

    expect(result).toMatchObject({ status: "revised" });
    expect(fakeServices.getPolicy).not.toHaveBeenCalled();
  });

  it("revises through the aggregate while the projection lags and replays success", async () => {
    const first = storedRuntime(0);
    const firstBoundary = native(first.runtime);
    const created = await firstBoundary.call("ordering.create-postage-policy", createArguments);
    expect(created.result.isError).not.toBe(true);
    const firstId = created.result.structuredContent!.policyId;
    const reviseInput = {
      ...createArguments,
      id: firstId,
      label: "Revised while catching up",
      idempotencyKey: "lagged-revise",
      confirmationText: "Revise Postage Policy.",
    };
    const revised = await firstBoundary.call("ordering.revise-postage-policy", reviseInput);
    expect(revised.result.isError).not.toBe(true);
    expect(revised.result.structuredContent).toMatchObject({ status: "revised", version: 2 });
    expect(first.allEvents).toHaveLength(2);
    expect(await firstBoundary.call("ordering.revise-postage-policy", reviseInput)).toEqual(revised);
    expect(first.allEvents).toHaveLength(2);

    const second = storedRuntime(1);
    const secondBoundary = native(second.runtime);
    const secondCreated = await secondBoundary.call("ordering.create-postage-policy", {
      ...createArguments,
      idempotencyKey: "lagged-active-create",
    });
    const secondId = secondCreated.result.structuredContent!.policyId;
    const activated = await secondBoundary.call("ordering.activate-postage-policy", {
      id: secondId,
      activationReason: "publish",
      idempotencyKey: "lagged-active-activate",
      confirmationText: "Activate Postage Policy.",
      confirmed: true,
    });
    expect(activated.result.isError).not.toBe(true);
    const activeRevision = await secondBoundary.call("ordering.revise-postage-policy", {
      ...createArguments,
      id: secondId,
      label: "Revised active policy",
      idempotencyKey: "lagged-active-revise",
      confirmationText: "Revise Postage Policy.",
    });
    expect(activeRevision.result.isError).not.toBe(true);
    expect(activeRevision.result.structuredContent).toMatchObject({ status: "revised", version: 3 });
    const aggregate = second.allEvents.reduce(
      (state, event) =>
        evolvePostagePolicy(state, { type: event.eventType, data: event.payload } as PostagePolicyEvent),
      initialPostagePolicyState,
    );
    expect(aggregate.status).toBe("active");
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
