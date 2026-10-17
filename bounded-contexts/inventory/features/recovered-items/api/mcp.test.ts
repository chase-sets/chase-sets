import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { readFileSync } from "node:fs";
import type { OperatorAuthorityDecision } from "@chase-sets/auth-context";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createActorEventStoreContext, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { createMcpRoutes, type McpAuditRecord } from "@chase-sets/platform-runtime/mcp";
import { inventoryService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/inventory";
import type { InventoryApiEnv } from "../../../api";
import { inventoryRecoveredItemRoutes } from "./route";
import { createRecoveredItemRuntime } from "./runtime";
import { createRecoveredItemMcpHandlers } from "./mcp";
import type { RecoveredItemServices } from "./runtime";

const manifest: {
  agentCoverage: { "inventory-recovered-items": { tools: string[] } };
  mcpCapabilities: { tools: { name: string; ownerSlice: string }[] };
} = JSON.parse(readFileSync(new URL("../../../context.json", import.meta.url), "utf8"));

const actor = {
  sessionId: "sess_1",
  tenantId: "tenant_1",
  userId: "user_1",
  accountId: "acc_1",
  membershipId: "mem_1",
  roleKey: "platform-admin",
  permissions: ["recovered-inventory.view", "recovered-inventory.manage"],
} satisfies ResolvedActor;

function services(): RecoveredItemServices {
  return {
    commandHandler: vi.fn(),
    createFromFacilityIntake: vi.fn(),
    execute: vi.fn(async (recoveredItemId, _command, _context) => ({
      recoveredItemId,
      version: 4,
      state: { status: "inspection-complete" },
    })),
    list: vi.fn(async () => ({ items: [{ recovered_item_id: "rcv_1" }], total: 1 })),
    get: vi.fn(),
    metrics: vi.fn(async () => ({ total_count: 1, sellable_count: 0 })),
    projectors: [],
  } as unknown as RecoveredItemServices;
}

const occurredAt = "2026-10-16T12:00:00.000Z";
const common = { id: "rcv_1", evidenceReferences: ["evidence_1"], occurredAt };
const actions = [
  {
    intent: "identify",
    name: "identify-recovered-item",
    input: {
      catalogItemId: "cat_1",
      productId: "prod_1",
      selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
    },
  },
  { intent: "inspect", name: "inspect-recovered-item", input: { conditionGrade: "near-mint" } },
  {
    intent: "require-authenticity-review",
    name: "require-recovered-item-authenticity-review",
    input: { policyVersion: "policy-v1", reasonCode: "required" },
  },
  {
    intent: "complete-authenticity-review",
    name: "complete-recovered-item-authenticity-review",
    input: { outcome: "authentic", reviewReference: "review_1" },
  },
  {
    intent: "record-authority",
    name: "record-recovered-item-disposition-authority",
    input: {
      legalOwner: "platform",
      authorityKind: "legal-review",
      allowedDispositions: ["platform-resale"],
      policyVersion: "policy-v1",
    },
  },
  {
    intent: "decide-disposition",
    name: "decide-recovered-item-disposition",
    input: {
      disposition: "platform-resale",
      storageLocationId: "loc_1",
      policyVersion: "policy-v1",
      reasonCode: "recover",
    },
  },
  {
    intent: "record-value",
    name: "record-recovered-item-value",
    input: {
      recoveryId: "recovery_1",
      recoveryType: "resale-proceeds",
      grossAmount: "10.00",
      costAmount: "1.00",
      currencyCode: "USD",
      policyVersion: "policy-v1",
    },
  },
  {
    intent: "correct-source",
    name: "correct-recovered-item-source",
    input: { correctedReturnShipmentId: "rsh_2", reason: "correction" },
  },
  { intent: "merge", name: "merge-recovered-item", input: { canonicalRecoveredItemId: "rcv_2", reason: "duplicate" } },
] as const;
const tools = inventoryService.tools.filter((tool) => tool.permissionBoundary.scope === "operator");

function native(owning: RecoveredItemServices) {
  const state: { actor: ResolvedActor; authority: OperatorAuthorityDecision } = {
    actor,
    authority: {
      kind: "granted",
      membershipId: "mem_operator",
      roleKey: "platform-admin",
      rolePermissions: actor.permissions,
    },
  };
  const audits: McpAuditRecord[] = [];
  const app = new Hono<{ Variables: { actor: ResolvedActor } }>();
  app.use("*", async (c, next) => {
    c.set("actor", state.actor);
    await next();
  });
  app.route(
    "/",
    createMcpRoutes({
      services: [{ ...inventoryService, tools, resources: [] }],
      ...createRecoveredItemMcpHandlers(owning),
      operatorAuthority: async () => state.authority,
      allowInMemoryIdempotencyStoreForTests: true,
      audit: async (record) => {
        audits.push(record);
      },
    }),
  );
  const call = async (name: string, input: Record<string, unknown>) => {
    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: `inventory.${name}`, arguments: input },
      }),
    });
    return (await response.json()) as {
      result: { isError?: boolean; structuredContent?: Record<string, unknown>; content: { text: string }[] };
    };
  };
  return { state, audits, call };
}

function writeInput(name: string, input: Record<string, unknown> = {}) {
  const tool = tools.find((entry) => entry.name === `inventory.${name}`)!;
  return { ...common, ...input, idempotencyKey: `key-${name}`, confirmed: true, confirmationText: `${tool.title}.` };
}

describe("recovered item MCP handlers", () => {
  it("lists and reads operator metrics", async () => {
    const fake = services();
    const handlers = createRecoveredItemMcpHandlers(fake);

    await expect(
      handlers.toolHandlers["inventory.list-recovered-items"]!({ actor, arguments: {} } as never),
    ).resolves.toEqual({
      items: [{ recovered_item_id: "rcv_1", evidence_references: [], disposition_authority: null }],
      total: 1,
      count: 1,
    });
    await expect(
      handlers.toolHandlers["inventory.get-recovered-item-metrics"]!({ actor, arguments: {} } as never),
    ).resolves.toEqual({
      total_count: 1,
      sellable_count: 0,
    });
    expect(fake.list).toHaveBeenCalledWith({ status: null, limit: 50, offset: 0 });
  });

  it("MCP source-call contract coverage", async () => {
    const fake = services();
    const handlers = createRecoveredItemMcpHandlers(fake);
    const expected = [
      "inventory.list-recovered-items",
      "inventory.get-recovered-item-metrics",
      ...actions.map((row) => `inventory.${row.name}`),
    ].sort();
    expect(Object.keys(handlers.toolHandlers).sort()).toEqual(expected);
    expect(manifest.agentCoverage["inventory-recovered-items"].tools.slice().sort()).toEqual(expected);
    expect(tools.map((tool) => tool.name).sort()).toEqual(expected);
    for (const tool of tools) {
      const row = actions.find((entry) => `inventory.${entry.name}` === tool.name);
      expect(tool.permissionBoundary).toEqual({
        scope: "operator",
        requiredPermissions: [row ? "recovered-inventory.manage" : "recovered-inventory.view"],
        requiredScopes: [],
        accountScoped: false,
        auditPrincipal: "actor",
      });
      expect(tool.availability).toBe("available");
      expect(tool.risk).toBe(
        row ? (["decide-disposition", "merge"].includes(row.intent) ? "destructive" : "sensitive") : "read",
      );
      expect(tool.guardrails.confirmation.required).toBe(Boolean(row));
      expect(tool.guardrails.idempotencyKey).toBe(row ? "required" : "not-applicable");
      const fields = row
        ? [
            ...Object.keys(common),
            ...Object.keys(row.input),
            "idempotencyKey",
            "confirmed",
            "confirmationText",
            ...(row.intent === "decide-disposition" ? ["targetAccountId"] : []),
          ]
        : tool.name === "inventory.list-recovered-items"
          ? ["status", "limit", "offset"]
          : [];
      expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(fields.sort());
    }
    expect(
      manifest.mcpCapabilities.tools
        .filter((tool) => tool.ownerSlice === "recovered-items")
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(expected);
    const complete = (names: readonly string[]) => expected.every((name) => names.includes(name));
    for (const omitted of expected) expect(complete(expected.filter((name) => name !== omitted))).toBe(false);
    const source = readFileSync(new URL("../../../routes/admin/recovered-items.tsx", import.meta.url), "utf8");
    expect([...source.matchAll(/handleAction\("([^"]+)"/g)].map((match) => match[1]).sort()).toEqual(
      actions.map((row) => row.intent).sort(),
    );
    const http = new Hono<InventoryApiEnv>();
    http.use("*", async (c, next) => {
      c.set("actor", actor);
      c.set("context", createActorEventStoreContext(actor));
      await next();
    });
    http.route("/", inventoryRecoveredItemRoutes(fake));
    for (const row of actions) {
      const args = { ...common, ...row.input };
      const response = await http.request("/rcv_1/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...args, intent: row.intent }),
      });
      expect(response.status).toBe(200);
      const httpCall = vi.mocked(fake.execute).mock.calls.at(-1);
      await handlers.toolHandlers[`inventory.${row.name}`]!({ actor, arguments: args } as never);
      expect(vi.mocked(fake.execute).mock.calls.at(-1)).toEqual(httpCall);
    }
    await handlers.toolHandlers["inventory.list-recovered-items"]!({
      actor,
      arguments: { status: "quarantined", limit: 250, offset: 250 },
    } as never);
    expect(fake.list).toHaveBeenCalledWith({ status: "quarantined", limit: 250, offset: 250 });
    await handlers.toolHandlers["inventory.get-recovered-item-metrics"]!({ actor, arguments: {} } as never);
    expect(fake.metrics).toHaveBeenCalledOnce();
  });

  it.each(actions)("executes $name once and rejects conflicting, unconfirmed and unauthorized replay", async (row) => {
    const fake = services();
    const boundary = native(fake);
    const args = writeInput(row.name, row.input);
    const first = await boundary.call(row.name, args);
    expect(first.result.isError).not.toBe(true);
    expect(first.result.structuredContent).toEqual({
      recoveredItemId: "rcv_1",
      version: 4,
      status: "inspection-complete",
    });
    expect(await boundary.call(row.name, args)).toEqual(first);
    for (const invalid of [
      { id: "rcv_other" },
      { confirmed: false },
      { confirmationText: "unrelated" },
      { accountId: "acc_other" },
      { evidenceReferences: [42] },
      { dryRun: true },
    ]) {
      expect((await boundary.call(row.name, { ...args, ...invalid })).result.isError).toBe(true);
    }
    boundary.state.authority = { kind: "denied", reason: "inactive" };
    expect((await boundary.call(row.name, args)).result.isError).toBe(true);
    expect(fake.execute).toHaveBeenCalledOnce();
    expect(vi.mocked(fake.execute).mock.calls[0]![2]).toEqual(createActorEventStoreContext(actor));
    expect(boundary.audits.at(-1)).toMatchObject({ outcome: "denied", actorId: actor.userId });
    expect(JSON.stringify(boundary.audits)).not.toContain("evidence_1");
  });

  it("retains original evidence policy and denies insufficient operator permissions and commerce-only grants", async () => {
    const fake = services();
    vi.mocked(fake.list).mockResolvedValue({
      items: [
        {
          recovered_item_id: "rcv_1",
          evidence_references: ["private-evidence"],
          disposition_authority: { private: true },
        },
      ],
      total: 1,
    } as never);
    const boundary = native(fake);
    expect((await boundary.call("list-recovered-items", {})).result.structuredContent).toMatchObject({
      items: [{ evidence_references: [], disposition_authority: null }],
      count: 1,
      total: 1,
    });
    boundary.state.authority = {
      kind: "granted",
      membershipId: "mem_op",
      roleKey: "platform-admin",
      rolePermissions: [...actor.permissions, "recovered-inventory.evidence"],
    };
    expect(
      (await boundary.call("list-recovered-items", { limit: 250, offset: 250 })).result.structuredContent,
    ).toMatchObject({
      items: [{ evidence_references: ["private-evidence"], disposition_authority: { private: true } }],
    });
    expect(fake.list).toHaveBeenLastCalledWith({ status: null, limit: 250, offset: 250 });
    boundary.state.authority = {
      kind: "granted",
      membershipId: "mem_op",
      roleKey: "platform-admin",
      rolePermissions: ["recovered-inventory.view"],
    };
    const input = writeInput("inspect-recovered-item", { conditionGrade: "near-mint" });
    expect((await boundary.call("inspect-recovered-item", input)).result.isError).toBe(true);
    boundary.state.authority = {
      kind: "granted",
      membershipId: "mem_op",
      roleKey: "platform-admin",
      rolePermissions: actor.permissions,
    };
    boundary.state.actor = {
      ...actor,
      agentGrant: {
        grantId: "grant_commerce",
        platformProfileUrl: "https://agent.test",
        scopes: ["inventory:write"],
        rolePermissions: actor.permissions,
      },
    };
    expect((await boundary.call("inspect-recovered-item", input)).result.isError).toBe(true);
    boundary.state.actor = actor;
    expect(
      (
        await boundary.call(
          "complete-recovered-item-authenticity-review",
          writeInput("complete-recovered-item-authenticity-review", { outcome: "forged", reviewReference: "review_1" }),
        )
      ).result.isError,
    ).toBe(true);
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it("persists the operator and refuses unknown targets with no duplicate event on retry", async () => {
    const store = createInMemoryEventStore();
    const runtime = createRecoveredItemRuntime({
      eventStore: store.eventStore,
      checkpointStore: {} as never,
      db: { query: vi.fn(async () => ({ rows: [] })) },
    });
    const intake = await runtime.createFromFacilityIntake(
      {
        returnShipmentId: "rsh_1",
        remedyId: "rmd_1",
        facilityId: "facility_1",
        stationId: "station_1",
        custodyIdentifier: "custody_1",
        evidenceReferences: ["e"],
        intakeDisposition: "completed",
        hasDiscrepancy: false,
        observedItemReference: null,
        policyVersion: "policy-v1",
        receivedAt: occurredAt,
      },
      createActorEventStoreContext(actor),
    );
    const boundary = native(runtime);
    const input = writeInput("identify-recovered-item", { ...actions[0].input, id: intake.recoveredItemId });
    expect((await boundary.call("identify-recovered-item", input)).result.isError).not.toBe(true);
    await boundary.call("identify-recovered-item", input);
    const identified = store.allEvents.filter((event) => event.eventType === "inventory.recovered-item.identified.v1");
    expect(identified).toHaveLength(1);
    expect(identified[0]).toMatchObject({
      performedByUserId: actor.userId,
      forAccountId: actor.accountId,
      payload: { identifiedByUserId: actor.userId },
    });
    expect(
      (
        await boundary.call(
          "inspect-recovered-item",
          writeInput("inspect-recovered-item", { conditionGrade: "near-mint", id: "missing" }),
        )
      ).result.isError,
    ).toBe(true);
    expect(store.allEvents).toHaveLength(2);
    expect(boundary.audits.at(-1)).toMatchObject({ outcome: "failed" });
  });

  it("preserves operator attribution for every delegated write", async () => {
    const fake = services();
    const handlers = createRecoveredItemMcpHandlers(fake);

    await handlers.toolHandlers["inventory.identify-recovered-item"]!({
      actor,
      arguments: {
        id: "rcv_1",
        catalogItemId: "cat_1",
        productId: "prod_1",
        selectedOptions: [{ dimensionId: "condition", optionId: "near-mint" }],
        evidenceReferences: ["evidence_1"],
        occurredAt: "2026-10-16T12:00:00.000Z",
      },
    } as never);

    const [id, command, context] = vi.mocked(fake.execute).mock.calls[0]!;
    expect(id).toBe("rcv_1");
    expect(command).toMatchObject({
      type: "IdentifyRecoveredItem",
      catalogItemId: "cat_1",
      identifiedByUserId: "user_1",
      evidenceReferences: ["evidence_1"],
    });
    expect(context.audit).toMatchObject({ performedByUserId: "user_1" });
  });

  it("rejects unauthorized actors and malformed action input before execution", async () => {
    const fake = services();
    const handlers = createRecoveredItemMcpHandlers(fake);
    const unauthorized = { ...actor, permissions: ["recovered-inventory.view"] } satisfies ResolvedActor;

    await expect(
      handlers.toolHandlers["inventory.merge-recovered-item"]!({
        actor: unauthorized,
        arguments: { id: "rcv_1", canonicalRecoveredItemId: "rcv_2", reason: "duplicate", evidenceReferences: ["e"] },
      } as never),
    ).rejects.toThrow("recovered-inventory.manage");
    await expect(
      handlers.toolHandlers["inventory.identify-recovered-item"]!({ actor, arguments: { id: "rcv_1" } } as never),
    ).rejects.toThrow("catalogItemId is required");
    expect(fake.execute).not.toHaveBeenCalled();
  });
});
