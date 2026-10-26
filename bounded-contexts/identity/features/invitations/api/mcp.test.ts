import { readFileSync } from "node:fs";
import { createActorEventStoreContext, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { createMcpRoutes, type McpRuntimeEnv } from "@chase-sets/platform-runtime/mcp";
import { findMcpTool, mcpServiceCatalog } from "@chase-sets/platform-runtime/mcp-contracts";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { contextManifest } from "@chase-sets/identity";
import type { InvitationServices } from "./runtime";
import { createInvitationMcpHandlers } from "./mcp";
import { createAccountMcpHandlers } from "../../accounts/api/mcp";

const requestInvitationAcceptanceLink = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../integrations/request-invitation-acceptance-link", () => ({ requestInvitationAcceptanceLink }));

const sourceCalls = [
  { route: "invitations", method: "listInvitations", tool: "identity.list-invitations" },
  { route: "invitations", method: "listAccounts", tool: "identity.list-accounts" },
  { route: "invitations", method: "createInvitation", tool: "identity.create-and-send-invitation" },
  { route: "invitations", method: "requestInvitationAcceptanceLink", tool: "identity.create-and-send-invitation" },
  { route: "invitations-detail", method: "getInvitation", tool: "identity.get-invitation" },
  { route: "invitations-detail", method: "resendInvitation", tool: "identity.resend-and-send-invitation" },
  {
    route: "invitations-detail",
    method: "requestInvitationAcceptanceLink",
    tool: "identity.resend-and-send-invitation",
  },
  { route: "invitations-detail", method: "cancelInvitation", tool: "identity.cancel-invitation" },
  { route: "invitations-detail", method: "declineInvitation", tool: "identity.decline-invitation" },
] as const;

function assertSourceCallCoverage(handlers: Readonly<Record<string, unknown>>) {
  for (const route of ["invitations", "invitations-detail"] as const) {
    const source = readFileSync(new URL(`../../../routes/admin/${route}.tsx`, import.meta.url), "utf8");
    const traced = [
      ...new Set([
        ...[...source.matchAll(/\bapi\.(\w+)/g)].map((match) => match[1]),
        ...[...source.matchAll(/\bcreateIdentityRequestApiClient\([\s\S]*?\)\s*\.\s*(\w+)/g)].map((match) => match[1]),
        ...[...source.matchAll(/\brequestInvitationAcceptanceLink\s*\(/g)].map(() => "requestInvitationAcceptanceLink"),
      ]),
    ];
    const mapped = sourceCalls.filter((call) => call.route === route);
    expect(mapped.map((call) => call.method).sort()).toEqual(traced.sort());
    expect([...new Set(contextManifest.agentCoverage[route].tools)].sort()).toEqual(
      [...new Set(mapped.map((call) => call.tool))].sort(),
    );
    for (const call of mapped) {
      expect(handlers[call.tool], call.tool).toBeTypeOf("function");
      expect(findMcpTool(call.tool)?.availability, call.tool).toBe("available");
    }
  }
}

const actor = {
  sessionId: "sess_1",
  tenantId: "tnt_1",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["memberships.manage"],
} satisfies ResolvedActor;

const invitation = {
  invitation_id: "ivt_1",
  account_id: "acc_1",
  account_display_name: "Seller",
  account_name: "seller",
  email: "invitee@example.test",
  role_key: "viewer",
  status: "pending",
  expires_at: "2026-11-01T00:00:00.000Z",
  accepted_by_user_id: null,
  accepted_by_user_display_name: null,
  accepted_by_user_primary_email: null,
  updated_at: "2026-10-01T00:00:00.000Z",
} as const;

function request(arguments_: Record<string, unknown>, requestActor: ResolvedActor | null = actor) {
  return {
    actor: requestActor,
    tool: null as never,
    arguments: arguments_,
    request: new Request("https://api.test/mcp"),
    protocol: null as never,
  };
}

function services() {
  const commandHandler = vi.fn(async (_input: unknown) => ({ version: 1, state: { status: "pending" } }));
  const getInvitationForRead = vi.fn(async () => invitation);
  return {
    services: { commandHandler, getInvitationForRead } as unknown as InvitationServices,
    accounts: {
      getAccountForRead: vi.fn(async () => ({ account_id: "acc_1" })),
      listAccounts: vi.fn(async () => ({ items: [], total: 0 })),
    },
    commandHandler,
    getInvitationForRead,
  };
}

beforeEach(() => {
  requestInvitationAcceptanceLink.mockReset();
});

describe("identity invitation MCP handlers", () => {
  it("publishes the exact team schemas and makes every mapped call executable", () => {
    const contracts = [
      [
        "identity.create-invitation",
        ["accountId", "email", "roleKey", "idempotencyKey", "confirmed", "confirmationText"],
      ],
      ["identity.resend-invitation", ["invitationId", "expiresAt", "idempotencyKey", "confirmed", "confirmationText"]],
      ["identity.cancel-invitation", ["invitationId", "idempotencyKey", "confirmed", "confirmationText"]],
      ["identity.decline-invitation", ["invitationId", "idempotencyKey", "confirmed", "confirmationText"]],
    ] as const;
    for (const [name, fields] of contracts) {
      const tool = findMcpTool(name)!;
      expect(tool.availability, name).toBe("available");
      expect(tool.permissionBoundary).toMatchObject({
        scope: "operator",
        accountScoped: false,
        requiredPermissions: ["memberships.manage"],
        requiredScopes: [],
      });
      expect(Object.keys(tool.inputSchema.properties)).toEqual(fields);
      expect(tool.inputSchema.required).toEqual(fields);
    }
  });

  it("commits before requesting delivery and names the saved invitation on delivery failure", async () => {
    const f = services();
    const handlers = createInvitationMcpHandlers(f.services, f.accounts as never).toolHandlers;
    const events: string[] = [];
    f.commandHandler.mockImplementationOnce(async () => {
      events.push("commit");
      return { version: 1, state: { status: "pending" } };
    });
    requestInvitationAcceptanceLink.mockImplementationOnce(async () => {
      events.push("delivery");
      throw new Error("The invitation was saved, but its acceptance email could not be sent.");
    });
    await expect(
      handlers["identity.create-and-send-invitation"]!(
        request({ accountId: "acc_1", email: "invitee@example.test", roleKey: "viewer" }),
      ),
    ).rejects.toThrow("invitation was saved");
    expect(events).toEqual(["commit", "delivery"]);
    expect(requestInvitationAcceptanceLink).toHaveBeenCalledWith(
      expect.any(Request),
      expect.stringMatching(/^ivt_/),
      expect.anything(),
    );
  });

  it("MCP source-call contract coverage: invitations map reads and send contracts", async () => {
    const f = services();
    const listInvitations = vi.fn(async () => ({ items: [invitation], total: 1 }));
    const handlers = createInvitationMcpHandlers(
      { ...f.services, listInvitations } as never,
      f.accounts as never,
    ).toolHandlers;
    assertSourceCallCoverage({
      ...handlers,
      ...createAccountMcpHandlers(f.accounts as never).toolHandlers,
    });
    await expect(
      handlers["identity.list-invitations"]!(request({ status: "pending", limit: 10, offset: 2 })),
    ).resolves.toEqual({
      items: [invitation],
      total: 1,
      count: 1,
    });
    expect(listInvitations).toHaveBeenCalledWith({ search: "acc_1", status: "pending", limit: 10, offset: 2 });
    await expect(handlers["identity.get-invitation"]!(request({ invitationId: "ivt_1" }))).resolves.toEqual(invitation);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T12:00:00.000Z"));
    try {
      const createEvents: string[] = [];
      f.commandHandler.mockImplementationOnce(async (_input: unknown) => {
        createEvents.push("commit");
        return { version: 1, state: { status: "pending" } };
      });
      requestInvitationAcceptanceLink.mockImplementationOnce(async () => {
        createEvents.push("delivery");
      });
      await handlers["identity.create-and-send-invitation"]!(
        request({ accountId: "acc_1", email: "invitee@example.test", roleKey: "viewer" }),
      );
      const createCall = f.commandHandler.mock.calls.at(-1)?.[0] as {
        command: Record<string, unknown>;
        context: unknown;
      };
      expect(createCall.command).toMatchObject({
        type: "CreateInvitation",
        expiresAt: "2026-10-31T12:00:00.000Z",
      });
      expect(createCall.command).not.toHaveProperty("idempotencyKey");
      expect(createCall.context).toEqual(createActorEventStoreContext(actor));
      expect(createEvents).toEqual(["commit", "delivery"]);
      expect(requestInvitationAcceptanceLink).toHaveBeenCalledTimes(1);

      requestInvitationAcceptanceLink.mockReset();
      requestInvitationAcceptanceLink.mockImplementationOnce(async () => {
        throw new Error("The invitation was saved, but its acceptance email could not be sent.");
      });
      const resendExpiry = "2026-11-08T12:00:00.000Z";
      await expect(
        handlers["identity.resend-and-send-invitation"]!(request({ invitationId: "ivt_1", expiresAt: resendExpiry })),
      ).rejects.toThrow("invitation was saved");
      const resendCall = f.commandHandler.mock.calls.at(-1)?.[0] as {
        command: Record<string, unknown>;
        context: unknown;
      };
      expect(resendCall.command).toEqual({ type: "ResendInvitation", expiresAt: resendExpiry });
      expect(resendCall.command).not.toHaveProperty("idempotencyKey");
      expect(resendCall.context).toEqual(createActorEventStoreContext(actor));
      expect(requestInvitationAcceptanceLink).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("MCP source-call contract coverage: send replays do not deliver again", async () => {
    const f = services();
    const app = new Hono<McpRuntimeEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    app.route(
      "/",
      createMcpRoutes({
        services: mcpServiceCatalog.filter((service) => service.serviceId === "identity"),
        toolHandlers: createInvitationMcpHandlers(f.services, f.accounts as never).toolHandlers,
        operatorAuthority: async () => ({
          kind: "granted" as const,
          membershipId: actor.membershipId,
          roleKey: "platform-admin" as const,
          rolePermissions: ["memberships.manage"] as const,
        }),
        audit: async () => undefined,
        allowInMemoryIdempotencyStoreForTests: true,
      }),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "request_1",
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    };
    const args = {
      accountId: "acc_1",
      email: "invitee@example.test",
      roleKey: "viewer",
      idempotencyKey: "idem-create-and-send",
      confirmed: true,
      confirmationText: `${findMcpTool("identity.create-and-send-invitation")!.title}.`,
    };
    const first = await call("identity.create-and-send-invitation", args);
    const replay = await call("identity.create-and-send-invitation", args);
    expect(first.result.isError).not.toBe(true);
    expect(replay).toEqual(first);
    expect(f.commandHandler).toHaveBeenCalledTimes(1);
    expect(requestInvitationAcceptanceLink).toHaveBeenCalledTimes(1);

    const resendArgs = {
      invitationId: "ivt_1",
      expiresAt: "2026-11-08T12:00:00.000Z",
      idempotencyKey: "idem-resend-and-send",
      confirmed: true,
      confirmationText: `${findMcpTool("identity.resend-and-send-invitation")!.title}.`,
    };
    const resendFirst = await call("identity.resend-and-send-invitation", resendArgs);
    const resendReplay = await call("identity.resend-and-send-invitation", resendArgs);
    expect(resendFirst.result.isError).not.toBe(true);
    expect(resendReplay).toEqual(resendFirst);
    expect(f.commandHandler).toHaveBeenCalledTimes(2);
    expect(requestInvitationAcceptanceLink).toHaveBeenCalledTimes(2);
  });

  it("creates with the source seven-day expiry and never invokes delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T12:00:00.000Z"));
    try {
      const f = services();
      const handlers = createInvitationMcpHandlers(f.services, f.accounts as never).toolHandlers;
      const result = await handlers["identity.create-invitation"]!(
        request({ accountId: "acc_1", email: "Invitee@Example.test", roleKey: "viewer" }),
      );
      expect(result).toMatchObject({ status: "pending", version: 1 });
      expect(f.commandHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          command: expect.objectContaining({
            type: "CreateInvitation",
            email: "Invitee@Example.test",
            expiresAt: "2026-10-31T12:00:00.000Z",
          }),
        }),
      );
      expect(f.commandHandler).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves target authorization and pending-state guards before effects", async () => {
    const f = services();
    const handlers = createInvitationMcpHandlers(f.services, f.accounts as never).toolHandlers;
    await expect(
      handlers["identity.create-invitation"]!(
        request({ accountId: "acc_other", email: "a@b.test", roleKey: "viewer" }),
      ),
    ).rejects.toThrow("cannot manage");
    expect(f.commandHandler).not.toHaveBeenCalled();
    await expect(
      handlers["identity.get-invitation"]!(request({ invitationId: "ivt_1" }, { ...actor, accountId: "acc_other" })),
    ).rejects.toThrow("cannot manage");
    expect(f.commandHandler).not.toHaveBeenCalled();
    const nonPending = { ...invitation, status: "cancelled" as "pending" };
    f.getInvitationForRead.mockResolvedValueOnce(nonPending);
    await expect(
      handlers["identity.resend-invitation"]!(request({ invitationId: "ivt_1", expiresAt: "2026-11-01T00:00:00Z" })),
    ).rejects.toThrow("Only pending");
    expect(f.commandHandler).not.toHaveBeenCalled();
  });

  it.each([
    ["identity.cancel-invitation", "CancelInvitation"],
    ["identity.decline-invitation", "DeclineInvitation"],
  ] as const)("dispatches %s with the exact command and actor context", async (toolName, commandType) => {
    const f = services();
    const handlers = createInvitationMcpHandlers(f.services, f.accounts as never).toolHandlers;

    await expect(handlers[toolName]!(request({ invitationId: "ivt_1" }))).resolves.toMatchObject({
      id: "ivt_1",
      version: 1,
      status: "pending",
    });
    expect(f.commandHandler).toHaveBeenCalledWith({
      streamId: "identity.invitation-ivt_1",
      command: { type: commandType },
      context: createActorEventStoreContext(actor),
    });
  });

  it.each(["identity.cancel-invitation", "identity.decline-invitation"] as const)(
    "%s rejects wrong-account and non-pending invitations before dispatch",
    async (toolName) => {
      const f = services();
      const handlers = createInvitationMcpHandlers(f.services, f.accounts as never).toolHandlers;

      await expect(
        handlers[toolName]!(request({ invitationId: "ivt_1" }, { ...actor, accountId: "acc_other" })),
      ).rejects.toThrow("cannot manage");
      expect(f.commandHandler).not.toHaveBeenCalled();

      f.getInvitationForRead.mockResolvedValue({ ...invitation, status: "cancelled" as "pending" });
      await expect(handlers[toolName]!(request({ invitationId: "ivt_1" }))).rejects.toThrow("Only pending");
      expect(f.commandHandler).not.toHaveBeenCalled();
    },
  );
});
