import { readFileSync } from "node:fs";
import type { OperatorAuthority, ResolvedActor } from "@chase-sets/auth-context";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import { createMcpRoutes, type McpRuntimeEnv, type McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import { findMcpTool, mcpServiceCatalog } from "@chase-sets/platform-runtime/mcp-contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { contextManifest } from "@chase-sets/auth";
import { toSessionStreamId } from "../domain/auth-flow";
import { createAuthSessionMcpHandlers } from "./mcp";
import { createSessionRuntime } from "./runtime";

const admin = {
  sessionId: "ses_admin",
  tenantId: "tnt_1",
  userId: "usr_admin",
  accountId: "acc_admin",
  membershipId: "mem_admin",
  roleKey: "platform-admin",
  permissions: ["security.manage"],
  agentGrant: {
    grantId: "agr_test",
    platformProfileUrl: "https://agent.test/profile",
    scopes: ["operations:write"],
    rolePermissions: ["security.manage"],
  },
} satisfies ResolvedActor;

const sourceCalls = [
  { route: "sessions", method: "listSessions", tool: "auth.list-sessions", args: {} },
  { route: "sessions-detail", method: "getSession", tool: "auth.get-session", args: { sessionId: "ses_target" } },
  {
    route: "sessions-detail",
    method: "switchSessionAccount",
    tool: "auth.switch-session-account",
    args: { sessionId: "ses_target", accountId: "acc_other" },
  },
  { route: "sessions-detail", method: "revokeSession", tool: "auth.revoke-session", args: { sessionId: "ses_target" } },
] as const;

function assertSourceCallCoverage(
  calls: readonly (typeof sourceCalls)[number][],
  handlers: Readonly<Record<string, McpToolHandler>>,
) {
  for (const route of ["sessions", "sessions-detail"] as const) {
    const source = readFileSync(new URL(`../../../routes/access-admin/${route}.tsx`, import.meta.url), "utf8");
    const traced = [...source.matchAll(/(?:\bapi\.|createAuthRequestApiClient\(request\)\.)(\w+)/g)].map(
      (match) => match[1],
    );
    const mapped = calls.filter((call) => call.route === route);
    expect(mapped.map((call) => call.method).sort()).toEqual([...new Set(traced)].sort());
    expect([...contextManifest.agentCoverage[route].tools].sort()).toEqual(mapped.map((call) => call.tool).sort());
    for (const call of mapped) {
      expect(handlers[call.tool], call.tool).toBeTypeOf("function");
      expect(findMcpTool(call.tool)?.availability, call.tool).toBe("available");
    }
  }
}

async function fixture() {
  const store = createInMemoryEventStore();
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => ({
    rows:
      sql.includes("sessions.session_id = $1") && params?.[0] !== "ses_target"
        ? []
        : sql.includes("COUNT(*)")
          ? [{ count: 1 }]
          : [row()],
  }));
  const runtime = createSessionRuntime({
    eventStore: store.eventStore,
    checkpointStore: {} as never,
    db: { query } as unknown as PgQueryable,
  });
  await runtime.commandHandler({
    streamId: toSessionStreamId("ses_target"),
    command: {
      type: "StartSession",
      sessionId: "ses_target" as never,
      userId: "usr_target" as never,
      accountId: "acc_target" as never,
      availableAccountIds: ["acc_target", "acc_other"],
      authenticationMethod: "password",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    context: createActorEventStoreContext(admin),
  });
  const services = {
    ...runtime,
    getSession: vi.fn(runtime.getSession),
    listSessions: vi.fn(runtime.listSessions),
    commandHandler: vi.fn(runtime.commandHandler),
  };
  const handlers = createAuthSessionMcpHandlers(services).toolHandlers;
  let actor: ResolvedActor | null = admin;
  let allowed = true;
  let permissions: readonly string[] = ["security.manage"];
  const authority = vi.fn<OperatorAuthority>(async () =>
    allowed
      ? { kind: "granted", membershipId: admin.membershipId, roleKey: "platform-admin", rolePermissions: permissions }
      : { kind: "denied", reason: "inactive" },
  );
  const audit = vi.fn(async (_record: unknown) => undefined);
  const app = new Hono<McpRuntimeEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route(
    "/",
    createMcpRoutes({
      services: mcpServiceCatalog.filter((service) => service.serviceId === "auth"),
      toolHandlers: handlers,
      operatorAuthority: authority,
      audit,
      allowInMemoryIdempotencyStoreForTests: true,
    }),
  );
  function post(name: string, args: Record<string, unknown>) {
    return app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "request_1",
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
  }
  async function call(name: string, args: Record<string, unknown>) {
    const response = await post(name, args);
    expect(response.status).toBe(200);
    return (await response.json()) as {
      result: { isError?: boolean; structuredContent?: unknown; content: { text: string }[] };
    };
  }
  return {
    ...store,
    services,
    handlers,
    query,
    call,
    post,
    audit,
    authority,
    setActor: (value: ResolvedActor | null) => {
      actor = value;
    },
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    setPermissions: (value: readonly string[]) => {
      permissions = value;
    },
  };
}

function row() {
  return {
    session_id: "ses_target",
    user_id: "usr_target",
    user_display_name: "Target User",
    user_primary_email: "target@example.test",
    account_id: "acc_target",
    account_display_name: "Target Account",
    account_name: "target",
    available_account_ids: ["acc_target", "acc_other"],
    authentication_method: "password",
    status: "active",
    expires_at: "2099-01-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
  };
}

function writeArgs(tool: string, extra: Record<string, unknown> = {}) {
  return {
    sessionId: "ses_target",
    idempotencyKey: `idem-${tool}`,
    confirmed: true,
    confirmationText: `${findMcpTool(tool)!.title}.`,
    ...extra,
  };
}

describe("auth session MCP contracts", () => {
  it("pins the frozen exact schemas, risks and confirmation policies", () => {
    const contracts = [
      { name: "auth.get-session", fields: ["sessionId"], required: ["sessionId"], risk: "read" },
      { name: "auth.list-sessions", fields: ["search", "status", "limit", "offset"], required: [], risk: "read" },
      {
        name: "auth.revoke-session",
        fields: ["sessionId", "idempotencyKey", "confirmed", "confirmationText"],
        required: ["sessionId", "idempotencyKey", "confirmed", "confirmationText"],
        risk: "destructive",
      },
      {
        name: "auth.switch-session-account",
        fields: ["sessionId", "accountId", "idempotencyKey", "confirmed", "confirmationText"],
        required: ["sessionId", "accountId", "idempotencyKey", "confirmed", "confirmationText"],
        risk: "sensitive",
      },
    ];
    for (const contract of contracts) {
      const tool = findMcpTool(contract.name)!;
      expect(tool.risk).toBe(contract.risk);
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys(tool.inputSchema.properties).sort()).toEqual([...contract.fields].sort());
      expect([...(tool.inputSchema.required ?? [])].sort()).toEqual([...contract.required].sort());
      for (const [field, schema] of Object.entries(tool.inputSchema.properties)) {
        expect(schema.type).toBe(
          field === "confirmed" ? "boolean" : field === "limit" || field === "offset" ? "integer" : "string",
        );
      }
      expect(tool.guardrails.confirmation.required).toBe(contract.risk !== "read");
      expect(tool.guardrails.idempotencyKey).toBe(contract.risk === "read" ? "not-applicable" : "required");
      expect(tool.guardrails.idempotencyAuthority).toBe("platform");
      expect(tool.guardrails.dryRunSupported).toBe(false);
    }
  });

  it("MCP source-call contract coverage", async () => {
    const f = await fixture();
    assertSourceCallCoverage(sourceCalls, f.handlers);
    for (const call of sourceCalls) {
      const args =
        call.tool === "auth.revoke-session" || call.tool === "auth.switch-session-account"
          ? writeArgs(call.tool, call.args)
          : call.args;
      expect((await f.call(call.tool, args)).result.isError, call.tool).not.toBe(true);
      expect(findMcpTool(call.tool)?.permissionBoundary).toEqual({
        scope: "operator",
        accountScoped: false,
        requiredPermissions: ["security.manage"],
        requiredScopes: [],
        auditPrincipal: "actor",
      });
    }
    for (const call of sourceCalls) {
      expect(() =>
        assertSourceCallCoverage(
          sourceCalls.filter((candidate) => candidate !== call),
          f.handlers,
        ),
      ).toThrow();
      const missing = { ...f.handlers };
      delete missing[call.tool];
      expect(() => assertSourceCallCoverage(sourceCalls, missing)).toThrow();
    }
    expect(contextManifest.mcpCapabilities.tools.map((tool) => tool.name).sort()).toEqual(
      sourceCalls.map((call) => call.tool).sort(),
    );
    expect(Object.keys(f.handlers).sort()).toEqual(sourceCalls.map((call) => call.tool).sort());
    const writes = f.readAllEvents().slice(1);
    expect(writes.map((event) => event.eventType)).toEqual(["auth.session.account-switched", "auth.session.revoked"]);
    expect(
      writes.every((event) => event.performedByUserId === admin.userId && event.forAccountId === admin.accountId),
    ).toBe(true);
  });

  it("preserves list filters, default/clamped query bounds, total, and explicit pagination", async () => {
    const f = await fixture();
    expect((await f.call("auth.list-sessions", {})).result.structuredContent).toMatchObject({
      total: 1,
      count: 1,
      items: [row()],
    });
    expect(f.query.mock.calls.at(-1)?.[1]).toEqual([50, 0]);
    await f.call("auth.list-sessions", { search: "target", status: "revoked", limit: 999, offset: 99999 });
    expect(f.services.listSessions).toHaveBeenLastCalledWith({
      search: "target",
      status: "revoked",
      limit: 999,
      offset: 99999,
    });
    expect(f.query.mock.calls.at(-1)?.[1]).toEqual(["revoked", "%target%", 500, 10000]);
    await f.call("auth.list-sessions", { limit: -1, offset: -1 });
    expect(f.query.mock.calls.at(-1)?.[1]).toEqual([1, 0]);
    await f.call("auth.list-sessions", { search: " target ", status: " active ", limit: 0, offset: 0 });
    expect(f.services.listSessions).toHaveBeenLastCalledWith({
      search: " target ",
      status: " active ",
      limit: undefined,
      offset: undefined,
    });
    expect((await f.call("auth.get-session", { sessionId: "ses_target" })).result.structuredContent).toEqual(row());
  });

  it.each(["denied", "failed"])("awaits metadata-only %s audit before returning", async (outcome) => {
    const f = await fixture();
    let signalEntered!: () => void;
    let releaseAudit!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    f.audit.mockImplementationOnce(async () => {
      signalEntered();
      await released;
    });
    f.setAllowed(outcome !== "denied");
    let returned = false;
    const response = f
      .call(
        "auth.switch-session-account",
        writeArgs("auth.switch-session-account", { accountId: "acc_unavailable", idempotencyKey: "private-key" }),
      )
      .then((result) => {
        returned = true;
        return result;
      });
    await entered;
    try {
      expect(returned).toBe(false);
      expect(f.audit).toHaveBeenCalledWith(
        expect.objectContaining({ outcome, actorId: admin.userId, accountId: admin.accountId }),
      );
      const record = JSON.stringify(f.audit.mock.calls[0]?.[0]);
      for (const privateValue of ["private-key", "acc_unavailable", "ses_target", "target@example.test"]) {
        expect(record).not.toContain(privateValue);
      }
    } finally {
      releaseAudit();
    }
    expect((await response).result.isError).toBe(true);
    expect(f.readAllEvents()).toHaveLength(1);
  });

  it.each(sourceCalls)(
    "denies unauthorized actors and missing permissions before $tool effects",
    async ({ tool, args }) => {
      const f = await fixture();
      const input = tool.includes("revoke") || tool.includes("switch") ? writeArgs(tool, args) : args;
      f.setActor(null);
      expect((await f.post(tool, input)).status).toBe(401);
      const badActors: ResolvedActor[] = [
        { ...admin, agentGrant: { ...admin.agentGrant, scopes: ["account:manage"] } },
      ];
      for (const actor of badActors) {
        f.setActor(actor);
        expect((await f.call(tool, input)).result.isError).toBe(true);
      }
      f.setActor(admin);
      f.setAllowed(false);
      expect((await f.call(tool, input)).result.isError).toBe(true);
      f.setAllowed(true);
      f.setPermissions([]);
      expect((await f.call(tool, input)).result.isError).toBe(true);
      expect(f.services.getSession).not.toHaveBeenCalled();
      expect(f.services.listSessions).not.toHaveBeenCalled();
      expect(f.services.commandHandler).not.toHaveBeenCalled();
      expect(f.audit).toHaveBeenCalled();
    },
  );

  it.each(sourceCalls)("rejects invalid and extra inputs for $tool before effects", async ({ tool, args }) => {
    const f = await fixture();
    const input = tool.includes("revoke") || tool.includes("switch") ? writeArgs(tool, args) : args;
    const badInputs: Record<string, unknown>[] = [
      { ...input, userId: "usr_forged" },
      { ...input, sessionId: 5 },
    ];
    if (tool === "auth.list-sessions") badInputs.push({ limit: 1.5 }, { limit: "10" });
    for (const bad of badInputs) expect((await f.call(tool, bad)).result.isError).toBe(true);
    expect(f.services.getSession).not.toHaveBeenCalled();
    expect(f.services.listSessions).not.toHaveBeenCalled();
    expect(f.services.commandHandler).not.toHaveBeenCalled();
  });

  it.each(["auth.revoke-session", "auth.switch-session-account"])(
    "requires exact title confirmation and platform idempotency for %s",
    async (tool) => {
      const f = await fixture();
      const args = writeArgs(tool, tool.includes("switch") ? { accountId: "acc_other" } : {});
      const badInputs = [
        { ...args, confirmed: false },
        { ...args, confirmationText: "wrong" },
        { ...args, idempotencyKey: "" },
        ...["confirmed", "confirmationText", "idempotencyKey"].map((omitted) =>
          Object.fromEntries(Object.entries(args).filter(([key]) => key !== omitted)),
        ),
        { ...args, dryRun: true },
      ];
      for (const bad of badInputs) expect((await f.call(tool, bad)).result.isError).toBe(true);
      expect(f.services.commandHandler).not.toHaveBeenCalled();
      const first = await f.call(tool, args);
      expect(first.result.isError).not.toBe(true);
      expect(await f.call(tool, args)).toEqual(first);
      expect(f.services.commandHandler).toHaveBeenCalledTimes(1);
      expect((await f.call(tool, { ...args, sessionId: "ses_other" })).result.isError).toBe(true);
      f.setActor({ ...admin, userId: "usr_other", agentGrant: { ...admin.agentGrant, scopes: ["account:manage"] } });
      expect((await f.call(tool, args)).result.isError).toBe(true);
      f.setActor(admin);
      f.setAllowed(false);
      expect((await f.call(tool, args)).result.isError).toBe(true);
      expect(f.services.commandHandler).toHaveBeenCalledTimes(1);
      expect(f.readAllEvents()).toHaveLength(2);
    },
  );

  it("preserves domain failures for unavailable/current account, inactive session and absent target", async () => {
    const f = await fixture();
    for (const accountId of ["acc_unavailable", "acc_target"]) {
      const result = await f.call(
        "auth.switch-session-account",
        writeArgs("auth.switch-session-account", { accountId, idempotencyKey: accountId }),
      );
      expect(result.result.isError).toBe(true);
      expect(result.result.content[0]?.text).toContain(
        accountId === "acc_target" ? "already active" : "unavailable account",
      );
    }
    expect(f.readAllEvents()).toHaveLength(1);
    expect(
      (
        await f.call(
          "auth.revoke-session",
          writeArgs("auth.revoke-session", { sessionId: "missing", idempotencyKey: "missing-target" }),
        )
      ).result.isError,
    ).toBe(true);
    await f.call("auth.revoke-session", writeArgs("auth.revoke-session"));
    const inactive = await f.call(
      "auth.switch-session-account",
      writeArgs("auth.switch-session-account", { accountId: "acc_other" }),
    );
    expect(inactive.result.content[0]?.text).toContain("Only active sessions can change");
    expect(f.readAllEvents()).toHaveLength(2);
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  });

  it("retains source same-user/same-session branches without widening operator admission", async () => {
    const f = await fixture();
    const owner = { ...admin, roleKey: "owner", userId: "usr_other" };
    const request = (actor: ResolvedActor, args: Record<string, unknown>) => ({
      actor,
      arguments: args,
      tool: findMcpTool("auth.get-session")!,
      request: new Request("https://api.test/mcp"),
      protocol: null as never,
    });
    await expect(f.handlers["auth.get-session"]!(request(owner, { sessionId: "ses_target" }))).rejects.toThrow(
      "cannot manage",
    );
    for (const actor of [
      { ...owner, userId: "usr_target" },
      { ...owner, sessionId: "ses_target" },
    ]) {
      await expect(f.handlers["auth.get-session"]!(request(actor, { sessionId: "ses_target" }))).resolves.toEqual(
        row(),
      );
    }
    await f.handlers["auth.list-sessions"]!(request(owner, { search: "forged" }));
    expect(f.services.listSessions).toHaveBeenLastCalledWith({
      search: owner.userId,
      status: undefined,
      limit: undefined,
      offset: undefined,
    });
    expect(f.services.commandHandler).not.toHaveBeenCalled();
  });
});
