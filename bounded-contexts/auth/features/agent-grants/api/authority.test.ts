import { describe, expect, it, vi } from "vitest";
import type { AgentGrantRevocations } from "@chase-sets/identity/server";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { fenceAgentGrantActor, fenceAgentGrantSpendPolicy } from "./authority";

describe("agent-grant-revocation-downstream-fence", () => {
  it("denies a spend result when the Grant becomes terminal during policy lookup", async () => {
    let active = true;
    const owner = { isActiveGrant: async () => active } as unknown as AgentGrantRevocations;
    const authorize = async () => {
      active = false;
      return { allowed: true as const };
    };
    expect(
      await fenceAgentGrantSpendPolicy({ authorize }, owner).authorize({
        grantId: "grant_a",
        accountId: "acc_a",
        operation: "checkout",
        operationId: "operation_a",
        amountCents: 1,
      }),
    ).toMatchObject({ allowed: false, reason: "agent_grant_revoked" });
  });
  it("denies a stale MCP/UCP actor and replayed spend policy after terminal owner authority", async () => {
    const actor = { accountId: "acc_a", agentGrant: { grantId: "grant_a" } } as ResolvedActor;
    const owner = { isActiveGrant: vi.fn(async () => false) } as unknown as AgentGrantRevocations;
    expect(await fenceAgentGrantActor(async () => actor, owner)(new Request("http://synthetic/mcp"))).toBeNull();
    const authorize = vi.fn(async () => ({ allowed: true as const }));
    expect(
      await fenceAgentGrantSpendPolicy({ authorize }, owner).authorize({
        grantId: "grant_a",
        accountId: "acc_a",
        operation: "checkout",
        operationId: "existing_operation",
        amountCents: 1,
      }),
    ).toMatchObject({ allowed: false, reason: "agent_grant_revoked" });
    expect(authorize).not.toHaveBeenCalled();
    expect(owner.isActiveGrant).toHaveBeenCalledWith("acc_a", "grant_a");
  });
});
