import { createActorEventStoreContext, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import { describe, expect, it, vi } from "vitest";
import { findMcpTool } from "@chase-sets/platform-runtime/mcp-contracts";
import type { InvitationServices } from "./runtime";
import { createInvitationMcpHandlers } from "./mcp";

const requestInvitationAcceptanceLink = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../integrations/request-invitation-acceptance-link", () => ({ requestInvitationAcceptanceLink }));

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
  const commandHandler = vi.fn(async () => ({ version: 1, state: { status: "pending" } }));
  const getInvitationForRead = vi.fn(async () => invitation);
  return {
    services: { commandHandler, getInvitationForRead } as unknown as InvitationServices,
    accounts: { getAccountForRead: vi.fn(async () => ({ account_id: "acc_1" })) },
    commandHandler,
    getInvitationForRead,
  };
}

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
    expect(requestInvitationAcceptanceLink).toHaveBeenCalledWith(expect.any(Request), expect.stringMatching(/^ivt_/), expect.anything());
  });

  it("MCP source-call contract coverage: invitations map reads and delivery", async () => {
    const f = services();
    const listInvitations = vi.fn(async () => ({ items: [invitation], total: 1 }));
    const handlers = createInvitationMcpHandlers({ ...f.services, listInvitations } as never, f.accounts as never).toolHandlers;
    await expect(handlers["identity.list-invitations"]!(request({ status: "pending", limit: 10, offset: 2 }))).resolves.toEqual({
      items: [invitation],
      total: 1,
      count: 1,
    });
    expect(listInvitations).toHaveBeenCalledWith({ search: "acc_1", status: "pending", limit: 10, offset: 2 });
    await expect(handlers["identity.get-invitation"]!(request({ invitationId: "ivt_1" }))).resolves.toEqual(invitation);
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
