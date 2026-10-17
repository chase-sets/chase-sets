import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import {
  createMcpRoutes,
  validateMcpModuleRegistrations,
  type McpAuditRecord,
  type McpToolHandlerInput,
} from "@chase-sets/platform-runtime/mcp";
import { marketplaceService } from "@chase-sets/platform-runtime/mcp-contracts/catalog/marketplace";
import { createListingEvidencePolicyMcpHandlers } from "./mcp";
import { createListingEvidencePolicyRuntime, type ListingEvidencePolicyRuntime } from "./runtime";

const actor = {
  sessionId: "sess_operator",
  userId: "usr_operator",
  accountId: "acc_operator",
  tenantId: "tnt_test",
  membershipId: "mem_operator",
  roleKey: "platform-admin",
  permissions: [
    "listing-evidence-policy.view",
    "listing-evidence-policy.draft",
    "listing-evidence-policy.validate",
    "listing-evidence-policy.activate",
  ],
} satisfies ResolvedActor;

function input(arguments_: Record<string, unknown>): McpToolHandlerInput {
  return {
    actor,
    arguments: arguments_,
    tool: {} as McpToolHandlerInput["tool"],
    request: new Request("https://test"),
    protocol: {} as McpToolHandlerInput["protocol"],
  };
}

function createRuntime() {
  return {
    getOverview: vi.fn(async () => ({ policyKey: "marketplace.listing-evidence" })),
    loadSelectorCatalog: vi.fn(async () => ({ catalogItems: [] })),
    createDraft: vi.fn(async () => ({ documentId: "pol_draft", version: 1 })),
    validateDraft: vi.fn(async () => ({ documentId: "pol_draft", version: 2, valid: true })),
    rejectDraft: vi.fn(async () => ({ documentId: "pol_draft", version: 3 })),
    createRollbackDraft: vi.fn(async () => ({ documentId: "pol_rollback", version: 1 })),
    activateDraft: vi.fn(async () => ({ policyId: "pol_active", version: 1, policyHash: "sha256:active" })),
  } as unknown as ListingEvidencePolicyRuntime;
}

const writeConfirmation = {
  idempotencyKey: "retry-1",
  confirmed: true,
};

function assertActivationSourceCall(runtime: ListingEvidencePolicyRuntime) {
  expect(runtime.activateDraft).toHaveBeenCalledWith(
    "pol_draft",
    expect.objectContaining({
      actorUserId: "usr_operator",
      impactAcknowledgmentHash: "sha256:impact",
      effectiveFrom: "2026-09-01T00:00:00.000Z",
      effectiveUntil: "2026-10-01T00:00:00.000Z",
    }),
    expect.anything(),
  );
}

describe("MCP source-call contract coverage", () => {
  it("exposes every listing evidence policy contract through its owning runtime", async () => {
    const runtime = createRuntime();
    const handlers = createListingEvidencePolicyMcpHandlers(runtime).toolHandlers;
    const common = { ...writeConfirmation, confirmationText: "Validate Listing Evidence Policy Draft." };

    await handlers["marketplace.get-listing-evidence-policy-overview"]!(input({}));
    await handlers["marketplace.get-listing-evidence-policy-selectors"]!(input({}));
    await handlers["marketplace.create-listing-evidence-policy-draft"]!(
      input({
        policyName: "Policy",
        rules: [],
        ...writeConfirmation,
        confirmationText: "Create Listing Evidence Policy Draft.",
      }),
    );
    await handlers["marketplace.validate-listing-evidence-policy-draft"]!(input({ policyId: "pol_draft", ...common }));
    await handlers["marketplace.reject-listing-evidence-policy-draft"]!(
      input({ policyId: "pol_draft", ...writeConfirmation, confirmationText: "Reject Listing Evidence Policy Draft." }),
    );
    await handlers["marketplace.create-listing-evidence-policy-rollback-draft"]!(
      input({
        policyId: "pol_active",
        ...writeConfirmation,
        confirmationText: "Create Listing Evidence Policy Rollback Draft.",
      }),
    );
    await handlers["marketplace.activate-listing-evidence-policy-draft"]!(
      input({
        policyId: "pol_draft",
        effectiveFrom: "2026-09-01T00:00:00.000Z",
        effectiveUntil: "2026-10-01T00:00:00.000Z",
        impactAcknowledgmentHash: "sha256:impact",
        ...writeConfirmation,
        confirmationText: "sha256:impact",
      }),
    );

    expect(runtime.getOverview).toHaveBeenCalledTimes(1);
    expect(runtime.loadSelectorCatalog).toHaveBeenCalledTimes(1);
    expect(runtime.createDraft).toHaveBeenCalledTimes(1);
    expect(runtime.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "usr_operator" }),
      expect.objectContaining({ audit: { performedByUserId: "usr_operator", forAccountId: "acc_operator" } }),
    );
    expect(runtime.validateDraft).toHaveBeenCalledWith("pol_draft", "usr_operator", expect.anything());
    expect(runtime.rejectDraft).toHaveBeenCalledWith("pol_draft", "usr_operator", expect.anything());
    expect(runtime.createRollbackDraft).toHaveBeenCalledWith("pol_active", "usr_operator", expect.anything());
    assertActivationSourceCall(runtime);
    expect(Object.keys(handlers).sort()).toEqual([
      "marketplace.activate-listing-evidence-policy-draft",
      "marketplace.create-listing-evidence-policy-draft",
      "marketplace.create-listing-evidence-policy-rollback-draft",
      "marketplace.get-listing-evidence-policy-overview",
      "marketplace.get-listing-evidence-policy-selectors",
      "marketplace.reject-listing-evidence-policy-draft",
      "marketplace.validate-listing-evidence-policy-draft",
    ]);
  });

  it("rejects omitted target input, account overrides, and missing operator actors before effects", async () => {
    const runtime = createRuntime();
    const handlers = createListingEvidencePolicyMcpHandlers(runtime).toolHandlers;

    await expect(
      handlers["marketplace.validate-listing-evidence-policy-draft"]!(
        input({ confirmationText: "Validate Listing Evidence Policy Draft.", idempotencyKey: "k", confirmed: true }),
      ),
    ).rejects.toThrow("policyId is required");
    await expect(
      handlers["marketplace.get-listing-evidence-policy-overview"]!(input({ accountId: "acc_other" })),
    ).rejects.toThrow("Unknown Listing Evidence Policy argument");
    await expect(
      handlers["marketplace.get-listing-evidence-policy-overview"]!({ ...input({}), actor: null }),
    ).rejects.toThrow("authenticated operator actor");
    await expect(
      handlers["marketplace.get-listing-evidence-policy-overview"]!({
        ...input({}),
        actor: { ...actor!, permissions: [] },
      }),
    ).rejects.toThrow("listing-evidence-policy.view");
    expect(runtime.validateDraft).not.toHaveBeenCalled();
    expect(runtime.getOverview).not.toHaveBeenCalled();
  });

  it("rejects unconfirmed and invalid rule writes before invoking the runtime", async () => {
    const runtime = createRuntime();
    const handlers = createListingEvidencePolicyMcpHandlers(runtime).toolHandlers;

    await expect(
      handlers["marketplace.create-listing-evidence-policy-draft"]!(
        input({
          policyName: "Policy",
          rules: [],
          idempotencyKey: "k",
          confirmationText: "Create Listing Evidence Policy Draft.",
        }),
      ),
    ).rejects.toThrow("confirmed must be true");
    await expect(
      handlers["marketplace.create-listing-evidence-policy-draft"]!(
        input({
          policyName: "Policy",
          rules: {},
          ...writeConfirmation,
          confirmationText: "Create Listing Evidence Policy Draft.",
        }),
      ),
    ).rejects.toThrow("rules must be a list");
    expect(runtime.createDraft).not.toHaveBeenCalled();
  });

  it("detects a missing mapped handler and an omitted optional effective-interval source branch", async () => {
    const runtime = createRuntime();
    const handlers = createListingEvidencePolicyMcpHandlers(runtime);
    const capabilities = {
      tools: policyTools.map((tool) => ({ name: tool.name, ownerSlice: "listing-evidence-policy" })),
    };
    const registration = { contextName: "marketplace", capabilities, handlers };
    expect(validateMcpModuleRegistrations([registration], services)).toEqual([]);
    const omitted = { ...handlers.toolHandlers };
    delete omitted["marketplace.activate-listing-evidence-policy-draft"];
    expect(
      validateMcpModuleRegistrations([{ ...registration, handlers: { toolHandlers: omitted } }], services),
    ).toContain(
      "Available MCP tool 'marketplace.activate-listing-evidence-policy-draft' is declared but no handler is registered.",
    );
    // Mutant drops the optional interval end that the source activation branch supplies.
    const original = handlers.toolHandlers["marketplace.activate-listing-evidence-policy-draft"]!;
    await original(
      input({
        policyId: "pol_draft",
        effectiveFrom: "2026-09-01T00:00:00.000Z",
        impactAcknowledgmentHash: "sha256:impact",
        ...writeConfirmation,
        confirmationText: "sha256:impact",
      }),
    );
    expect(() => assertActivationSourceCall(runtime)).toThrow();
  });
});

const policyTools = marketplaceService.tools.filter((tool) => tool.name.includes("listing-evidence-policy"));
const services = [{ ...marketplaceService, tools: policyTools, resources: [] }];
const createName = "marketplace.create-listing-evidence-policy-draft";
const createArgs = {
  policyName: "Synthetic policy",
  rules: [{ ruleId: "test-rule", explanationCode: "test.rule", outcome: {} }],
  ...writeConfirmation,
  confirmationText: "Create Listing Evidence Policy Draft.",
};

function createProtocolHarness(runtime: ListingEvidencePolicyRuntime) {
  let currentActor: ResolvedActor | null = actor;
  let granted = true;
  const audits: McpAuditRecord[] = [];
  const app = new Hono<{ Variables: { actor: ResolvedActor | null } }>();
  app.use("*", async (c, next) => {
    c.set("actor", currentActor);
    await next();
  });
  app.route(
    "/",
    createMcpRoutes({
      services,
      ...createListingEvidencePolicyMcpHandlers(runtime),
      allowInMemoryIdempotencyStoreForTests: true,
      operatorAuthority: async () =>
        granted
          ? {
              kind: "granted",
              membershipId: actor.membershipId,
              roleKey: "platform-admin",
              rolePermissions: actor.permissions,
            }
          : { kind: "denied", reason: "not-platform-admin" },
      audit: async (record) => {
        audits.push(record);
      },
    }),
  );
  return {
    audits,
    setActor(value: ResolvedActor | null) {
      currentActor = value;
    },
    denyAuthority() {
      granted = false;
    },
    async call(name: string, args: Record<string, unknown>) {
      const response = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "synthetic-request",
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      return (await response.json()) as {
        result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text: string }[] };
        error?: unknown;
      };
    },
  };
}

function createStoredRuntime() {
  const { eventStore, allEvents } = createInMemoryEventStore();
  const now = () => new Date("2026-07-13T00:00:00.000Z");
  // Query fixture reconstructs projection rows from real stored policy events.
  const db: PgQueryable = {
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      const documents = new Map<string, Record<string, unknown>>();
      for (const event of allEvents) {
        const p = event.payload;
        const id = String(p.documentId);
        documents.set(id, {
          document_id: id,
          policy_key: p.policyKey,
          context_name: "marketplace",
          schema_summary: "Synthetic policy fixture",
          value: p.value,
          status: p.status,
          effective_from: p.effectiveFrom,
          effective_until: p.effectiveUntil,
          created_at: event.recordedAt,
          updated_at: event.recordedAt,
          version: event.streamVersion,
        });
      }
      let rows: Record<string, unknown>[] = [];
      if (sql.includes("FROM platform_policy_document_history")) {
        rows = allEvents
          .filter((e) => e.payload.documentId === values[0])
          .map((e) => ({
            history_id: String(e.streamVersion),
            actor_user_id: e.payload.actorUserId,
            event_id: e.eventId,
          }));
      } else if (sql.includes("FROM platform_policy_documents")) {
        rows = [...documents.values()];
        if (sql.includes("WHERE document_id = $1")) rows = rows.filter((r) => r.document_id === values[0]);
        else if (sql.includes("status = 'active'")) {
          rows = rows.filter((r) => r.status === "active");
          if (sql.includes("LIMIT 1"))
            rows = rows.filter(
              (r) =>
                r.document_id !== values[3] &&
                Date.parse(String(r.effective_from)) < (values[2] ? Date.parse(String(values[2])) : Infinity) &&
                (r.effective_until ? Date.parse(String(r.effective_until)) : Infinity) > Date.parse(String(values[1])),
            );
        }
      } else if (sql.includes(" = ANY($1::text[])")) {
        rows = (values[0] as string[]).filter((id) => id !== "missing").map((id) => ({ id }));
      }
      return { rows: rows as Row[], rowCount: rows.length };
    },
  };
  const policies = createPolicyRuntime({ eventStore, db, now });
  return { allEvents, runtime: createListingEvidencePolicyRuntime({ db, policies, now }) };
}

describe("Listing Evidence Policy MCP boundaries", () => {
  it("requires exact frozen schemas, permissions, and non-dry-run guardrails", () => {
    expect(policyTools).toHaveLength(7);
    for (const tool of policyTools) {
      expect(tool.availability).toBe("available");
      expect(tool.permissionBoundary).toMatchObject({ scope: "operator", requiredScopes: [], accountScoped: false });
      expect(tool.permissionBoundary.requiredPermissions).toHaveLength(1);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.guardrails.dryRunSupported).toBe(false);
      if (tool.risk === "read") {
        expect(tool.inputSchema.required).toEqual([]);
        expect(tool.guardrails.confirmation.required).toBe(false);
      } else {
        expect(tool.inputSchema.required).toEqual(
          expect.arrayContaining(["confirmed", "confirmationText", "idempotencyKey"]),
        );
        expect(tool.guardrails.idempotencyAuthority).toBe("platform");
      }
    }
    expect(policyTools.map((tool) => tool.name).sort()).toEqual([
      "marketplace.activate-listing-evidence-policy-draft",
      "marketplace.create-listing-evidence-policy-draft",
      "marketplace.create-listing-evidence-policy-rollback-draft",
      "marketplace.get-listing-evidence-policy-overview",
      "marketplace.get-listing-evidence-policy-selectors",
      "marketplace.reject-listing-evidence-policy-draft",
      "marketplace.validate-listing-evidence-policy-draft",
    ]);
  });

  it("refuses missing confirmation, wrong title, invalid nested input, account overrides and missing targets before effects", async () => {
    const { runtime, allEvents } = createStoredRuntime();
    const harness = createProtocolHarness(runtime);
    for (const args of [
      { ...createArgs, confirmed: false },
      { ...createArgs, confirmationText: "Wrong title." },
      { ...createArgs, idempotencyKey: "" },
      { ...createArgs, accountId: "acc_other" },
      { ...createArgs, rules: [{ ruleId: "bad", explanationCode: "bad", outcome: { minimumPhotoCount: 101 } }] },
      {
        ...createArgs,
        rules: [
          {
            ruleId: "bad",
            explanationCode: "bad",
            outcome: { requiredSlots: [{ slotId: "front", viewKind: "front", maximumAgeHours: 87601 }] },
          },
        ],
      },
      { ...createArgs, rules: [{ ruleId: "bad", explanationCode: "bad", outcome: {}, selector: { unknown: true } }] },
    ]) {
      expect((await harness.call(createName, args)).result?.isError).toBe(true);
      expect(allEvents).toHaveLength(0);
    }
    expect(
      (
        await harness.call("marketplace.validate-listing-evidence-policy-draft", {
          ...writeConfirmation,
          confirmationText: "Validate Listing Evidence Policy Draft.",
        })
      ).result?.isError,
    ).toBe(true);
    expect(allEvents).toHaveLength(0);
    expect(harness.audits.map((a) => a.outcome)).toContain("denied");
  });

  it("persists the admitted operator on every write and replays without duplicating effects", async () => {
    const { runtime, allEvents } = createStoredRuntime();
    const harness = createProtocolHarness(runtime);
    const created = await harness.call(createName, createArgs);
    expect(created.result?.isError).not.toBe(true);
    const policyId = created.result!.structuredContent!.policyId;
    expect(allEvents).toHaveLength(1);
    expect(await harness.call(createName, createArgs)).toEqual(created);
    expect(allEvents).toHaveLength(1);
    expect((await harness.call(createName, { ...createArgs, policyName: "Conflict" })).result?.isError).toBe(true);
    expect(allEvents).toHaveLength(1);
    const validated = await harness.call("marketplace.validate-listing-evidence-policy-draft", {
      policyId,
      confirmed: true,
      idempotencyKey: "validate-1",
      confirmationText: "Validate Listing Evidence Policy Draft.",
    });
    expect(validated.result?.structuredContent?.valid).toBe(true);
    const impact = validated.result!.structuredContent!.impactPreview as { previewHash: string };
    const activationArgs = {
      policyId,
      effectiveFrom: "2026-08-01T00:00:00.000Z",
      impactAcknowledgmentHash: impact.previewHash,
      confirmed: true,
      idempotencyKey: "activate-1",
      confirmationText: impact.previewHash,
    };
    const beforeActivation = allEvents.length;
    expect(
      (
        await harness.call("marketplace.activate-listing-evidence-policy-draft", {
          ...activationArgs,
          confirmationText: "stale",
        })
      ).result?.isError,
    ).toBe(true);
    expect(
      (
        await harness.call("marketplace.activate-listing-evidence-policy-draft", {
          ...activationArgs,
          impactAcknowledgmentHash: "stale",
          confirmationText: "stale",
          idempotencyKey: "activate-stale",
        })
      ).result?.isError,
    ).toBe(true);
    expect(allEvents).toHaveLength(beforeActivation);
    const activated = await harness.call("marketplace.activate-listing-evidence-policy-draft", activationArgs);
    expect(activated.result?.structuredContent).toMatchObject({
      policyHash: expect.stringMatching(/^sha256:/),
      scheduled: true,
    });
    const count = allEvents.length;
    expect(await harness.call("marketplace.activate-listing-evidence-policy-draft", activationArgs)).toEqual(activated);
    expect(allEvents).toHaveLength(count);
    const rollback = await harness.call("marketplace.create-listing-evidence-policy-rollback-draft", {
      policyId: activated.result!.structuredContent!.policyId,
      confirmed: true,
      idempotencyKey: "rollback-1",
      confirmationText: "Create Listing Evidence Policy Rollback Draft.",
    });
    expect(rollback.result?.isError).not.toBe(true);
    expect(
      (
        await harness.call("marketplace.reject-listing-evidence-policy-draft", {
          policyId: rollback.result!.structuredContent!.policyId,
          confirmed: true,
          idempotencyKey: "reject-1",
          confirmationText: "Reject Listing Evidence Policy Draft.",
        })
      ).result?.isError,
    ).not.toBe(true);
    expect(allEvents.length).toBeGreaterThan(count);
    for (const event of allEvents) {
      expect(event.payload.actorUserId).toBe(actor.userId);
      expect(event.performedByUserId).toBe(actor.userId);
      expect(event.forAccountId).toBe(actor.accountId);
    }
    harness.denyAuthority();
    expect((await harness.call(createName, createArgs)).result?.isError).toBe(true);
    expect(
      (await harness.call("marketplace.activate-listing-evidence-policy-draft", activationArgs)).result?.isError,
    ).toBe(true);
    expect(allEvents).toHaveLength(count + 2);
  });

  it("denies forged owner authority, absent actors and grants without operations scope before effects", async () => {
    const { runtime, allEvents } = createStoredRuntime();
    const harness = createProtocolHarness(runtime);
    harness.setActor(null);
    expect((await harness.call(createName, createArgs)).error).toBeDefined();
    harness.setActor({
      ...actor,
      agentGrant: {
        grantId: "synthetic-commerce-grant",
        platformProfileUrl: "https://synthetic.invalid/profile",
        scopes: ["listings:write"],
        rolePermissions: actor.permissions,
      },
    });
    const refused = await harness.call(createName, createArgs);
    expect(refused.result?.isError === true || refused.error !== undefined).toBe(true);
    harness.setActor({ ...actor, roleKey: "owner" });
    harness.denyAuthority();
    expect((await harness.call(createName, createArgs)).result?.isError).toBe(true);
    expect(allEvents).toHaveLength(0);
  });
});
